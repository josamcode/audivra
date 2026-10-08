import path from 'node:path'
import { z } from 'zod'
import { engagementWorkspaceDir, getConfig, resolveInside, toWorkspaceRelative, type Logger } from '@audivra/config'
import {
  authorizationRequiredFor,
  parseIp,
  redact,
  SecurityActor,
  type DecisionCheck,
  type DecisionStage,
  type PolicyDecision,
  type ScopeEvaluation,
  type SecurityEvidenceItem,
} from '@audivra/contracts'
import { newId } from '@audivra/database'
import { dockerImagePresent, killOwnedForExecution } from '@audivra/tool-runtime'
import { evaluateAuthorizationCoverage } from './authorization.ts'
import type { CapabilityRegistry } from './capabilities/registry.ts'
import type { CapabilityHandles, EvidenceRecorder, SecurityCapability, SecurityExecutionContext } from './capabilities/types.ts'
import { deepFreeze } from './freeze.ts'
import { systemResolver, type Resolver } from './dns.ts'
import { ScopedHttpClient, type NetworkAttempt } from './http-client.ts'
import { effectivePolicy, evaluateCapabilityPolicy, type CapabilityPolicyResult } from './policy.ts'
import { evaluateReadiness } from './readiness.ts'
import { checkExecutionResources, type ResourceCheck, type ResourceCheckInput } from './resources.ts'
import { evaluateNetworkDestination, evaluateUrl } from './scope.ts'
import type { EngagementSnapshot, SecurityStore } from './store.ts'

/*
 * The Capability Broker: the only path from "someone wants capability X" to "capability X runs".
 *
 *   request → capability → input → engagement → readiness → authorization → scope (+ DNS)
 *           → destination authorization → environment/risk policy → resources → decision
 *           → [allowed only] executor → result → evidence + security events
 *
 * Every request gets one complete, persisted decision explaining what was checked. Denied requests
 * never reach an executor. The executor receives a frozen context built from persisted engagement data
 * and handles (HTTP client, workspace, evidence recorder) that enforce the same scope and limits.
 */

/**
 * A capability request. It names an engagement, a capability and that capability's input — nothing
 * else. Authorization, scope, environment and policy are never part of a request; they are loaded from
 * the engagement, so a caller (or a model) has no field through which to supply them.
 */
export const BrokerRequest = z.strictObject({
  engagementId: z.string().min(1).max(64),
  capabilityId: z.string().min(1).max(120),
  input: z.unknown(),
  actor: SecurityActor,
  correlationId: z.string().min(1).max(120).optional(),
})
export type BrokerRequest = z.input<typeof BrokerRequest>

export interface BrokerOutcome {
  executionId: string
  status: 'denied' | 'completed' | 'failed' | 'cancelled'
  decision: PolicyDecision
  output: unknown
  summary: string | null
  evidence: SecurityEvidenceItem[]
  error: string | null
  network: NetworkAttempt[]
}

export interface BrokerDependencies {
  registry: CapabilityRegistry
  store: SecurityStore
  resolver?: Resolver
  now?: () => Date
  /** Engagement workspace root (default: the configured data directory). */
  workspaceRoot?: (engagementId: string) => string
  checkResources?: (input: ResourceCheckInput) => Promise<ResourceCheck>
  log?: Logger
}

const OUTPUT_LIMIT = 20_000

function compact(value: unknown): unknown {
  const json = JSON.stringify(value ?? null)
  return json.length > OUTPUT_LIMIT ? { truncated: true, size: json.length } : value
}

export class CapabilityBroker {
  readonly #registry: CapabilityRegistry
  readonly #store: SecurityStore
  readonly #resolver: Resolver
  readonly #now: () => Date
  readonly #workspaceRoot: (engagementId: string) => string
  readonly #checkResources: (input: ResourceCheckInput) => Promise<ResourceCheck>
  readonly #log: Logger | undefined

  constructor(deps: BrokerDependencies) {
    this.#registry = deps.registry
    this.#store = deps.store
    this.#resolver = deps.resolver ?? systemResolver
    this.#now = deps.now ?? (() => new Date())
    this.#workspaceRoot = deps.workspaceRoot ?? engagementWorkspaceDir
    this.#checkResources = deps.checkResources ?? checkExecutionResources
    this.#log = deps.log
  }

  get registry(): CapabilityRegistry {
    return this.#registry
  }

