import {
  AuthorizationSubject,
  CreateEngagementInput,
  currentPolicyProfile,
  defaultScopeManifest,
  LifecycleInput,
  normalizeTargetUrl,
  parseIp,
  RequestAuthorizationInput,
  ScopeManifest,
  SECURITY_POLICY_PROFILES,
  siteKeyFor,
  UpdateEngagementInput,
  UpdateScopeInput,
  ValidateScopeInput,
  type SecurityActor,
  type SecurityAuthorizationItem,
  type SecurityEngagementDetail,
  type SecurityEngagementSummary,
  type ScopeEvaluation,
  type ScopeValidationResult,
  type SecurityEventItem,
  type SecurityEventType,
  type SecurityEvidenceItem,
} from '@audivra/contracts'
import {
  createEngagementRecord,
  getEngagementRow,
  insertAuthorization,
  listAuthorizationRows,
  listEngagementRows,
  listSecurityEvents,
  listSecurityEvidence,
  recordSecurityEvent,
  revokeAuthorization,
  siteAuditStats,
  updateEngagementRecord,
  type Db,
  type EngagementPatch,
  type EngagementRow,
} from '@audivra/database'
import type { z } from 'zod'
import { AUTHORIZATION_PROVIDERS, authorizationMethods, toAuthorizationItem } from './authorization.ts'
import { systemResolver, type Resolver } from './dns.ts'
import { effectivePolicy } from './policy.ts'
import { applyLifecycleAction, derivedStatus, evaluateReadiness } from './readiness.ts'
import { evaluateNetworkDestination, evaluateUrl, manifestHash } from './scope.ts'

/*
 * Engagement management for the API. Every configuration change is made by a person (or by Audivra
 * itself) — agents are refused here — bumps the configuration version, is recorded in the append-only
 * security events, and is followed by a recomputation of readiness.
 */

export class SecurityRequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'SecurityRequestError'
  }
}

/** The single local user of this desktop tool (Audivra has no accounts yet). */
export const LOCAL_USER: SecurityActor = { kind: 'user', id: 'local-user', agentRunId: null }
const SYSTEM: SecurityActor = { kind: 'system', id: null, agentRunId: null }

const CLOSED = new Set(['completed', 'cancelled'])

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SecurityRequestError(400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '))
  }
  return parsed.data
}

/** Configuration belongs to people and to Audivra: model output can never change it. */
export function assertConfigurationActor(actor: SecurityActor): void {
  if (actor.kind !== 'user' && actor.kind !== 'system') {
    throw new SecurityRequestError(403, 'Agents cannot change engagement configuration, authorization, scope, environment or policy')
  }
}

export interface SecurityServiceOptions {
  db: Db
  resolver?: Resolver
  now?: () => Date
}

export class SecurityService {
  readonly #db: Db
  readonly #resolver: Resolver
  readonly #now: () => Date

