import { redact, redactSensitive, ScopeManifest, type ScopeManifestInput, type SecurityAuthorizationItem, type SecurityEventItem, type SecurityEvidenceItem } from '@audivra/contracts'
import { z } from 'zod'
import { manifestHash, type EngagementSnapshot, type SecurityStore } from '../src/index.ts'
import type { SecurityCapability } from '../src/capabilities/types.ts'

/** In-memory SecurityStore for unit tests; applies the same redaction as the PostgreSQL repository. */
export class MemoryStore implements SecurityStore {
  events: SecurityEventItem[] = []
  evidence: SecurityEvidenceItem[] = []
  observations: import('@audivra/contracts').SecurityObservation[] = []

  constructor(
    public engagement: EngagementSnapshot,
    public authorizations: SecurityAuthorizationItem[] = [],
  ) {}

  async loadEngagement(id: string) {
    return id === this.engagement.id ? { engagement: structuredClone(this.engagement), authorizations: structuredClone(this.authorizations) } : null
  }

  async recordEvent(input: Parameters<SecurityStore['recordEvent']>[0]) {
    const item: SecurityEventItem = {
      id: this.events.length + 1,
      engagementId: input.engagementId,
      type: input.type,
      level: input.level ?? 'info',
      message: redact(input.message),
      actor: input.actor,
      executionId: input.executionId ?? null,
      capabilityId: input.capabilityId ?? null,
      configVersion: input.configVersion,
      decision: input.decision ? redact(input.decision) : null,
      data: input.data ? redact(input.data) : null,
      createdAt: new Date().toISOString(),
    }
    this.events.push(item)
    return item
  }

  async recordEvidence(input: Parameters<SecurityStore['recordEvidence']>[0]) {
    const content = redactSensitive({ title: input.title, summary: input.summary, metadata: input.metadata ?? {} })
    const item: SecurityEvidenceItem = {
      id: `ev_${this.evidence.length + 1}`,
      ref: `EV-${this.evidence.length + 1}`,
      engagementId: input.engagementId,
      source: input.source,
      type: input.type,
      title: content.value.title,
      summary: content.value.summary,
      url: input.url ?? null,
      artifactPath: input.artifactPath ?? null,
      metadata: content.value.metadata,
      provenance: {
        ...input.provenance,
        redactions: content.redactions,
        sensitivity: content.redactions > 0 ? 'sensitive' : input.provenance.sensitivity,
        recordedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    }
    this.evidence.push(item)
    return item
  }

  async recordObservation(input: Parameters<SecurityStore['recordObservation']>[0]) {
    const content = redactSensitive({ title: input.title, subject: input.subject, value: input.value })
    const existing = this.observations.find((o) => o.engagementId === input.engagementId && o.dedupeKey === input.dedupeKey)
    const now = new Date().toISOString()
    if (existing) {
      existing.contributions = [...existing.contributions, input.contribution]
      existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...(input.contribution.evidenceRef ? [input.contribution.evidenceRef] : [])])]
      existing.confidence = Math.max(existing.confidence, input.contribution.confidence)
      existing.value = content.value.value
      existing.title = content.value.title
      existing.scopeClass = input.scopeClass ?? existing.scopeClass
      existing.lastSeenAt = now
      return existing
    }
    const item = {
      id: `obs_${this.observations.length + 1}`,
      engagementId: input.engagementId,
      dedupeKey: input.dedupeKey,
      type: input.type,
      asset: input.asset,
      subject: content.value.subject,
      title: content.value.title,
      scopeClass: input.scopeClass,
      value: content.value.value,
      sourceType: input.sourceType,
      confidence: input.contribution.confidence,
      evidenceRefs: input.contribution.evidenceRef ? [input.contribution.evidenceRef] : [],
      contributions: [input.contribution],
      firstSeenAt: now,
      lastSeenAt: now,
    }
    this.observations.push(item)
    return item
  }

  types(): string[] {
    return this.events.map((e) => e.type)
  }
}

export function snapshot(port: number, patch: Partial<EngagementSnapshot> & { scopeInput?: ScopeManifestInput } = {}): EngagementSnapshot {
  const { scopeInput, ...rest } = patch
  const scope = ScopeManifest.parse(scopeInput ?? { hosts: [{ host: '127.0.0.1', ports: [port] }], protocols: ['http'] })
  return {
    id: 'eng0000001',
    status: 'ready',
    environment: 'staging',
    policyProfileKey: 'standard',
    policyProfileVersion: 1,
    scope,
    scopeVersion: 1,
    scopeHash: manifestHash(scope),
    configVersion: 3,
    ...rest,
  }
}

export function verifiedLocal(port: number, host = '127.0.0.1'): SecurityAuthorizationItem {
  const now = new Date().toISOString()
  return {
    id: `sa_${host}_${port}`,
    engagementId: 'eng0000001',
    method: 'local-development',
    status: 'verified',
    effectiveStatus: 'verified',
    subject: { host, port, includeSubdomains: false },
    reason: 'loopback',
    verifiedAt: now,
    expiresAt: null,
    revokedAt: null,
    reference: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  }
}

/** A capability whose executor records every call, so tests can prove it was (not) reached. */
export function spyCapability(patch: Partial<SecurityCapability['metadata']> = {}, execute?: SecurityCapability<{ url: string }>['implementation']['execute']) {
  const calls: { context: unknown; input: unknown }[] = []
  const capability: SecurityCapability<{ url: string }, { ok: true }> = {
    metadata: {
      id: 'test.spy',
      version: 1,
      family: 'discovery',
      name: 'Spy capability',
      description: 'Records whether its executor was reached.',
      riskClass: 'passive',
      sideEffect: 'read-only',
      supportedEnvironments: ['production', 'staging', 'isolated-lab'],
      requiresAuthorization: true,
      requiresIdentity: false,
      requiresNetwork: false,
      requiresExternalIntegration: false,
      supportsCancellation: true,
      rateLimitClass: 'light',
      resourceProfile: { disk: 'none', containerImage: null, spawnsProcesses: false },
      timeoutProfile: { defaultSeconds: 10, maxSeconds: 30 },
      evidenceTypes: [],
      implementation: 'test/spy@1',
      ...patch,
    },
    implementation: {
      id: patch.implementation ?? 'test/spy@1',
      input: z.strictObject({ url: z.string() }),
      targets: (input) => [input.url],
      async execute(context, input, handles) {
        calls.push({ context, input })
        if (execute) return execute(context, input, handles) as Promise<{ output: { ok: true }; summary: string }>
        return { output: { ok: true }, summary: 'spy executed' }
      },
    },
  }
  return { capability, calls }
}