  async execute(request: unknown, options: { signal?: AbortSignal } = {}): Promise<BrokerOutcome> {
    const executionId = newId('sx')
    const evaluatedAt = this.#now()
    const parsed = BrokerRequest.safeParse(request)
    if (!parsed.success) {
      const engagementId = typeof (request as { engagementId?: unknown })?.engagementId === 'string' ? (request as { engagementId: string }).engagementId : 'unknown'
      const decision = denial(executionId, engagementId, evaluatedAt, 'input', 'request.invalid', `Invalid capability request: ${issueText(parsed.error)}`)
      await this.#recordStandaloneDenial(engagementId, decision)
      return deniedOutcome(executionId, decision)
    }
    const req = parsed.data
    const correlationId = req.correlationId ?? executionId
    const loaded = await this.#store.loadEngagement(req.engagementId)
    if (!loaded) {
      const decision = { ...denial(executionId, req.engagementId, evaluatedAt, 'engagement', 'engagement.not-found', 'No such security engagement'), correlationId, actor: req.actor }
      return deniedOutcome(executionId, decision)
    }
    const { engagement, authorizations } = loaded
    const capability = this.#registry.get(req.capabilityId)

    await this.#store.recordEvent({
      engagementId: engagement.id,
      type: 'capability.requested',
      message: `${actorLabel(req.actor)} requested ${req.capabilityId}`,
      actor: req.actor,
      executionId,
      capabilityId: req.capabilityId,
      configVersion: engagement.configVersion,
      data: { correlationId, input: compact(req.input) },
    })

    const evaluation = await this.#evaluate(executionId, correlationId, req, engagement, authorizations, capability, evaluatedAt)
    const { decision } = evaluation
    if (decision.decision === 'deny' || !capability || !evaluation.policy) {
      await this.#store.recordEvent({
        engagementId: engagement.id,
        type: 'capability.denied',
        level: 'warn',
        message: `${req.capabilityId} denied: ${decision.reason}`,
        actor: req.actor,
        executionId,
        capabilityId: req.capabilityId,
        configVersion: engagement.configVersion,
        decision,
      })
      this.#log?.info({ executionId, capabilityId: req.capabilityId, engagementId: engagement.id, rule: decision.rule }, 'security capability denied')
      return deniedOutcome(executionId, decision)
    }

    const allowedEvent = await this.#store.recordEvent({
      engagementId: engagement.id,
      type: 'capability.allowed',
      message: `${req.capabilityId} allowed: ${decision.reason}`,
      actor: req.actor,
      executionId,
      capabilityId: req.capabilityId,
      configVersion: engagement.configVersion,
      decision,
    })
    return this.#run(executionId, correlationId, req, engagement, capability, evaluation.input, evaluation.policy, decision, allowedEvent.id, options.signal)
  }

  /**
   * Records a request that was rejected before it could be evaluated (e.g. malformed agent arguments),
   * so attempts to pass fields a request may not contain are visible in the audit trail.
   */
  async reject(engagementId: string, actor: z.input<typeof SecurityActor>, rule: string, reason: string): Promise<PolicyDecision> {
    const executionId = newId('sx')
    const decision: PolicyDecision = { ...denial(executionId, engagementId, this.#now(), 'input', rule, reason), actor: SecurityActor.parse(actor) }
    await this.#recordStandaloneDenial(engagementId, decision)
    return decision
  }

  async #recordStandaloneDenial(engagementId: string, decision: PolicyDecision): Promise<void> {
    if (engagementId === 'unknown') return
    const loaded = await this.#store.loadEngagement(engagementId).catch(() => null)
    if (!loaded) return
    await this.#store.recordEvent({
      engagementId,
      type: 'capability.denied',
      level: 'warn',
      message: `Capability request rejected: ${decision.reason}`,
      actor: decision.actor,
      executionId: decision.executionId,
      configVersion: loaded.engagement.configVersion,
      decision,
    })
  }

  async #evaluate(
    executionId: string,
    correlationId: string,
    req: z.output<typeof BrokerRequest>,
    engagement: EngagementSnapshot,
    authorizations: Parameters<typeof evaluateAuthorizationCoverage>[0],
    capability: SecurityCapability | undefined,
    now: Date,
  ): Promise<{ decision: PolicyDecision; input: unknown; policy: CapabilityPolicyResult | null }> {
    const checks: DecisionCheck[] = []
    const check = (stage: DecisionStage, ok: boolean, rule: string, reason: string) => checks.push({ stage, outcome: ok ? 'pass' : 'fail', rule, reason })
    const skip = (stage: DecisionStage, reason: string) => checks.push({ stage, outcome: 'skipped', rule: `${stage}.skipped`, reason })
    const meta = capability?.metadata ?? null
    const authRequired = meta ? authorizationRequiredFor(meta) : true
    const policy = effectivePolicy(engagement)
    let authState: PolicyDecision['authorization'] = { required: authRequired, state: 'not-evaluated', authorizationIds: [], reason: 'Not evaluated' }
    let scopeEvaluations: ScopeEvaluation[] = []
    let policyResult: CapabilityPolicyResult | null = null
    let input: unknown = null

    const finish = (): { decision: PolicyDecision; input: unknown; policy: CapabilityPolicyResult | null } => {
      const failed = checks.find((c) => c.outcome === 'fail')
      const decision: PolicyDecision = {
        decision: failed ? 'deny' : 'allow',
        stage: failed?.stage ?? 'policy',
        rule: failed?.rule ?? 'broker.allowed',
        reason: failed?.reason ?? `Authorized, in scope and permitted: ${policyResult?.reason ?? ''}`.trim(),
        executionId,
        correlationId,
        engagementId: engagement.id,
        engagementStatus: engagement.status,
        configVersion: engagement.configVersion,
        capability: meta ? { id: meta.id, version: meta.version, implementation: meta.implementation, riskClass: meta.riskClass, sideEffect: meta.sideEffect } : null,
        environment: engagement.environment,
        authorization: authState,
        scope: { version: engagement.scopeVersion, hash: engagement.scopeHash, evaluations: scopeEvaluations },
        policy: policyResult
          ? { profileKey: engagement.policyProfileKey, profileVersion: engagement.policyProfileVersion, risk: policyResult.risk, mutation: policyResult.mutation, limits: policyResult.limits }
          : null,
        checks,
        actor: req.actor,
        evaluatedAt: now.toISOString(),
      }
      return { decision, input, policy: failed ? null : policyResult }
    }

    // 1. The capability must be registered.
    if (!capability || !meta) {
      check('capability', false, 'capability.unknown', `${req.capabilityId} is not a registered capability`)
      return finish()
    }
    check('capability', true, 'capability.registered', `${meta.name} v${meta.version} (${meta.riskClass}, ${meta.sideEffect})`)

    // 2. Input must match the capability's strict schema.
    const parsedInput = capability.implementation.input.safeParse(req.input)
    if (!parsedInput.success) {
      check('input', false, 'input.invalid', `Invalid input for ${meta.id}: ${issueText(parsedInput.error)}`)
      return finish()
    }
    input = parsedInput.data
    check('input', true, 'input.valid', 'Input matches the capability schema')

    // 3. Readiness (lifecycle, environment, scope, policy, testing window), recomputed now.
    const readiness = evaluateReadiness({ status: engagement.status, environment: engagement.environment, scope: engagement.scope, policy, authorizations, now })
    const blocking = readiness.checks.filter((c) => !c.ok && c.key !== 'authorization')
    check('readiness', blocking.length === 0, blocking.length ? `readiness.${blocking[0]!.key}` : 'readiness.ready', blocking[0]?.reason ?? 'Engagement configuration is complete')

    // 4. The engagement itself must be authorized (every scope target covered).
    const engagementAuth = readiness.checks.find((c) => c.key === 'authorization')!
    check('authorization', engagementAuth.ok, engagementAuth.ok ? 'authorization.engagement-covered' : 'authorization.engagement-not-authorized', engagementAuth.reason)

    // 5. Scope: every destination the request targets, then (for network capabilities) where it resolves.
    let targets: string[]
    try {
      targets = capability.implementation.targets(input)
    } catch (error) {
      check('scope', false, 'scope.targets-unavailable', `Could not determine the request's destinations: ${error instanceof Error ? error.message : String(error)}`)
      return finish()
    }
    if (targets.length === 0) check('scope', false, 'scope.no-targets', 'The request has no destination to evaluate')
    scopeEvaluations = targets.map((target) => evaluateUrl(engagement.scope, target, { kind: 'target' }))
    const nameDenied = scopeEvaluations.find((e) => e.decision === 'deny')
    if (nameDenied) check('scope', false, nameDenied.rule, nameDenied.reason)
    else if (targets.length) {
      if (meta.requiresNetwork) {
        for (const named of [...scopeEvaluations]) {
          const { host, port, url } = named.destination
          let addresses: string[]
          try {
            const literal = parseIp(host!)
            addresses = literal ? [literal.text] : await this.#resolver(host!)
          } catch (error) {
            check('scope', false, 'dns.lookup-failed', `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`)
            break
          }
          const network = evaluateNetworkDestination(engagement.scope, { host: host!, port: port!, addresses, classification: named.classification, url })
          scopeEvaluations.push(network)
          if (network.decision === 'deny') {
            check('scope', false, network.rule, network.reason)
            break
          }
        }
      }
      if (!checks.some((c) => c.stage === 'scope' && c.outcome === 'fail')) {
        check('scope', true, 'scope.in-scope', `${targets.length} destination${targets.length === 1 ? '' : 's'} in scope`)
      }
    }

    // 6. Destination authorization (always for capabilities that need it — anything above passive / read-only).
    if (authRequired) {
      const inScope = scopeEvaluations.filter((e) => e.kind !== 'network' && e.decision === 'allow')
      if (inScope.length === 0) {
        authState = { required: true, state: 'not-evaluated', authorizationIds: [], reason: 'No in-scope destination to authorize' }
        skip('authorization', 'No in-scope destination to authorize')
      } else {
        const results = inScope.map((e) => evaluateAuthorizationCoverage(authorizations, { host: e.destination.host!, port: e.destination.port }))
        const missing = results.find((r) => r.state !== 'valid')
        authState = missing
          ? { required: true, ...missing }
          : { required: true, state: 'valid', authorizationIds: [...new Set(results.flatMap((r) => r.authorizationIds))], reason: results[0]!.reason }
        check('authorization', !missing, missing ? `authorization.${missing.state}` : 'authorization.valid', authState.reason)
      }
    } else {
      authState = { required: false, state: 'not-required', authorizationIds: [], reason: 'Passive, read-only capability that does not declare an authorization requirement' }
    }

    // 7. Environment and risk policy.
    policyResult = evaluateCapabilityPolicy(policy, meta)
    check('policy', policyResult.allowed, policyResult.rule, policyResult.reason)

    // 8. Resources, only when everything else allows the request.
    if (checks.some((c) => c.outcome === 'fail')) {
      skip('resources', 'Not checked: the request is already denied')
    } else {
      const resources = await this.#checkResources({
        capability: meta,
        workspaceRoot: this.#workspaceRoot(engagement.id),
        minFreeBytes: getConfig().SECURITY_MIN_FREE_DISK_MB * 1_048_576,
        maxArtifactBytes: policyResult.limits.maxArtifactMb * 1_048_576,
        imagePresent: dockerImagePresent,
      })
      check('resources', resources.ok, resources.rule, resources.reason)
    }
    return finish()
  }

  async #run(
    executionId: string,
    correlationId: string,
    req: z.output<typeof BrokerRequest>,
    engagement: EngagementSnapshot,
    capability: SecurityCapability,
    input: unknown,
    policy: CapabilityPolicyResult,
    decision: PolicyDecision,
    decisionEventId: number,
    signal: AbortSignal | undefined,
  ): Promise<BrokerOutcome> {
    const meta = capability.metadata
    const environment = engagement.environment!
    const context: SecurityExecutionContext = deepFreeze({
      executionId,
      correlationId,
      engagementId: engagement.id,
      configVersion: engagement.configVersion,
      environment,
      authorization: { required: decision.authorization.required, state: decision.authorization.state, authorizationIds: decision.authorization.authorizationIds },
      scope: { version: engagement.scopeVersion, hash: engagement.scopeHash, manifest: structuredClone(engagement.scope) },
      policy: { profileKey: engagement.policyProfileKey, profileVersion: engagement.policyProfileVersion, risk: policy.risk, mutation: policy.mutation },
      capability: { id: meta.id, version: meta.version, implementation: meta.implementation, riskClass: meta.riskClass, sideEffect: meta.sideEffect },
      limits: { ...policy.limits },
      actor: { ...req.actor },
      allowedTargets: decision.scope!.evaluations.filter((e) => e.kind !== 'network').map((e) => e.destination.url!),
      requestedAt: decision.evaluatedAt,
    })

    const controller = new AbortController()
    const timeoutMs = Math.min(policy.limits.executionTimeoutSeconds, meta.timeoutProfile.maxSeconds) * 1000
    const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs / 1000} s`)), timeoutMs)
    const onAbort = () => controller.abort(signal?.reason ?? new Error('Cancelled'))
    if (signal?.aborted) onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    const workspaceRoot = this.#workspaceRoot(engagement.id)
    const dir = path.join(workspaceRoot, 'executions', executionId)
    const evidence: SecurityEvidenceItem[] = []
    let open = true
    const recorder: EvidenceRecorder = {
      record: async (item) => {
        if (!open) throw new Error('Evidence can only be recorded while the execution is running')
        const artifactPath = item.artifactPath ? (resolveInside(workspaceRoot, item.artifactPath) ? item.artifactPath.replace(/\\/g, '/') : null) : null
        if (item.artifactPath && !artifactPath) throw new Error(`Artifact path escapes the engagement workspace: ${item.artifactPath}`)
        const recorded = await this.#store.recordEvidence({
          engagementId: engagement.id,
          source: 'system',
          type: item.type,
          title: item.title,
          summary: item.summary,
          url: item.url ?? null,
          artifactPath,
          metadata: item.metadata,
          provenance: {
            engagementId: engagement.id,
            executionId,
            correlationId,
            capabilityId: meta.id,
            capabilityVersion: meta.version,
            implementation: meta.implementation,
            decisionEventId,
            environment,
            scopeVersion: engagement.scopeVersion,
            scopeHash: engagement.scopeHash,
            configVersion: engagement.configVersion,
            policyProfile: { key: engagement.policyProfileKey, version: engagement.policyProfileVersion },
            authorizationIds: decision.authorization.authorizationIds,
            sensitivity: item.sensitivity ?? 'normal',
          },
        })
        evidence.push(recorded)
        return recorded
      },
    }
    const http = new ScopedHttpClient({ manifest: context.scope.manifest, limits: context.limits, mutation: meta.sideEffect, resolver: this.#resolver, signal: controller.signal })
    const handles: CapabilityHandles = {
      http,
      signal: controller.signal,
      workspace: { root: workspaceRoot, dir, relative: (abs) => toWorkspaceRelative(workspaceRoot, abs) ?? '' },
      evidence: recorder,
      processOwner: { tool: meta.id, securityExecutionId: executionId },
    }
    const event = (type: 'capability.started' | 'capability.completed' | 'capability.failed' | 'capability.cancelled', message: string, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') =>
      this.#store.recordEvent({ engagementId: engagement.id, type, level, message, actor: req.actor, executionId, capabilityId: meta.id, configVersion: engagement.configVersion, data })

    await event('capability.started', `${meta.name} started`, { correlationId, limits: context.limits, targets: context.allowedTargets })
    try {
      const result = await capability.implementation.execute(context, input, handles)
      open = false
      await event('capability.completed', redact(result.summary).slice(0, 500), {
        output: compact(result.output),
        evidence: evidence.map((e) => e.ref),
        requests: http.requestCount,
        network: http.attempts,
      })
      return { executionId, status: 'completed', decision, output: result.output, summary: result.summary, evidence, error: null, network: http.attempts }
    } catch (error) {
      open = false
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000)
      if (controller.signal.aborted) {
        const killed = await killOwnedForExecution(executionId)
        const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : 'Cancelled'
        await event('capability.cancelled', `${meta.name} stopped: ${reason}`, { reason, killedProcesses: killed, requests: http.requestCount, network: http.attempts }, 'warn')
        return { executionId, status: 'cancelled', decision, output: null, summary: null, evidence, error: reason, network: http.attempts }
      }
      await event('capability.failed', `${meta.name} failed: ${message}`, { error: message, requests: http.requestCount, network: http.attempts }, 'error')
      return { executionId, status: 'failed', decision, output: null, summary: null, evidence, error: message, network: http.attempts }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (controller.signal.aborted) await killOwnedForExecution(executionId)
    }
  }
}

function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ')
}

function actorLabel(actor: z.output<typeof SecurityActor>): string {
  return actor.kind === 'agent' ? `Agent run ${actor.agentRunId ?? '(unknown)'}` : actor.kind === 'system' ? 'Audivra' : 'User'
}

function denial(executionId: string, engagementId: string, now: Date, stage: DecisionStage, rule: string, reason: string): PolicyDecision {
  return {
    decision: 'deny',
    stage,
    rule,
    reason,
    executionId,
    correlationId: executionId,
    engagementId,
    engagementStatus: null,
    configVersion: null,
    capability: null,
    environment: null,
    authorization: { required: true, state: 'not-evaluated', authorizationIds: [], reason: 'Not evaluated' },
    scope: null,
    policy: null,
    checks: [{ stage, outcome: 'fail', rule, reason }],
    actor: { kind: 'system', id: null, agentRunId: null },
    evaluatedAt: now.toISOString(),
  }
}

function deniedOutcome(executionId: string, decision: PolicyDecision): BrokerOutcome {
  return { executionId, status: 'denied', decision, output: null, summary: null, evidence: [], error: null, network: [] }
}
