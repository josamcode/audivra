import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { engagementWorkspaceDir, getConfig, type Logger } from '@audivra/config'
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
  type SecurityExecutionSnapshot,
} from '@audivra/contracts'
import { newId } from '@audivra/database'
import { dockerImagePresent, killOwnedForExecution } from '@audivra/tool-runtime'
import { evaluateAuthorizationCoverage } from './authorization.ts'
import { compact } from './compact.ts'
import type { CapabilityRegistry } from './capabilities/registry.ts'
import type { SecurityCapability } from './capabilities/types.ts'
import { systemResolver, type Resolver } from './dns.ts'
import { NOT_STARTED_EXIT } from './execution/control.ts'
import { executionEvent } from './execution/events.ts'
import { failure, failureMessage } from './execution/failures.ts'
import { createExecutionHandles } from './execution/handles.ts'
import { buildExecutionSnapshot, contextFromSnapshot, snapshotHash } from './execution/snapshot.ts'
import type { ExecutionQueue, ExecutionStore } from './execution/store.ts'
import { ExecutionWorkspace } from './execution/workspace.ts'
import { type NetworkAttempt } from './http-client.ts'
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
 *           → [allowed only] trusted snapshot → execute (in process)  or  submit (durable, queued)
 *           → executor → result → evidence + security events
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

/** Result of `submit`: the execution was accepted and queued, denied, or could not be queued. */
export interface SubmitOutcome {
  executionId: string
  status: 'queued' | 'denied' | 'failed'
  decision: PolicyDecision
  error: string | null
}

type Allowed = {
  kind: 'allowed'
  executionId: string
  correlationId: string
  req: z.output<typeof BrokerRequest>
  engagement: EngagementSnapshot
  capability: SecurityCapability
  input: unknown
  policy: CapabilityPolicyResult
  decision: PolicyDecision
  decisionEventId: number
}
type Decided = Allowed | { kind: 'denied'; executionId: string; decision: PolicyDecision }

export interface BrokerDependencies {
  registry: CapabilityRegistry
  store: SecurityStore
  /** Where accepted durable executions are persisted and queued (required for `submit`). */
  executions?: { store: ExecutionStore; queue: ExecutionQueue }
  resolver?: Resolver
  now?: () => Date
  /** Engagement workspace root (default: the configured data directory). */
  workspaceRoot?: (engagementId: string) => string
  checkResources?: (input: ResourceCheckInput) => Promise<ResourceCheck>
  log?: Logger
}

export class CapabilityBroker {
  readonly #registry: CapabilityRegistry
  readonly #store: SecurityStore
  readonly #resolver: Resolver
  readonly #now: () => Date
  readonly #workspaceRoot: (engagementId: string) => string
  readonly #checkResources: (input: ResourceCheckInput) => Promise<ResourceCheck>
  readonly #log: Logger | undefined
  readonly #executions: BrokerDependencies['executions']

  constructor(deps: BrokerDependencies) {
    this.#registry = deps.registry
    this.#store = deps.store
    this.#resolver = deps.resolver ?? systemResolver
    this.#now = deps.now ?? (() => new Date())
    this.#workspaceRoot = deps.workspaceRoot ?? engagementWorkspaceDir
    this.#checkResources = deps.checkResources ?? checkExecutionResources
    this.#log = deps.log
    this.#executions = deps.executions
  }

  get registry(): CapabilityRegistry {
    return this.#registry
  }

  /**
   * Decides a request and, when it is allowed, runs it in this process (Phase 1 path: tests and the
   * agent gateway). Nothing is persisted beyond the decision trail and evidence; durable runs use
   * `submit`.
   */
  async execute(request: unknown, options: { signal?: AbortSignal } = {}): Promise<BrokerOutcome> {
    const decided = await this.#decide(request)
    if (decided.kind === 'denied') return deniedOutcome(decided.executionId, decided.decision)
    return this.#run(decided, options.signal)
  }

