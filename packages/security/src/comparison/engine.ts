import type { Logger } from '@audivra/config'
import {
  comparisonActor,
  ComparisonPlanInput,
  findPolicyProfile,
  type BusinessStateChange,
  type ComparisonArm,
  type ComparisonStatus,
  type ComparisonTransition,
  type EnvironmentPolicy,
  type SecurityActor,
  type SecurityComparison,
  type SecurityEvidenceItem,
} from '@audivra/contracts'
import type { z } from 'zod'
import {
  findComparisonByDedupe,
  getComparisonRow,
  getEngagementRow,
  insertComparison,
  listDomainDeclarationRows,
  listSessionRows,
  newComparisonId,
  recordSecurityEvent,
  toComparison,
  updateComparison,
  type ComparisonPatch,
  type Db,
} from '@audivra/database'
import type { BrokerOutcome, CapabilityBroker } from '../broker.ts'
import { GraphProjector } from '../graph/projector.ts'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import { classifyComparison, classifyRelationship, comparisonDedupeKey } from './classify.ts'
import { ensureBoundaryHypothesis, reassessBoundaryHypothesis } from './hypothesis.ts'
import { normalizeProbe, probeFromEvidence } from './normalize.ts'
import { validateComparisonPlan, type ValidationContext } from './validate.ts'

/*
 * Phase 5 Step 4 — the differential-comparison engine. It turns a validated plan into evidence: it resolves
 * each arm's session, runs each arm as an identity-aware capability through the Capability Broker (which
 * re-checks policy/scope/identity), normalizes the responses, computes the result deterministically from the
 * controls and expectations, captures before/after state for state-transition comparisons, attempts cleanup,
 * stores everything and updates the linked hypothesis and invariant. The AI never reaches this code; a plan's
 * references are all validated first, and no result is produced without real execution evidence.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/
const COMPARISON_ID = /^cmp_[0-9a-z]{14}$/
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new SecurityRequestError(400, r.error.issues.slice(0, 5).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '))
  return r.data
}

export interface ComparisonEngineOptions {
  db: Db
  broker: CapabilityBroker
  /** Re-projects the graph after a comparison completes (default: a GraphProjector; derives CAN_ACCESS, closes gaps). */
  projector?: { project(engagementId: string): Promise<unknown> }
  now?: () => Date
  log?: Logger
}

export class ComparisonEngine {
  readonly #db: Db
  readonly #broker: CapabilityBroker
  readonly #projector: { project(engagementId: string): Promise<unknown> }
  readonly #now: () => Date
  readonly #log: Logger | undefined