  constructor(options: SecurityServiceOptions) {
    this.#db = options.db
    this.#resolver = options.resolver ?? systemResolver
    this.#now = options.now ?? (() => new Date())
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────────

  async listEngagements(): Promise<SecurityEngagementSummary[]> {
    const rows = await listEngagementRows(this.#db)
    const authorizations = await listAuthorizationRows(this.#db, rows.map((r) => r.id))
    const now = this.#now()
    return rows.map((row) => this.#summary(row, authorizations.filter((a) => a.engagementId === row.id).map((a) => toAuthorizationItem(a, now))))
  }

  async getEngagement(id: string): Promise<SecurityEngagementDetail> {
    const row = await this.#row(id)
    const now = this.#now()
    const authorizations = (await listAuthorizationRows(this.#db, [id])).map((a) => toAuthorizationItem(a, now))
    const summary = this.#summary(row, authorizations)
    const policy = effectivePolicy(row)
    return {
      ...summary,
      description: row.description,
      createdBy: row.createdBy,
      scope: row.scope,
      scopeVersion: row.scopeVersion,
      scopeHash: row.scopeHash,
      authorizations: [...authorizations].reverse(),
      authorizationMethods: authorizationMethods(),
      readiness: evaluateReadiness({ status: row.status, environment: row.environment, scope: row.scope, policy, authorizations, now }),
      policy,
      siteAudits: await siteAuditStats(this.#db, row.siteKey),
    }
  }

  async listEvents(id: string, options: { afterId?: number; executionId?: string } = {}): Promise<SecurityEventItem[]> {
    await this.#row(id)
    return listSecurityEvents(this.#db, id, options)
  }

  async listEvidence(id: string): Promise<SecurityEvidenceItem[]> {
    await this.#row(id)
    return listSecurityEvidence(this.#db, id)
  }

  policyProfiles() {
    return SECURITY_POLICY_PROFILES.filter((p) => !p.retired)
  }

  // ── Configuration (people and Audivra only) ───────────────────────────────────────────────────────

  async createEngagement(input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityEngagementDetail> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(CreateEngagementInput, input)
    const target = normalizeTargetUrl(data.targetUrl)
    if (!target.ok) throw new SecurityRequestError(400, target.error)
    const scope = defaultScopeManifest(target.url)
    const profile = currentPolicyProfile(data.policyProfile)
    const row = await createEngagementRecord(this.#db, {
      name: data.name,
      description: data.description?.trim() || null,
      targetUrl: target.url,
      siteKey: siteKeyFor(target.url),
      environment: data.environment ?? null,
      status: 'draft',
      policyProfileKey: profile.key,
      policyProfileVersion: profile.version,
      scope,
      scopeHash: manifestHash(scope),
      createdBy: actor.id ?? actor.kind,
    })
    await this.#event(row, actor, 'engagement.created', `Engagement created for ${target.url}`, {
      targetUrl: target.url,
      environment: row.environment,
      policyProfile: `${profile.key}@${profile.version}`,
      scopeVersion: row.scopeVersion,
      scopeHash: row.scopeHash,
      scope,
    })
    await this.#refreshStatus(row.id)
    return this.getEngagement(row.id)
  }

  async updateEngagement(id: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityEngagementDetail> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(UpdateEngagementInput, input)
    const row = await this.#openRow(id)
    const patch: EngagementPatch = {}
    const events: [SecurityEventType, string, Record<string, unknown>][] = []
    if (data.name !== undefined && data.name !== row.name) {
      patch.name = data.name
      events.push(['engagement.updated', `Renamed to "${data.name}"`, { field: 'name' }])
    }
    if (data.description !== undefined && (data.description || null) !== row.description) {
      patch.description = data.description || null
      events.push(['engagement.updated', 'Description updated', { field: 'description' }])
    }
    if (data.environment !== undefined && data.environment !== row.environment) {
      patch.environment = data.environment
      patch.bumpConfigVersion = true
      events.push(['environment.changed', `Environment: ${row.environment ?? 'not set'} → ${data.environment}`, { from: row.environment, to: data.environment }])
    }
    if (data.policyProfile !== undefined && data.policyProfile !== row.policyProfileKey) {
      const profile = currentPolicyProfile(data.policyProfile)
      patch.policyProfileKey = profile.key
      patch.policyProfileVersion = profile.version
      patch.bumpConfigVersion = true
      events.push(['policy.changed', `Policy profile: ${row.policyProfileKey}@${row.policyProfileVersion} → ${profile.key}@${profile.version}`, {
        from: `${row.policyProfileKey}@${row.policyProfileVersion}`,
        to: `${profile.key}@${profile.version}`,
      }])
    }
    if (events.length === 0) return this.getEngagement(id)
    const updated = await updateEngagementRecord(this.#db, id, patch)
    if (!updated) throw new SecurityRequestError(404, 'Engagement not found')
    for (const [type, message, data_] of events) await this.#event(updated, actor, type, message, data_)
    await this.#refreshStatus(id)
    return this.getEngagement(id)
  }

  async updateScope(id: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityEngagementDetail> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(UpdateScopeInput, input)
    const manifest = parseOrThrow(ScopeManifest, data.manifest)
    const row = await this.#openRow(id)
    if (data.expectedScopeVersion !== undefined && data.expectedScopeVersion !== row.scopeVersion) {
      throw new SecurityRequestError(409, `The scope changed meanwhile (now version ${row.scopeVersion}); reload and apply your changes again`)
    }
    const hash = manifestHash(manifest)
    if (hash === row.scopeHash) return this.getEngagement(id)
    const updated = await updateEngagementRecord(
      this.#db,
      id,
      { scope: manifest, scopeHash: hash, bumpScopeVersion: true, bumpConfigVersion: true },
      { scopeVersion: row.scopeVersion },
    )
    if (!updated) throw new SecurityRequestError(409, 'The scope changed meanwhile; reload and apply your changes again')
    await this.#event(updated, actor, 'scope.changed', `Scope updated to version ${updated.scopeVersion}`, {
      scopeVersion: updated.scopeVersion,
      scopeHash: hash,
      previousHash: row.scopeHash,
      scope: manifest,
    })
    await this.#refreshStatus(id)
    return this.getEngagement(id)
  }

  async requestAuthorization(id: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<{ authorization: SecurityAuthorizationItem; engagement: SecurityEngagementDetail }> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(RequestAuthorizationInput, input)
    const row = await this.#openRow(id)
    const provider = AUTHORIZATION_PROVIDERS[data.method]
    if (provider.unavailableReason || !provider.verify) throw new SecurityRequestError(422, `${provider.label}: ${provider.unavailableReason ?? 'not available'}`)
    const subject = data.subject === undefined ? defaultSubject(row.targetUrl) : parseOrThrow(AuthorizationSubject, data.subject)
    await this.#event(row, actor, 'authorization.requested', `${provider.label} requested for ${subjectLabel(subject)}`, { method: data.method, subject })
    const now = this.#now()
    const outcome = await provider.verify(subject, { resolver: this.#resolver, now })
    const authRow = await insertAuthorization(this.#db, {
      engagementId: id,
      method: data.method,
      status: outcome.status,
      subject,
      reason: outcome.reason,
      metadata: outcome.metadata,
      verifiedAt: outcome.status === 'verified' ? now : null,
      expiresAt: outcome.expiresAt,
      createdBy: actor.id ?? actor.kind,
    })
    const updated = (await updateEngagementRecord(this.#db, id, { bumpConfigVersion: true })) ?? row
    await this.#event(updated, actor, 'authorization.changed', `${provider.label} ${outcome.status} for ${subjectLabel(subject)}: ${outcome.reason}`, {
      authorizationId: authRow.id,
      method: data.method,
      status: outcome.status,
      subject,
      expiresAt: outcome.expiresAt?.toISOString() ?? null,
    }, outcome.status === 'verified' ? 'info' : 'warn')
    await this.#refreshStatus(id)
    return { authorization: toAuthorizationItem(authRow, this.#now()), engagement: await this.getEngagement(id) }
  }

  async revokeAuthorization(id: string, authorizationId: string, actor: SecurityActor = LOCAL_USER): Promise<SecurityEngagementDetail> {
    assertConfigurationActor(actor)
    await this.#row(id)
    const revoked = await revokeAuthorization(this.#db, id, authorizationId, 'Revoked by user')
    if (!revoked) throw new SecurityRequestError(404, 'Authorization not found')
    const updated = (await updateEngagementRecord(this.#db, id, { bumpConfigVersion: true }))!
    await this.#event(updated, actor, 'authorization.changed', `Authorization for ${subjectLabel(revoked.subject)} revoked`, { authorizationId, status: 'revoked' }, 'warn')
    await this.#refreshStatus(id)
    return this.getEngagement(id)
  }

  async applyLifecycle(id: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityEngagementDetail> {
    assertConfigurationActor(actor)
    const { action } = parseOrThrow(LifecycleInput, input)
    const detail = await this.getEngagement(id)
    const result = applyLifecycleAction(detail.status, action, detail.readiness)
    if (!result.ok) throw new SecurityRequestError(409, result.reason)
    const updated = await updateEngagementRecord(this.#db, id, { status: result.status, bumpConfigVersion: true })
    if (!updated) throw new SecurityRequestError(404, 'Engagement not found')
    await this.#event(updated, actor, 'lifecycle.changed', `Engagement ${action}: ${detail.status} → ${result.status}`, { action, from: detail.status, to: result.status })
    return this.getEngagement(id)
  }

  /** Evaluates a URL against the stored (or a draft) scope, by name and by resolved addresses. Records nothing. */
  async validateScope(id: string, input: unknown): Promise<ScopeValidationResult> {
    const data = parseOrThrow(ValidateScopeInput, input)
    const row = await this.#row(id)
    const manifest = data.manifest === undefined ? row.scope : parseOrThrow(ScopeManifest, data.manifest)
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(data.url) ? data.url : `${manifest.protocols[0] ?? 'https'}://${data.url}`
    const evaluation = evaluateUrl(manifest, url)
    let network: ScopeEvaluation | null = null
    if (evaluation.decision === 'allow' && data.resolveDns && evaluation.destination.host) {
      const { host, port } = evaluation.destination
      const literal = parseIp(host)
      try {
        const addresses = literal ? [literal.text] : await this.#resolver(host)
        network = evaluateNetworkDestination(manifest, { host, port: port!, addresses, classification: evaluation.classification, url: evaluation.destination.url })
      } catch (error) {
        network = { ...evaluation, kind: 'network', decision: 'deny', rule: 'dns.lookup-failed', reason: `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`, limitations: [] }
      }
    }
    return { evaluation, network }
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  async #row(id: string): Promise<EngagementRow> {
    const row = /^[0-9a-z]{6,32}$/.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }

  async #openRow(id: string): Promise<EngagementRow> {
    const row = await this.#row(id)
    if (CLOSED.has(row.status)) throw new SecurityRequestError(409, `The engagement is ${row.status} and can no longer be changed`)
    return row
  }

  #summary(row: EngagementRow, authorizations: SecurityAuthorizationItem[]): SecurityEngagementSummary {
    const policy = effectivePolicy(row)
    const readiness = evaluateReadiness({ status: row.status, environment: row.environment, scope: row.scope, policy, authorizations, now: this.#now() })
    return {
      id: row.id,
      name: row.name,
      targetUrl: row.targetUrl,
      siteKey: row.siteKey,
      environment: row.environment,
      status: row.status,
      policyProfile: { key: row.policyProfileKey, version: row.policyProfileVersion, name: policy.profile.name },
      readiness: { ready: readiness.ready, state: readiness.state, label: readiness.label },
      configVersion: row.configVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  /** Recomputes the setup status (draft / authorization-pending / ready) from requirements. */
  async #refreshStatus(id: string): Promise<void> {
    const detail = await this.getEngagement(id)
    const next = derivedStatus(detail.status, detail.readiness)
    if (next === detail.status) return
    const updated = await updateEngagementRecord(this.#db, id, { status: next })
    if (updated) {
      await this.#event(updated, SYSTEM, 'lifecycle.changed', `Status: ${detail.status} → ${next} (${detail.readiness.label.toLowerCase()})`, {
        from: detail.status,
        to: next,
        readiness: detail.readiness.state,
        derived: true,
      })
    }
  }

  async #event(row: EngagementRow, actor: SecurityActor, type: SecurityEventType, message: string, data: Record<string, unknown>, level: 'info' | 'warn' = 'info') {
    await recordSecurityEvent(this.#db, { engagementId: row.id, type, message, actor, configVersion: row.configVersion, data, level })
  }
}

function defaultSubject(targetUrl: string): AuthorizationSubject {
  const url = new URL(targetUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return AuthorizationSubject.parse({ host, port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 })
}

function subjectLabel(subject: AuthorizationSubject): string {
  const host = parseIp(subject.host)?.family === 6 ? `[${subject.host}]` : subject.host
  return `${subject.includeSubdomains ? '*.' : ''}${host}${subject.port ? `:${subject.port}` : ''}`
}
