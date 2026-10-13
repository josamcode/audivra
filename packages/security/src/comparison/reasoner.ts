import { randomUUID } from 'node:crypto'
import type { Logger } from '@audivra/config'
import { ComparisonPlannerOutput, type ProposedComparison, type ReasoningMode, type SecurityActor } from '@audivra/contracts'
import { getEngagementRow, type Db } from '@audivra/database'
import { jsonSection, REASONING_TASKS, reasoningJsonSchema, type ReasoningAi } from '../reasoning/ai.ts'
import { LOCAL_USER } from '../service.ts'
import type { ComparisonEngine } from './engine.ts'
import { proposeComparisons, validateProposedComparison, type PlannerInput } from './plan.ts'
import type { ComparisonService } from './service.ts'

/*
 * Phase 5 Step 5 — the comparison reasoning pass that closes the Phase 4 loop for authorization/business
 * boundaries: graph gap → boundary hypothesis → comparison proposal → validated comparison → execution →
 * graph derivation → invariant/hypothesis update. The deterministic planner always runs (so the pass works
 * with the AI provider unavailable or refusing); an optional AI proposer may add comparisons, but EVERY AI
 * proposal passes the same deterministic validation (no invented identity/resource/ownership) before it can
 * run, and provider refusal/unavailability is never rerouted. In `investigate` mode proposals run; in
 * `propose` mode they are planned and queued for a person.
 */

export interface ComparisonReasoningResult {
  mode: ReasoningMode
  deterministicProposed: number
  aiOutcome: 'succeeded' | 'provider-unavailable' | 'provider-refused' | 'ai-output-invalid' | 'not-required'
  aiProposed: number
  aiAccepted: number
  aiRejected: Record<string, number>
  planned: number
  executed: number
  blocked: number
  /** Candidate-pruning stats (proof the planner avoids a Cartesian explosion). */
  pruning: { cartesian: number; candidates: number; proposed: number; discarded: Record<string, number> }
}

export interface ComparisonReasonerOptions {
  db: Db
  engine: ComparisonEngine
  service: ComparisonService
  /** Optional AI proposer (the Phase 3C router, wired by the worker). Absent → deterministic only. */
  ai?: ReasoningAi
  now?: () => Date
  log?: Logger
}

export class ComparisonReasoner {
  readonly #db: Db
  readonly #engine: ComparisonEngine
  readonly #service: ComparisonService
  readonly #ai: ReasoningAi | undefined
  readonly #log: Logger | undefined

  constructor(options: ComparisonReasonerOptions) {
    this.#db = options.db
    this.#engine = options.engine
    this.#service = options.service
    this.#ai = options.ai
    this.#log = options.log
  }

  /** Proposes (and, in investigate mode, runs) useful comparisons for the engagement, closing the loop. */
  async drive(engagementId: string, options: { mode?: ReasoningMode; limit?: number; actor?: SecurityActor; signal?: AbortSignal } = {}): Promise<ComparisonReasoningResult> {
    const mode = options.mode ?? 'propose'
    const actor = options.actor ?? LOCAL_USER
    const engagement = await getEngagementRow(this.#db, engagementId)
    if (!engagement) throw new Error(`No security engagement ${engagementId}`)
    const input = await this.#service.plannerInput(engagementId, engagement.environment)

    // Deterministic planner (always available).
    const { plans, stats } = proposeComparisons(input, options.limit ?? 6)
    const accepted = plans.map((p) => p.plan)

    // AI proposals (optional), each deterministically validated before it can run.
    let aiOutcome: ComparisonReasoningResult['aiOutcome'] = this.#ai ? 'succeeded' : 'not-required'
    let aiProposed = 0
    let aiAccepted = 0
    const aiRejected: Record<string, number> = {}
    if (this.#ai) {
      const result = await this.#propose(engagementId, input, options.signal)
      aiOutcome = result.outcome
      for (const proposal of result.proposals) {
        aiProposed++
        const verdict = validateProposedComparison(proposal, input)
        if (!verdict.ok) {
          aiRejected[verdict.reason] = (aiRejected[verdict.reason] ?? 0) + 1
          continue
        }
        accepted.push(verdict.plan)
        aiAccepted++
      }
    }

    // Dedupe the merged set and plan/run per mode.
    const seen = new Set<string>()
    let planned = 0
    let executed = 0
    let blocked = 0
    for (const plan of accepted) {
      const key = `${plan.dimension}|${plan.resourceRef}|${plan.action}|${plan.arms.map((a) => `${a.role}:${a.identityRef ?? 'anon'}`).sort().join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      const comparison = mode === 'investigate' ? await this.#engine.planAndRun(engagementId, plan, actor) : await this.#engine.plan(engagementId, plan, actor)
      planned++
      if (comparison.status === 'blocked') blocked++
      else if (comparison.status === 'completed') executed++
    }

    this.#log?.info({ engagementId, mode, planned, executed, blocked, aiOutcome }, 'comparison reasoning pass complete')
    return { mode, deterministicProposed: plans.length, aiOutcome, aiProposed, aiAccepted, aiRejected, planned, executed, blocked, pruning: stats }
  }

  async #propose(engagementId: string, input: PlannerInput, signal?: AbortSignal): Promise<{ outcome: ComparisonReasoningResult['aiOutcome']; proposals: ProposedComparison[] }> {
    const task = REASONING_TASKS.comparisonPlanner
    const trusted = [
      jsonSection('identities', input.identities.map((i) => ({ ref: i.ref, tenant: i.tenantRef, roles: i.roleRefs, hasSession: i.hasSession }))),
      jsonSection('resources', input.resources.map((r) => ({ ref: r.ref, url: r.url, owner: r.ownerRef, tenant: r.tenantRef, testData: r.testData }))),
      jsonSection('roles', input.roles),
      jsonSection('actions', input.actions.map((a) => ({ ref: a.ref, verb: a.verb, endpointUrl: a.endpointUrl, method: a.method, requiredRoleRefs: a.requiredRoleRefs }))),
      jsonSection('invariants', input.invariants),
      jsonSection('open gaps', input.openGaps),
      jsonSection('existing comparisons', [...input.existingDedupeKeys]),
    ]
    try {
      const result = await this.#ai!.run({
        spec: task.spec,
        prompt: task.prompt,
        context: { trusted, untrusted: [] },
        instruction: 'Propose the most useful authorization/business comparisons to run next. Reference only the listed identities, resources, roles, actions and invariants; never invent any. Always include a control arm.',
        jsonSchema: reasoningJsonSchema('comparisonPlanner'),
        engagementId,
        runId: `cmp-${randomUUID().slice(0, 8)}`,
        signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs),
      })
      if (result.outcome !== 'succeeded') return { outcome: result.refused ? 'provider-refused' : result.outcome === 'provider-unavailable' ? 'provider-unavailable' : 'ai-output-invalid', proposals: [] }
      const parsed = ComparisonPlannerOutput.safeParse(result.output)
      if (!parsed.success) return { outcome: 'ai-output-invalid', proposals: [] }
      return { outcome: 'succeeded', proposals: parsed.data.comparisons }
    } catch (error) {
      this.#log?.warn({ engagementId, error: error instanceof Error ? error.message : String(error) }, 'comparison AI proposal failed; using deterministic plan only')
      return { outcome: 'provider-unavailable', proposals: [] }
    }
  }
}