  constructor(options: ComparisonEngineOptions) {
    this.#db = options.db
    this.#broker = options.broker
    this.#projector = options.projector ?? new GraphProjector({ db: options.db, log: options.log })
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  /** Validates and persists a comparison plan (does not execute). The persisted comparison is then `run`. */
  async plan(engagementId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityComparison> {
    const plan = parseOrThrow(ComparisonPlanInput, input)
    const engagement = ENGAGEMENT_ID.test(engagementId) ? await getEngagementRow(this.#db, engagementId) : undefined
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')

    const ctx = await this.#context(engagementId, engagement, plan)
    const validation = validateComparisonPlan(ctx, plan)
    const origin = comparisonActor(actor)
    const dedupeKey = comparisonDedupeKey(plan.dimension, plan.action, plan.arms)

    // Resolve/ensure the hypothesis this comparison investigates.
    const subjectArm = plan.arms.find((a) => a.role === 'subject') ?? plan.arms[0]!
    const hypothesisId = plan.hypothesisId ?? (await this.#ensureHypothesis(engagementId, plan, subjectArm.identityRef, origin)).id
    const relationship = this.#relationship(ctx, plan, subjectArm.identityRef)

    const existing = await findComparisonByDedupe(this.#db, engagementId, dedupeKey)
    if (existing) return toComparison(existing)

    const arms: ComparisonArm[] = plan.arms.map((a, i) => ({
      role: a.role,
      identityRef: a.identityRef,
      sessionRef: validation.ok ? (validation.arms[i]?.sessionRef ?? null) : null,
      resourceRef: a.resourceRef,
      url: a.url,
      method: a.method,
      body: a.body,
      expected: a.expected,
      status: validation.ok ? 'planned' : 'blocked',
      statusReason: validation.ok ? null : validation.scope === 'arm' && validation.armIndex === i ? validation.reason : 'The comparison plan was blocked',
      executionId: null,
      observation: null,
    }))

    const status: ComparisonStatus = validation.ok ? 'validated' : 'blocked'
    const now = this.#now().toISOString()
    const history: ComparisonTransition[] = [{ at: now, from: null, to: validation.ok ? 'not-tested' : 'blocked', reason: validation.ok ? 'Plan validated' : validation.reason, actor: origin }]
    const row = await insertComparison(this.#db, {
      id: newComparisonId(),
      engagementId,
      hypothesisId,
      dimension: plan.dimension,
      dedupeKey,
      title: this.#title(plan, subjectArm.identityRef),
      resourceRef: plan.resourceRef,
      action: plan.action,
      resourceRelationship: relationship,
      invariantRef: plan.invariantRef,
      status,
      arms,
      controls: { positive: plan.arms.some((a) => a.role === 'positive-control'), negative: plan.arms.some((a) => a.role === 'negative-control') },
      cleanupAction: plan.cleanup,
      stateProbe: plan.stateProbeUrl ? { url: plan.stateProbeUrl, expectedTransition: plan.expectedTransition } : null,
      coverageSampled: plan.coverageSampled,
      origin,
      history,
    })
    await this.#event(engagementId, engagement.configVersion, 'comparison.planned', `Planned ${plan.dimension} comparison on "${plan.resourceRef}" (${arms.length} arm${arms.length === 1 ? '' : 's'})${validation.ok ? '' : ` — blocked: ${validation.reason}`}`, { comparisonId: row.id, dimension: plan.dimension }, actor, validation.ok ? 'info' : 'warn')
    if (!validation.ok) {
      await updateComparison(this.#db, row.id, { result: 'blocked', resultReason: validation.reason })
      await this.#event(engagementId, engagement.configVersion, 'comparison.blocked', `Comparison on "${plan.resourceRef}" blocked: ${validation.reason}`, { comparisonId: row.id }, actor, 'warn')
    }
    return toComparison((await getComparisonRow(this.#db, row.id))!)
  }

  /** Executes a validated comparison: runs its arms, compares, classifies, cleans up, updates hypothesis. */
  async run(comparisonId: string, actor: SecurityActor = LOCAL_USER): Promise<SecurityComparison> {
    const row = COMPARISON_ID.test(comparisonId) ? await getComparisonRow(this.#db, comparisonId) : undefined
    if (!row) throw new SecurityRequestError(404, 'Comparison not found')
    const comparison = toComparison(row)
    if (comparison.status === 'completed') return comparison
    if (comparison.status === 'blocked') return comparison
    const engagement = await getEngagementRow(this.#db, comparison.engagementId)
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')

    await this.#patch(comparisonId, { status: 'running' })
    await this.#event(comparison.engagementId, engagement.configVersion, 'comparison.started', `Running ${comparison.dimension} comparison on "${comparison.resourceRef}"`, { comparisonId }, actor)

    // Re-resolve sessions (they may have changed since planning) and run each not-yet-executed arm.
    const sessions = await this.#sessions(comparison.engagementId, comparison.arms.map((a) => a.identityRef).filter((r): r is string => !!r))
    const arms = [...comparison.arms]
    const evidenceRefs = new Set(comparison.evidenceRefs)
    let state: BusinessStateChange | null = comparison.state
    const subjectArm = arms.find((a) => a.role === 'subject')
    const subjectSession = subjectArm?.identityRef ? sessions.get(subjectArm.identityRef)?.id ?? null : null

    // State-transition: read the resource's state (as the subject) BEFORE the action changes it.
    if (comparison.dimension === 'state-transition' && comparison.stateProbe && subjectArm) {
      const before = await this.#readState(comparison.engagementId, comparison.stateProbe.url, subjectArm.identityRef, subjectSession, actor, evidenceRefs)
      state = { before, after: null, expectedTransition: comparison.stateProbe.expectedTransition, transitionObserved: null, detail: null }
      await this.#patch(comparisonId, { state, evidenceRefs: [...evidenceRefs] })
    }

    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i]!
      if (arm.status === 'executed' || arm.status === 'blocked') continue
      if (arm.identityRef) {
        const session = sessions.get(arm.identityRef)
        if (!session || session.status !== 'active') {
          arms[i] = { ...arm, status: 'blocked', statusReason: `No active session for "${arm.identityRef}"` }
          await this.#patch(comparisonId, { arms })
          continue
        }
        arm.sessionRef = session.id
      }
      const outcome = await this.#runArm(comparison.engagementId, arm, actor)
      for (const ref of outcome.evidence.map((e) => e.ref)) evidenceRefs.add(ref)
      arms[i] = this.#armFromOutcome(arm, outcome)
      await this.#patch(comparisonId, { arms, evidenceRefs: [...evidenceRefs] })
    }

    // State-transition: read the resource's state AFTER the action and compare before/after.
    if (comparison.dimension === 'state-transition' && comparison.stateProbe && subjectArm) {
      const after = await this.#readState(comparison.engagementId, comparison.stateProbe.url, subjectArm.identityRef, subjectSession, actor, evidenceRefs)
      const before = state?.before ?? null
      const changed = (!!before && !!after && before.normalizedHash !== after.normalizedHash) || (after?.businessResult !== (before?.businessResult ?? null) && !!after?.businessResult) || arms.some((a) => a.observation?.stateMutation)
      state = {
        before,
        after,
        expectedTransition: comparison.stateProbe.expectedTransition,
        transitionObserved: changed,
        detail: `State ${changed ? 'changed' : 'unchanged'}${after?.businessResult ? ` → ${after.businessResult}` : ''}${comparison.stateProbe.expectedTransition ? ` (expected ${comparison.stateProbe.expectedTransition})` : ''}`,
      }
    }

    const classification = classifyComparison(arms, comparison.dimension, comparison.invariantRef)
    const cleanup = await this.#cleanup(comparison, arms, actor, evidenceRefs, engagement.configVersion)

    const now = this.#now().toISOString()
    const transition: ComparisonTransition = { at: now, from: comparison.result, to: classification.result, reason: classification.resultReason, actor: comparisonActor(actor) }
    const patch: ComparisonPatch = {
      status: 'completed',
      arms,
      controls: classification.controls,
      semanticDifferences: classification.semanticDifferences,
      state,
      result: classification.result,
      resultReason: classification.resultReason,
      confidence: classification.confidence,
      invariantEvaluation: classification.invariantEvaluation,
      evidenceRefs: [...evidenceRefs],
      cleanup,
      history: [...comparison.history, transition],
    }
    await this.#patch(comparisonId, patch)

    const level = classification.result === 'inconsistent' ? 'warn' : 'info'
    const type = classification.result === 'inconclusive' ? 'comparison.inconclusive' : 'comparison.completed'
    await this.#event(comparison.engagementId, engagement.configVersion, type, `Comparison on "${comparison.resourceRef}" → ${classification.result}: ${classification.resultReason}`, { comparisonId, result: classification.result }, actor, level)

    // Close the loop: re-project the graph so strong evidence derives facts (CAN_ACCESS) and answers the
    // Phase-5 knowledge gaps, then re-assess the linked hypothesis and the governed invariant.
    await this.#reproject(comparison.engagementId)
    if (comparison.hypothesisId) await reassessBoundaryHypothesis(this.#db, comparison.hypothesisId, actor)
    if (comparison.invariantRef && classification.invariantEvaluation && classification.invariantEvaluation !== 'inconclusive') {
      await this.#event(
        comparison.engagementId,
        engagement.configVersion,
        classification.invariantEvaluation === 'supported' ? 'invariant.supported' : 'invariant.contradicted',
        `Invariant "${comparison.invariantRef}" ${classification.invariantEvaluation} by a controlled comparison on "${comparison.resourceRef}"`,
        { comparisonId, invariantRef: comparison.invariantRef, status: classification.invariantEvaluation },
        actor,
        classification.invariantEvaluation === 'contradicted' ? 'warn' : 'info',
      )
    }
    this.#log?.info({ comparisonId, result: classification.result, dimension: comparison.dimension }, 'differential comparison completed')
    return toComparison((await getComparisonRow(this.#db, comparisonId))!)
  }

  /** Convenience: plan then run (used by the worker and tests). */
  async planAndRun(engagementId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityComparison> {
    const planned = await this.plan(engagementId, input, actor)
    if (planned.status === 'blocked') return planned
    return this.run(planned.id, actor)
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  async #runArm(engagementId: string, arm: ComparisonArm, actor: SecurityActor): Promise<BrokerOutcome> {
    const capabilityId = arm.method === 'GET' || arm.method === 'HEAD' ? 'access.identity-read' : 'access.identity-action'
    const input = capabilityId === 'access.identity-read' ? { url: arm.url, method: arm.method } : { url: arm.url, method: arm.method, ...(arm.body !== null ? { body: arm.body } : {}) }
    return this.#broker.execute({ engagementId, capabilityId, input, actor, ...(arm.identityRef ? { identityRef: arm.identityRef } : {}), ...(arm.sessionRef ? { sessionRef: arm.sessionRef } : {}) })
  }

  #armFromOutcome(arm: ComparisonArm, outcome: BrokerOutcome): ComparisonArm {
    if (outcome.status === 'completed') return { ...arm, status: 'executed', statusReason: null, executionId: outcome.executionId, observation: this.#observation(outcome.evidence, outcome.executionId) }
    if (outcome.status === 'denied') return { ...arm, status: 'blocked', statusReason: outcome.decision.reason, executionId: outcome.executionId, observation: null }
    return { ...arm, status: 'failed', statusReason: outcome.error ?? outcome.status, executionId: outcome.executionId, observation: null }
  }

  #observation(evidence: SecurityEvidenceItem[], executionId: string) {
    for (const item of evidence) {
      const probe = probeFromEvidence(item.metadata)
      if (probe) return normalizeProbe(probe, executionId, [item.ref])
    }
    return null
  }

  /** Reads a resource's current state as the subject identity (a GET), for before/after state capture. */
  async #readState(engagementId: string, url: string, identityRef: string | null, sessionRef: string | null, actor: SecurityActor, evidenceRefs: Set<string>): Promise<import('@audivra/contracts').ComparisonObservation | null> {
    const probe: ComparisonArm = { role: 'baseline', identityRef, sessionRef, resourceRef: '', url, method: 'GET', body: null, expected: { outcome: 'allow', basis: 'observed', invariantRef: null, sourceRef: null, rationale: 'state probe' }, status: 'planned', statusReason: null, executionId: null, observation: null }
    const outcome = await this.#runArm(engagementId, probe, actor)
    for (const ref of outcome.evidence.map((e) => e.ref)) evidenceRefs.add(ref)
    return outcome.status === 'completed' ? this.#observation(outcome.evidence, outcome.executionId) : null
  }

  async #cleanup(comparison: SecurityComparison, arms: ComparisonArm[], actor: SecurityActor, evidenceRefs: Set<string>, configVersion: number): Promise<SecurityComparison['cleanup']> {
    const mutated = arms.some((a) => a.status === 'executed' && a.observation?.stateMutation)
    const planCleanup = comparison.cleanupAction
    if (!mutated || !planCleanup) return { required: mutated, attempted: false, succeeded: mutated ? null : true, detail: mutated ? 'State changed but no cleanup action was provided' : null }
    const session = planCleanup.identityRef ? (await this.#sessions(comparison.engagementId, [planCleanup.identityRef])).get(planCleanup.identityRef) : undefined
    const arm: ComparisonArm = {
      role: 'baseline',
      identityRef: planCleanup.identityRef,
      sessionRef: session?.id ?? null,
      resourceRef: comparison.resourceRef,
      url: planCleanup.url,
      method: planCleanup.method,
      body: planCleanup.body,
      expected: { outcome: 'allow', basis: 'declared', invariantRef: null, sourceRef: null, rationale: 'cleanup' },
      status: 'planned',
      statusReason: null,
      executionId: null,
      observation: null,
    }
    const outcome = await this.#runArm(comparison.engagementId, arm, actor)
    for (const ref of outcome.evidence.map((e) => e.ref)) evidenceRefs.add(ref)
    const succeeded = outcome.status === 'completed' && (outcome.evidence.length === 0 || (this.#observation(outcome.evidence, outcome.executionId)?.status ?? 500) < 400)
    await this.#event(comparison.engagementId, configVersion, 'comparison.cleanup', `Cleanup for comparison on "${comparison.resourceRef}" ${succeeded ? 'succeeded' : 'FAILED'}`, { comparisonId: comparison.id, succeeded }, actor, succeeded ? 'info' : 'warn')
    return { required: true, attempted: true, succeeded, detail: succeeded ? 'Compensating action restored state' : `Cleanup did not succeed (${outcome.status})` }
  }

  async #ensureHypothesis(engagementId: string, plan: ComparisonPlanInput, subjectIdentityRef: string | null, origin: 'ai' | 'user') {
    return ensureBoundaryHypothesis(this.#db, {
      engagementId,
      dimension: plan.dimension,
      resourceRef: plan.resourceRef,
      subjectIdentityRef,
      invariantRef: plan.invariantRef,
      origin,
      claim: this.#title(plan, subjectIdentityRef),
      rationale: plan.reason || `Differential ${plan.dimension} comparison on ${plan.resourceRef}`,
    })
  }

  #title(plan: ComparisonPlanInput, subjectIdentityRef: string | null): string {
    return `${plan.dimension}: can ${subjectIdentityRef ?? 'anonymous'} ${plan.action} "${plan.resourceRef}"?`.slice(0, 200)
  }

  #relationship(ctx: ValidationContext, plan: ComparisonPlanInput, subjectIdentityRef: string | null) {
    const resource = ctx.resources.get(plan.resourceRef)
    const identity = subjectIdentityRef ? ctx.identities.get(subjectIdentityRef) : undefined
    return classifyRelationship({
      dimension: plan.dimension,
      subjectIdentityRef,
      resourceOwnerRef: resource?.ownerRef ?? null,
      subjectTenantRef: identity?.tenantRef ?? null,
      resourceTenantRef: resource?.tenantRef ?? null,
    })
  }

  async #context(engagementId: string, engagement: NonNullable<Awaited<ReturnType<typeof getEngagementRow>>>, plan: ComparisonPlanInput): Promise<ValidationContext> {
    const [resources, identities] = await Promise.all([listDomainDeclarationRows(this.#db, engagementId, { kind: 'resource' }), listDomainDeclarationRows(this.#db, engagementId, { kind: 'identity' })])
    const identityRefs = [...new Set(plan.arms.map((a) => a.identityRef).filter((r): r is string => !!r))]
    const sessions = await this.#sessions(engagementId, identityRefs)
    const policy = this.#policy(engagement)
    const str = (spec: Record<string, unknown>, key: string): string | null => (typeof spec[key] === 'string' && (spec[key] as string).trim() ? (spec[key] as string).trim() : null)
    return {
      engagement: { id: engagement.id, status: engagement.status, environment: engagement.environment, scope: engagement.scope },
      identities: new Map(identities.map((d) => [d.ref, { ref: d.ref, tenantRef: str(d.spec, 'tenantRef') }])),
      resources: new Map(resources.map((d) => [d.ref, { ref: d.ref, ownerRef: str(d.spec, 'ownerRef'), tenantRef: str(d.spec, 'tenantRef'), testData: str(d.spec, 'testData') ?? 'unknown' }])),
      sessions: new Map([...sessions].map(([ref, s]) => [ref, { id: s.id, identityRef: ref, status: s.status, expiresAt: s.expiresAt }])),
      policy,
      now: this.#now().getTime(),
    }
  }

  #policy(engagement: NonNullable<Awaited<ReturnType<typeof getEngagementRow>>>): EnvironmentPolicy {
    const profile = findPolicyProfile(engagement.policyProfileKey, engagement.policyProfileVersion)
    const env = engagement.environment ?? 'production'
    if (!profile) throw new SecurityRequestError(409, `Unknown policy profile ${engagement.policyProfileKey} v${engagement.policyProfileVersion}`)
    return profile.environments[env]
  }

  async #sessions(engagementId: string, identityRefs: string[]): Promise<Map<string, { id: string; status: string; expiresAt: number | null }>> {
    const now = this.#now().getTime()
    const out = new Map<string, { id: string; status: string; expiresAt: number | null }>()
    for (const ref of new Set(identityRefs)) {
      const rows = await listSessionRows(this.#db, engagementId, { identityRef: ref })
      const active = rows.find((r) => r.status === 'active' && r.sealed !== null && (!r.expiresAt || r.expiresAt.getTime() > now))
      if (active) out.set(ref, { id: active.id, status: active.status, expiresAt: active.expiresAt ? active.expiresAt.getTime() : null })
    }
    return out
  }

  async #patch(comparisonId: string, patch: ComparisonPatch): Promise<void> {
    await updateComparison(this.#db, comparisonId, patch)
  }

  async #reproject(engagementId: string): Promise<void> {
    try {
      await this.#projector.project(engagementId)
    } catch (error) {
      // Projection is deterministic and repeatable; a failure must not fail (or roll back) a stored comparison.
      this.#log?.warn({ engagementId, error: error instanceof Error ? error.message : String(error) }, 'graph projection after comparison failed')
    }
  }

  async #event(engagementId: string, configVersion: number, type: Parameters<typeof recordSecurityEvent>[1]['type'], message: string, data: Record<string, unknown>, actor: SecurityActor, level: 'info' | 'warn' = 'info'): Promise<void> {
    await recordSecurityEvent(this.#db, { engagementId, type, level, message, actor, configVersion, data })
  }
}