  /**
   * Decides a request and, when it is allowed, accepts it as a durable execution: the trusted snapshot
   * is persisted with the execution and a job naming only the execution id is queued for the worker.
   * The request itself never reaches the worker.
   */
  async submit(request: unknown): Promise<SubmitOutcome> {
    const executions = this.#executions
    if (!executions) throw new Error('This broker cannot accept durable executions: it was created without an execution store and queue')
    const decided = await this.#decide(request)
    if (decided.kind === 'denied') return { executionId: decided.executionId, status: 'denied', decision: decided.decision, error: null }
    const { executionId, decision } = decided
    const meta = decided.capability.metadata
    const snapshot = this.#snapshot(decided)
    const hash = snapshotHash(snapshot)
    const record = await executions.store.create({
      id: executionId,
      engagementId: decided.engagement.id,
      capabilityId: meta.id,
      capabilityVersion: meta.version,
      environment: snapshot.environment,
      configVersion: decided.engagement.configVersion,
      correlationId: decided.correlationId,
      requestedBy: decided.req.actor,
      decisionEventId: decided.decisionEventId,
      snapshot,
      snapshotHash: hash,
    })
    await executionEvent(
      this.#store,
      record,
      'execution.requested',
      `${meta.name} accepted for execution with its trusted snapshot`,
      { snapshotHash: hash, limits: snapshot.limits, runtime: snapshot.runtime, targets: snapshot.allowedTargets },
      'info',
      decided.req.actor,
    )
    // The job id is chosen up front so "queued" is always recorded before a worker can pick the job up.
    const jobId = randomUUID()
    try {
      await executions.store.setJob(executionId, jobId)
      await executionEvent(this.#store, record, 'execution.queued', 'Queued for the worker', { jobId })
      await executions.queue.enqueue(executionId, jobId)
      return { executionId, status: 'queued', decision, error: null }
    } catch (error) {
      const message = failureMessage(error)
      await executions.store.update(
        executionId,
        { from: ['queued'] },
        { status: 'failed', finishedAt: this.#now(), failure: failure('internal', 'execution.enqueue-failed', `Could not queue the execution: ${message}`), exit: { ...NOT_STARTED_EXIT, outcome: 'failed' } },
      )
      await executionEvent(this.#store, record, 'execution.failed', `${meta.name} could not be queued: ${message}`, {}, 'error')
      return { executionId, status: 'failed', decision, error: message }
    }
  }

  /** The decision path shared by `execute` and `submit`: every check, one persisted, explained decision. */
  async #decide(request: unknown): Promise<Decided> {
    const executionId = newId('sx')
    const evaluatedAt = this.#now()
    const parsed = BrokerRequest.safeParse(request)
    if (!parsed.success) {
      const engagementId = typeof (request as { engagementId?: unknown })?.engagementId === 'string' ? (request as { engagementId: string }).engagementId : 'unknown'
      const decision = denial(executionId, engagementId, evaluatedAt, 'input', 'request.invalid', `Invalid capability request: ${issueText(parsed.error)}`)
      await this.#recordStandaloneDenial(engagementId, decision)
      return { kind: 'denied', executionId, decision }
    }
    const req = parsed.data
    const correlationId = req.correlationId ?? executionId
    const loaded = await this.#store.loadEngagement(req.engagementId)
    if (!loaded) {
      const decision = { ...denial(executionId, req.engagementId, evaluatedAt, 'engagement', 'engagement.not-found', 'No such security engagement'), correlationId, actor: req.actor }
      return { kind: 'denied', executionId, decision }
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
      return { kind: 'denied', executionId, decision }
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
    return {
      kind: 'allowed',
      executionId,
      correlationId,
      req,
      engagement,
      capability,
      input: evaluation.input,
      policy: evaluation.policy,
      decision,
      decisionEventId: allowedEvent.id,
    }
  }

  #snapshot(d: Allowed): SecurityExecutionSnapshot {
    return buildExecutionSnapshot({
      executionId: d.executionId,
      correlationId: d.correlationId,
      engagement: d.engagement,
      decision: d.decision,
      decisionEventId: d.decisionEventId,
      capability: d.capability.metadata,
      policy: d.policy,
      input: d.input,
      actor: d.req.actor,
    })
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

  async #run(d: Allowed, signal: AbortSignal | undefined): Promise<BrokerOutcome> {
    const { executionId, correlationId, decision, req } = d
    const meta = d.capability.metadata
    const engagement = d.engagement
    // The same trusted snapshot a durable execution persists; context and handles come from it only.
    const snapshot = this.#snapshot(d)
    const context = contextFromSnapshot(snapshot)

    const controller = new AbortController()
    const timeoutMs = snapshot.runtime.timeoutSeconds * 1000
    const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs / 1000} s`)), timeoutMs)
    const onAbort = () => controller.abort(signal?.reason ?? new Error('Cancelled'))
    if (signal?.aborted) onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    const workspace = new ExecutionWorkspace(this.#workspaceRoot(engagement.id), executionId)
    const { handles, registrar, http } = createExecutionHandles(snapshot, { workspace, signal: controller.signal, resolver: this.#resolver, store: this.#store })
    const event = (type: 'capability.started' | 'capability.completed' | 'capability.failed' | 'capability.cancelled', message: string, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') =>
      this.#store.recordEvent({ engagementId: engagement.id, type, level, message, actor: req.actor, executionId, capabilityId: meta.id, configVersion: engagement.configVersion, data })

    await event('capability.started', `${meta.name} started`, { correlationId, limits: context.limits, targets: context.allowedTargets })
    try {
      await workspace.init()
      const result = await d.capability.implementation.execute(context, d.input, handles)
      registrar.close()
      await event('capability.completed', redact(result.summary).slice(0, 500), {
        output: compact(result.output),
        evidence: registrar.registered.map((e) => e.ref),
        requests: http.requestCount,
        network: http.attempts,
      })
      return { executionId, status: 'completed', decision, output: result.output, summary: result.summary, evidence: registrar.registered, error: null, network: http.attempts }
    } catch (error) {
      registrar.close()
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000)
      if (controller.signal.aborted) {
        const killed = await killOwnedForExecution(executionId)
        const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : 'Cancelled'
        await event('capability.cancelled', `${meta.name} stopped: ${reason}`, { reason, killedProcesses: killed, requests: http.requestCount, network: http.attempts }, 'warn')
        return { executionId, status: 'cancelled', decision, output: null, summary: null, evidence: registrar.registered, error: reason, network: http.attempts }
      }
      await event('capability.failed', `${meta.name} failed: ${message}`, { error: message, requests: http.requestCount, network: http.attempts }, 'error')
      return { executionId, status: 'failed', decision, output: null, summary: null, evidence: registrar.registered, error: message, network: http.attempts }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (controller.signal.aborted) await killOwnedForExecution(executionId)
      await workspace.cleanup().catch(() => undefined)
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
