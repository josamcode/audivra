import { randomUUID } from 'node:crypto'
import type { Logger } from '@audivra/config'
import {
  AI_RELATION_TYPES,
  emptyReasoningUsage,
  INFERRED_CONFIDENCE_CAP,
  isTerminalExecutionStatus,
  PlannerOutput,
  ResearcherOutput,
  StartReasoningInput,
  VerifierOutput,
  type AiCoverageState,
  type HypothesisStatus,
  type ProposedHypothesis,
  type ProposedRelationship,
  type ReasoningRun,
  type ReasoningStage,
  type ReasoningStopReason,
  type SecurityActor,
  type SecurityEventType,
  type SecurityHypothesis,
  type SensorResult,
} from '@audivra/contracts'
import {
  addHypothesisLinks,
  claimReasoningRun,
  findSecurityExecutionByCorrelation,
  getEngagementRow,
  getReasoningRunRow,
  getSecurityExecutionRow,
  heartbeatReasoningRun,
  insertGraphEdges,
  insertGraphProvenance,
  insertHypothesis,
  insertReasoningAction,
  insertReasoningRun,
  listReasoningActionRows,
  listReasoningRunRows,
  listRunsWaitingOn,
  listUnfinishedReasoningRuns,
  loadGraphRows,
  newGraphEdgeId,
  newGraphProvenanceId,
  newHypothesisId,
  newReasoningActionId,
  newReasoningRunId,
  recordSecurityEvent,
  toReasoningRun,
  updateHypothesis,
  updateReasoningAction,
  updateReasoningRun,
  withGraphLock,
  type Db,
  type ReasoningRunRow,
} from '@audivra/database'
import type { CapabilityBroker } from '../broker.ts'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import { requestExecutionCancel } from '../execution/control.ts'
import { createDbExecutionStore } from '../execution/store.ts'
import { edgeKey } from '../graph/identity.ts'
import { GraphProjector } from '../graph/projector.ts'
import { SecurityRequestError } from '../service.ts'
import { createDbSecurityStore } from '../store.ts'
import { REASONING_TASKS, reasoningJsonSchema, type ReasoningAi, type ReasoningAiResult, type ReasoningTaskName } from './ai.ts'
import { plannerContext, researcherContext, verifierContext } from './context.ts'
import { assessChecks, evaluateCheck, isOpenHypothesis, validateProposal, type ProposalVerdict } from './hypotheses.ts'
import { COST_UNITS, loadKnowledge, observationsAbout, type KnowledgeView } from './knowledge.ts'
import { autoExecutable, validateAction } from './planning.ts'
import { capabilityFits, LOW_GAIN_THRESHOLD, rankHypothesis } from './ranking.ts'

/*
 * The bounded reasoning loop, as a persisted state machine. Every stage boundary is written to
 * `security_reasoning_runs` before the next stage starts, so a run survives a worker restart, a lost AI
 * session or a provider change: whoever claims the run next resumes at the stored stage with context
 * rebuilt from stored knowledge.
 *
 *   ingest   project observations into the graph (deterministic)
 *   assess   evaluate every open hypothesis' evidence checks → supported / confirmed / disproved / exhausted
 *   generate AI researcher → validated, deduplicated hypotheses (+ optional relationship enrichment);
 *            AI verifier reviews them
 *   rank     deterministic priority and expected information gain
 *   plan     AI planner → typed actions → validation → broker preflight (approved-by-policy / blocked)
 *   execute  [investigate mode] auto-eligible approved actions → broker.submit (the only path to running)
 *   await    wait for the executions → back to ingest
 *
 * Strict limits: iterations, AI calls, actions, cost units and wall time. The AI never executes anything;
 * the broker decides, and AI failure only pauses AI work — it never corrupts the graph or hypotheses.
 */

const MAX_ATTEMPTS = 2
const LEASE_MS = 120_000
const HEARTBEAT_MS = 20_000
const MAX_DECISIONS = 120
const MAX_AI_RUNS = 40
/** Hard bound on stage transitions per drive (a run waits for executions long before reaching it). */
const MAX_STEPS_PER_DRIVE = 40

const AI_BLOCKING: Record<string, ReasoningStopReason> = {
  'provider-unavailable': 'provider-unavailable',
  'provider-timeout': 'provider-unavailable',
  'rate-limited': 'provider-unavailable',
  'auth-failed': 'provider-unavailable',
  'tool-failure': 'provider-unavailable',
  'context-limit': 'provider-unavailable',
  'internal-error': 'provider-unavailable',
  cancelled: 'cancelled',
  'provider-refused': 'provider-refused',
  'invalid-structured-output': 'ai-output-invalid',
}

export interface ReasoningEngineOptions {
  db: Db
  /** A broker able to `submit` durable executions (and `preflight`). */
  broker: CapabilityBroker
  /** The AI port; null when AI is turned off (only deterministic work happens). */
  ai: ReasoningAi | null
  registry?: CapabilityRegistry
  projector?: GraphProjector
  now?: () => Date
  log?: Logger
  /** Lease owner id of this driver (default: a random id per engine). */
  ownerId?: string
  /** Called when a run should be driven (the worker queues a job); absent: callers drive explicitly. */
  enqueue?: (runId: string) => Promise<void>
}

interface StepResult {
  run: ReasoningRunRow
  stop: boolean
}

type Usage = ReasoningRun['usage']

export class ReasoningEngine {
  readonly #db: Db
  readonly #broker: CapabilityBroker
  readonly #ai: ReasoningAi | null
  readonly #registry: CapabilityRegistry
  readonly #projector: GraphProjector
  readonly #now: () => Date
  readonly #log: Logger | undefined
  readonly #ownerId: string
  readonly #enqueue: ((runId: string) => Promise<void>) | undefined

  constructor(options: ReasoningEngineOptions) {
    this.#db = options.db
    this.#broker = options.broker
    this.#ai = options.ai
    this.#registry = options.registry ?? options.broker.registry
    this.#projector = options.projector ?? new GraphProjector({ db: options.db, log: options.log })
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
    this.#ownerId = options.ownerId ?? `reasoning-${randomUUID()}`
    this.#enqueue = options.enqueue
  }

  get projector(): GraphProjector {
    return this.#projector
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────────

  /** Creates a bounded run (queued). Only people and Audivra start reasoning; an agent never does. */
  async start(engagementId: string, input: unknown, actor: SecurityActor): Promise<ReasoningRun> {
    if (actor.kind === 'agent') throw new SecurityRequestError(403, 'Agents cannot start reasoning runs')
    const parsed = StartReasoningInput.safeParse(input ?? {})
    if (!parsed.success) throw new SecurityRequestError(400, parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
    const engagement = /^[0-9a-z]{6,32}$/.test(engagementId) ? await getEngagementRow(this.#db, engagementId) : undefined
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    if (engagement.status === 'completed' || engagement.status === 'cancelled') throw new SecurityRequestError(409, `The engagement is ${engagement.status}`)
    const active = (await listReasoningRunRows(this.#db, engagementId, 10)).find((r) => r.status === 'queued' || r.status === 'running' || r.status === 'waiting')
    if (active) throw new SecurityRequestError(409, `A reasoning run is already in progress (${active.id})`)
    const budget = { maxIterations: 3, maxAiCalls: 9, maxActions: 3, wallClockMs: 30 * 60_000, maxCostUnits: 6, ...parsed.data.budget }
    const row = await insertReasoningRun(this.#db, {
      id: newReasoningRunId(),
      engagementId,
      mode: parsed.data.mode,
      status: 'queued',
      stage: 'ingest',
      iteration: 0,
      budget,
      usage: emptyReasoningUsage(),
      decisions: [],
      aiRuns: [],
      waitingOn: [],
      requestedBy: actor,
    })
    await this.#event(row, 'reasoning.started', `Reasoning run started (${row.mode} mode; up to ${budget.maxIterations} iterations, ${budget.maxAiCalls} AI calls, ${budget.maxActions} actions)`, { runId: row.id, mode: row.mode, budget }, 'info', actor)
    if (this.#enqueue) await this.#enqueue(row.id)
    return toReasoningRun(row)
  }

  /** Requests cancellation: a queued/waiting run stops now (and its in-flight executions are cancelled). */
  async cancel(runId: string, actor: SecurityActor): Promise<ReasoningRun> {
    const row = await getReasoningRunRow(this.#db, runId)
    if (!row) throw new SecurityRequestError(404, 'Reasoning run not found')
    if (['completed', 'blocked', 'failed', 'cancelled'].includes(row.status)) return toReasoningRun(row)
    const now = this.#now()
    const marked = (await updateReasoningRun(this.#db, runId, { from: ['queued', 'running', 'waiting'] }, { cancelRequestedAt: now })) ?? row
    if (marked.status === 'queued' || marked.status === 'waiting') {
      const finished = await this.#finish(marked, 'cancelled', `Cancelled by ${actor.kind === 'user' ? 'the user' : actor.kind}`, null)
      return toReasoningRun(finished)
    }
    return toReasoningRun(marked)
  }

  /** Runs whose awaited executions have all settled after `executionId` finished (to be driven again). */
  async executionSettled(executionId: string): Promise<string[]> {
    const ready: string[] = []
    for (const run of await listRunsWaitingOn(this.#db, executionId)) {
      if (await this.#allSettled(run.waitingOn)) ready.push(run.id)
    }
    return ready
  }

  /** Whether a waiting run's executions have all settled (it can be driven again). */
  async readyToResume(runId: string): Promise<boolean> {
    const run = await getReasoningRunRow(this.#db, runId)
    return !!run && run.status === 'waiting' && (await this.#allSettled(run.waitingOn))
  }

  /** Runs to (re)drive after a restart: queued, abandoned (expired lease) or waiting on settled executions. */
  async recover(): Promise<string[]> {
    const expired = this.#now().getTime() - LEASE_MS
    const ids: string[] = []
    for (const run of await listUnfinishedReasoningRuns(this.#db)) {
      if (run.status === 'queued') ids.push(run.id)
      else if (run.status === 'running' && (!run.heartbeatAt || run.heartbeatAt.getTime() < expired)) ids.push(run.id)
      else if (run.status === 'waiting' && (await this.#allSettled(run.waitingOn))) ids.push(run.id)
    }
    return ids
  }

  /**
   * Claims the run and advances it until it must wait for executions or reaches a stopping condition.
   * A run another driver holds (live lease) is left alone.
   */
  async drive(runId: string, options: { signal?: AbortSignal } = {}): Promise<ReasoningRun | null> {
    const claimed = await claimReasoningRun(this.#db, runId, this.#ownerId, new Date(this.#now().getTime() - LEASE_MS))
    if (!claimed) {
      const row = await getReasoningRunRow(this.#db, runId)
      return row ? toReasoningRun(row) : null
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason ?? new Error('Stopped'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const heartbeat = setInterval(() => {
      void (async () => {
        const alive = await heartbeatReasoningRun(this.#db, runId, this.#ownerId).catch(() => false)
        const current = await getReasoningRunRow(this.#db, runId).catch(() => undefined)
        if (!alive || current?.cancelRequestedAt) controller.abort(new Error(current?.cancelRequestedAt ? 'Cancelled' : 'Lease lost'))
      })()
    }, HEARTBEAT_MS)
    let run = claimed
    try {
      for (let step = 0; step < MAX_STEPS_PER_DRIVE; step++) {
        const fresh = await getReasoningRunRow(this.#db, runId)
        if (!fresh || fresh.leaseOwner !== this.#ownerId || fresh.status !== 'running') return fresh ? toReasoningRun(fresh) : null
        run = fresh
        if (run.cancelRequestedAt || controller.signal.aborted) return toReasoningRun(await this.#finish(run, 'cancelled', 'Cancelled', null))
        const started = performance.now()
        const stage = run.stage
        const result = await this.#step(run, controller.signal)
        run = await this.#addStageTime(result.run, stage, performance.now() - started)
        if (result.stop) return toReasoningRun(run)
      }
      return toReasoningRun(await this.#finish(run, 'internal-error', 'The run exceeded its step bound', null))
    } catch (error) {
      if (controller.signal.aborted) {
        const current = (await getReasoningRunRow(this.#db, runId)) ?? run
        if (current.cancelRequestedAt) return toReasoningRun(await this.#finish(current, 'cancelled', 'Cancelled', null))
        // The driver is stopping (or lost its lease): hand the run back at its persisted stage so the next
        // driver resumes it at once. A run another driver now holds is left untouched.
        const released = await updateReasoningRun(this.#db, runId, { from: ['running'], leaseOwner: this.#ownerId }, { status: 'queued', leaseOwner: null, heartbeatAt: null })
        return toReasoningRun(released ?? current)
      }
      this.#log?.error({ err: error, runId }, 'reasoning run failed')
      const current = (await getReasoningRunRow(this.#db, runId)) ?? run
      return toReasoningRun(await this.#finish(current, 'internal-error', error instanceof Error ? error.message.slice(0, 400) : String(error), null))
    } finally {
      clearInterval(heartbeat)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Drives a run to a final state, waiting (polling) for its executions in between. For tests, scripts and E2E. */
  async runToCompletion(runId: string, options: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ReasoningRun> {
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000)
    for (;;) {
      const run = await this.drive(runId, { signal: options.signal })
      if (!run) throw new Error(`Reasoning run ${runId} not found`)
      if (['completed', 'blocked', 'failed', 'cancelled'].includes(run.status)) return run
      if (Date.now() > deadline) throw new Error(`Reasoning run ${runId} did not finish in time (status ${run.status}, stage ${run.stage})`)
      await new Promise((r) => setTimeout(r, options.pollMs ?? 500))
      if (run.status === 'waiting') {
        const row = await getReasoningRunRow(this.#db, runId)
        if (row && !(await this.#allSettled(row.waitingOn))) continue
      }
    }
  }

  // ── Stages ─────────────────────────────────────────────────────────────────────────────────────────

  async #step(run: ReasoningRunRow, signal: AbortSignal): Promise<StepResult> {
    switch (run.stage) {
      case 'ingest':
        return this.#ingest(run)
      case 'assess':
        return this.#assess(run)
      case 'generate':
        return this.#generate(run, signal)
      case 'rank':
        return this.#rank(run)
      case 'plan':
        return this.#plan(run, signal)
      case 'execute':
        return this.#execute(run)
      case 'await':
        return this.#await(run)
      case 'done':
        return { run, stop: true }
    }
  }

  async #ingest(run: ReasoningRunRow): Promise<StepResult> {
    const r = await this.#projector.project(run.engagementId)
    const message = `Graph projected from ${r.observations} observations: +${r.nodes.added} entities, +${r.edges.added} relationships, ${r.gaps.opened} new unknowns, ${r.gaps.resolved} answered, ${r.contradictions} contradiction${r.contradictions === 1 ? '' : 's'}`
    return this.#advance(run, 'assess', message)
  }

  async #assess(run: ReasoningRunRow): Promise<StepResult> {
    const view = await this.#view(run)
    let changed = 0
    for (const h of view.hypotheses.filter(isOpenHypothesis)) {
      const outcome = assessChecks(h.evidenceChecks, view)
      const attempts = view.actions.filter((a) => a.hypothesisId === h.id && (a.status === 'completed' || a.status === 'failed')).length
      const supporting = outcome.results.filter((r) => r.met && r.effect === 'supports').flatMap((r) => r.observationIds)
      const contradicting = outcome.results.filter((r) => r.met && r.effect === 'contradicts').flatMap((r) => r.observationIds)
      await addHypothesisLinks(this.#db, run.engagementId, h.id, [
        ...supporting.map((id) => ({ role: 'supports' as const, targetType: 'observation' as const, targetId: id, addedBy: 'audivra' as const, note: 'Satisfied an evidence check' })),
        ...contradicting.map((id) => ({ role: 'contradicts' as const, targetType: 'observation' as const, targetId: id, addedBy: 'audivra' as const, note: 'Satisfied a contradicting check' })),
      ])
      let to: HypothesisStatus | null = outcome.status
      let reason = outcome.reason
      if (outcome.status === 'supported' && h.status === 'supported') to = null
      if (!to && attempts > 0) {
        // Not resolved by the evidence its actions gathered: exhausted after the attempt limit or when every
        // eligible capability has been tried.
        const fits = capabilityFits(h, outcome.results, view)
        if (attempts >= MAX_ATTEMPTS || fits.every((f) => f.previouslyTried)) {
          to = 'exhausted'
          reason = `Investigated ${attempts} time${attempts === 1 ? '' : 's'}; the evidence it needs did not appear (${outcome.results.filter((r) => !r.met).map((r) => r.detail).join('; ')})`
        }
      }
      const resultsChanged = JSON.stringify(outcome.results) !== JSON.stringify(h.checkResults)
      if (to && to !== h.status) {
        await this.#transition(run, h, to, reason, { confidence: outcome.confidence ?? h.confidence, checkResults: outcome.results, attempts })
        changed++
      } else if (resultsChanged || attempts !== h.attempts) {
        await updateHypothesis(this.#db, h.id, { checkResults: outcome.results, attempts })
      }
    }
    return this.#advance(run, 'generate', changed ? `Evidence checks updated ${changed} hypothes${changed === 1 ? 'is' : 'es'}` : 'Evidence checks: no hypothesis changed state')
  }

  async #generate(run: ReasoningRunRow, signal: AbortSignal): Promise<StepResult> {
    const view = await this.#view(run)
    const open = view.hypotheses.filter(isOpenHypothesis)
    if (this.#overTime(run)) return this.#stopNow(run, 'budget-exhausted', 'Wall-clock budget reached')
    if (run.iteration >= run.budget.maxIterations) {
      return this.#stopNow(run, open.length ? 'budget-exhausted' : 'sufficient-evidence', open.length ? `Iteration budget (${run.budget.maxIterations}) reached with ${open.length} open hypothes${open.length === 1 ? 'is' : 'es'}` : 'Every hypothesis is resolved')
    }
    run = await this.#save(run, { iteration: run.iteration + 1 }, 'generate', `Iteration ${run.iteration + 1} of ${run.budget.maxIterations}`)
    if (!this.#ai) return this.#advance(run, 'rank', 'AI is turned off: hypothesis generation is paused; deterministic graph and evidence checks continue')
    if (run.usage.aiCalls >= run.budget.maxAiCalls) return this.#advance(run, 'rank', 'AI call budget reached: no new hypotheses this iteration')
    const openGaps = [...view.gaps.values()].filter((g) => g.status === 'open' && g.answeredBy.length > 0)
    if (openGaps.length === 0 && view.nodes.size === 0) return this.#advance(run, 'rank', 'Nothing observed yet: no hypotheses to generate')

    const researcher = researcherContext(view)
    const result = await this.#runAi(run, 'researcher', researcher.context, researcher.instruction, signal)
    run = result.run
    if (result.outcome.outcome !== 'succeeded') {
      if (result.outcome.refused) return this.#stopNow(run, 'provider-refused', 'The AI provider declined the hypothesis task under its own policy; the graph and hypotheses are unchanged')
      return this.#advance(run, 'rank', `Hypothesis generation did not complete (${result.outcome.outcome}); continuing with existing hypotheses`, { aiProblem: result.outcome.outcome })
    }
    const parsed = ResearcherOutput.safeParse(result.outcome.output)
    if (!parsed.success) {
      await this.#markAiInvalid(run)
      return this.#advance(run, 'rank', `Researcher output failed schema validation (${parsed.error.issues[0]?.message ?? 'invalid'}); nothing was persisted from it`, { aiProblem: 'invalid-structured-output' })
    }
    const { accepted, merged, rejected } = await this.#reviewAndPersist(run, view, parsed.data.hypotheses, result.outcome, signal)
    const relationships = await this.#persistRelationships(run, view, parsed.data.relationships)
    run = (await getReasoningRunRow(this.#db, run.id))!
    const q = run.usage.quality
    const usage: Usage = {
      ...run.usage,
      quality: {
        ...q,
        hypothesesProposed: q.hypothesesProposed + parsed.data.hypotheses.length,
        hypothesesAccepted: q.hypothesesAccepted + accepted,
        hypothesesMerged: q.hypothesesMerged + merged,
        hypothesesRejected: addCounts(q.hypothesesRejected, rejected),
        relationshipsAccepted: q.relationshipsAccepted + relationships.accepted,
        relationshipsRejected: q.relationshipsRejected + relationships.rejected,
      },
    }
    const rejectedText = Object.entries(rejected).map(([k, n]) => `${n} ${k}`).join(', ')
    return this.#advance(run, 'rank', `Researcher proposed ${parsed.data.hypotheses.length}: ${accepted} accepted, ${merged} merged as duplicates, ${Object.values(rejected).reduce((a, b) => a + b, 0)} rejected${rejectedText ? ` (${rejectedText})` : ''}; ${relationships.accepted} inferred relationship${relationships.accepted === 1 ? '' : 's'} added`, { usage })
  }

  async #rank(run: ReasoningRunRow): Promise<StepResult> {
    const view = await this.#view(run)
    const now = this.#now().toISOString()
    const open = view.hypotheses.filter(isOpenHypothesis)
    if (open.length === 0) {
      const ever = view.hypotheses.length > 0
      const aiProblem = lastAiProblem(run)
      if (!ever && aiProblem) return this.#stopNow(run, AI_BLOCKING[aiProblem] ?? 'provider-unavailable', `No hypotheses exist and AI work did not complete (${aiProblem}); deterministic graph data remains available`)
      if (!ever && !this.#ai) return this.#stopNow(run, 'provider-unavailable', 'AI is turned off and no hypotheses exist yet; the graph and its unknowns remain available')
      return this.#stopNow(run, ever ? 'sufficient-evidence' : 'nothing-to-investigate', ever ? 'Every hypothesis is resolved' : 'No hypothesis worth investigating was found')
    }
    const candidates: SecurityHypothesis[] = []
    for (const h of open) {
      const ranking = rankHypothesis(h, view, now)
      const best = view.capabilities.find((c) => c.id === ranking.bestCapabilityId) ?? null
      let status: HypothesisStatus = h.status
      let reason = h.statusReason
      if (!ranking.factors.environmentEligible) {
        status = h.attempts > 0 ? 'exhausted' : 'blocked'
        reason = ranking.explanation
      } else if (ranking.expectedInformationGain < LOW_GAIN_THRESHOLD) {
        status = 'deferred'
        reason = `Expected information gain ${ranking.expectedInformationGain.toFixed(2)} is below ${LOW_GAIN_THRESHOLD}: ${ranking.explanation}`
      } else if (h.status === 'proposed' || h.status === 'deferred' || h.status === 'blocked') {
        status = 'needs-evidence'
        reason = ranking.explanation
      }
      await updateHypothesis(this.#db, h.id, { ranking, priority: ranking.priority, expectedInformationGain: ranking.expectedInformationGain, estimatedCost: best?.costClass ?? null, executionRisk: best?.riskClass ?? null })
      if (status !== h.status) await this.#transition(run, { ...h, ranking }, status, reason)
      if (status === 'needs-evidence' || status === 'supported') candidates.push({ ...h, status, ranking, priority: ranking.priority } as SecurityHypothesis)
    }
    if (candidates.length === 0) {
      const deferred = open.some((h) => (h.ranking?.expectedInformationGain ?? 1) < LOW_GAIN_THRESHOLD)
      const fresh = await this.#view(run)
      const stillDeferred = fresh.hypotheses.some((h) => h.status === 'deferred')
      return this.#stopNow(run, stillDeferred || deferred ? 'low-information-gain' : 'no-eligible-capability', stillDeferred ? 'The remaining hypotheses would teach too little for their cost' : 'No capability that may run here can produce the evidence the open hypotheses need')
    }
    candidates.sort((a, b) => (b.ranking?.priority ?? 0) - (a.ranking?.priority ?? 0) || a.id.localeCompare(b.id))
    const top = candidates[0]!
    return this.#advance(run, 'plan', `Ranked ${open.length} open hypothes${open.length === 1 ? 'is' : 'es'}; top: "${top.claim.slice(0, 120)}" (priority ${top.ranking?.priority}, expected gain ${top.ranking?.expectedInformationGain.toFixed(2)})`)
  }

  async #plan(run: ReasoningRunRow, signal: AbortSignal): Promise<StepResult> {
    const aiProblem = lastAiProblem(run)
    if (!this.#ai) return this.#stopNow(run, 'provider-unavailable', 'AI is turned off: planning is paused. Existing hypotheses, the graph and deterministic coverage remain available')
    if (aiProblem && AI_BLOCKING[aiProblem] && aiProblem !== 'invalid-structured-output') {
      return this.#stopNow(run, AI_BLOCKING[aiProblem]!, `AI is unavailable (${aiProblem}): planning is paused; nothing in the graph or hypotheses was changed by the failure`)
    }
    if (this.#overTime(run)) return this.#stopNow(run, 'budget-exhausted', 'Wall-clock budget reached')
    if (run.usage.aiCalls >= run.budget.maxAiCalls) return this.#stopNow(run, 'budget-exhausted', 'AI call budget reached before planning')
    if (run.mode === 'investigate' && (run.usage.actionsExecuted >= run.budget.maxActions || run.usage.costUnits >= run.budget.maxCostUnits)) {
      return this.#stopNow(run, 'budget-exhausted', 'Action or cost budget reached')
    }
    const view = await this.#view(run)
    const ranked = view.hypotheses.filter((h) => h.status === 'needs-evidence' || h.status === 'supported').sort((a, b) => (b.ranking?.priority ?? 0) - (a.ranking?.priority ?? 0) || a.id.localeCompare(b.id))
    const planner = plannerContext(view, ranked)
    const result = await this.#runAi(run, 'planner', planner.context, planner.instruction, signal)
    run = result.run
    if (result.outcome.outcome !== 'succeeded') {
      const reason = AI_BLOCKING[result.outcome.outcome] ?? 'provider-unavailable'
      return this.#stopNow(run, reason, result.outcome.refused ? 'The AI provider declined the planning task; no action was proposed' : `Planning did not complete (${result.outcome.outcome}); no action was proposed`)
    }
    const parsed = PlannerOutput.safeParse(result.outcome.output)
    if (!parsed.success) {
      await this.#markAiInvalid(run)
      return this.#stopNow(run, 'ai-output-invalid', `Planner output failed schema validation (${parsed.error.issues[0]?.message ?? 'invalid'}); nothing was proposed`)
    }

    const planned = new Set<string>()
    const rejected: Record<string, number> = {}
    let approved = 0
    let blocked = 0
    const summaries: string[] = []
    for (const action of parsed.data.actions) {
      const verdict = validateAction(action, view, this.#registry, planned)
      if (verdict.kind === 'reject') {
        rejected[verdict.reason] = (rejected[verdict.reason] ?? 0) + 1
        await insertReasoningAction(this.#db, {
          id: newReasoningActionId(),
          engagementId: run.engagementId,
          runId: run.id,
          hypothesisId: verdict.hypothesis?.id ?? null,
          capabilityId: action.capabilityId.slice(0, 120),
          input: action.input,
          actionKey: verdict.actionKey ?? `${action.capabilityId.slice(0, 80)}:invalid`,
          expectedEvidence: action.expectedEvidence,
          reason: action.reason,
          status: 'rejected',
          statusReason: `${verdict.reason}: ${verdict.detail}`,
          costClass: view.capabilities.find((c) => c.id === action.capabilityId)?.costClass ?? null,
        })
        summaries.push(`${action.capabilityId} rejected (${verdict.reason})`)
        continue
      }
      planned.add(verdict.actionKey)
      const decision = await this.#broker.preflight({ engagementId: run.engagementId, capabilityId: verdict.capability.id, input: verdict.input, actor: this.#agent(run) })
      const allowed = decision.decision === 'allow'
      if (allowed) approved++
      else blocked++
      await insertReasoningAction(this.#db, {
        id: newReasoningActionId(),
        engagementId: run.engagementId,
        runId: run.id,
        hypothesisId: verdict.hypothesis.id,
        capabilityId: verdict.capability.id,
        input: verdict.input,
        actionKey: verdict.actionKey,
        expectedEvidence: action.expectedEvidence,
        reason: action.reason,
        status: allowed ? 'approved-by-policy' : 'blocked',
        statusReason: allowed ? (run.mode === 'propose' ? 'Allowed by policy; propose mode does not execute it' : 'Allowed by policy') : `${decision.rule}: ${decision.reason}`,
        decision: { decision: decision.decision, stage: decision.stage, rule: decision.rule, reason: decision.reason },
        costClass: verdict.capability.costClass,
      })
      if (!allowed) await this.#transition(run, verdict.hypothesis, 'blocked', `Policy does not allow ${verdict.capability.id} here: ${decision.reason}`)
      summaries.push(`${verdict.capability.id} on ${verdict.targets.join(', ')} ${allowed ? 'approved by policy' : `blocked (${decision.rule})`}`)
    }
    const fresh = (await getReasoningRunRow(this.#db, run.id))!
    const q = fresh.usage.quality
    const usage: Usage = {
      ...fresh.usage,
      actionsProposed: fresh.usage.actionsProposed + parsed.data.actions.length,
      quality: { ...q, actionsRejected: addCounts(q.actionsRejected, rejected), actionsBlocked: q.actionsBlocked + blocked },
    }
    run = await this.#save(fresh, { usage })
    if (parsed.data.actions.length) {
      await this.#event(run, 'reasoning.action-proposed', `${parsed.data.actions.length} next action${parsed.data.actions.length === 1 ? '' : 's'} proposed: ${summaries.join('; ').slice(0, 600)}`, { runId: run.id, approved, blocked, rejected })
    }
    if (approved === 0) {
      if (blocked > 0) return this.#stopNow(run, 'policy-blocked', `Every proposed action was blocked by policy (${blocked})`)
      return this.#stopNow(run, 'no-eligible-capability', parsed.data.actions.length ? `Every proposed action was rejected by validation (${Object.entries(rejected).map(([k, n]) => `${n} ${k}`).join(', ')})` : 'The planner proposed no action that could reduce uncertainty')
    }
    if (run.mode === 'propose') return this.#stopNow(run, 'awaiting-approval', `${approved} action${approved === 1 ? '' : 's'} approved by policy and awaiting a person (propose mode executes nothing)`)
    return this.#advance(run, 'execute', `${approved} action${approved === 1 ? '' : 's'} approved by policy`)
  }

  async #execute(run: ReasoningRunRow): Promise<StepResult> {
    const actions = (await listReasoningActionRows(this.#db, { runId: run.id })).filter((a) => a.status === 'approved-by-policy' || (a.status === 'queued' && !a.executionId))
    const engagement = await getEngagementRow(this.#db, run.engagementId)
    const view = await this.#view(run)
    let usage: Usage = { ...run.usage }
    const waiting = new Set(run.waitingOn)
    let skipped = 0
    let needsPerson = 0
    for (const action of actions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
      // A crash between submit and recording it: re-attach the execution instead of submitting twice.
      const prior = await findSecurityExecutionByCorrelation(this.#db, run.engagementId, action.id)
      if (prior) {
        await updateReasoningAction(this.#db, action.id, { status: 'queued', executionId: prior.id })
        waiting.add(prior.id)
        continue
      }
      const capability = view.capabilities.find((c) => c.id === action.capabilityId)
      const units = COST_UNITS[action.costClass ?? 'medium']
      const auto = capability ? autoExecutable(capability, engagement?.environment ?? null) : { ok: false, reason: 'Capability not found' }
      let skip: string | null = null
      if (!auto.ok) skip = `Not executed automatically: ${auto.reason}`
      else if (usage.actionsExecuted >= run.budget.maxActions) skip = `Action budget (${run.budget.maxActions}) reached`
      else if (usage.costUnits + units > run.budget.maxCostUnits) skip = `Cost budget (${run.budget.maxCostUnits} units) would be exceeded`
      if (skip) {
        skipped++
        if (!auto.ok) needsPerson++
        await updateReasoningAction(this.#db, action.id, { status: 'skipped', statusReason: skip })
        continue
      }
      const outcome = await this.#broker.submit({ engagementId: run.engagementId, capabilityId: action.capabilityId, input: action.input, actor: this.#agent(run), correlationId: action.id })
      const decision = { decision: outcome.decision.decision, stage: outcome.decision.stage, rule: outcome.decision.rule, reason: outcome.decision.reason }
      if (outcome.status === 'queued') {
        usage = { ...usage, actionsExecuted: usage.actionsExecuted + 1, costUnits: usage.costUnits + units }
        await updateReasoningAction(this.#db, action.id, { status: 'queued', executionId: outcome.executionId, decision, statusReason: 'Submitted through the capability broker' })
        waiting.add(outcome.executionId)
        await this.#event(run, 'reasoning.action-executed', `${action.capabilityId} submitted through the broker for hypothesis ${action.hypothesisId ?? '—'}`, { runId: run.id, actionId: action.id, executionId: outcome.executionId, capabilityId: action.capabilityId })
      } else {
        await updateReasoningAction(this.#db, action.id, { status: outcome.status === 'denied' ? 'blocked' : 'failed', executionId: outcome.status === 'denied' ? null : outcome.executionId, decision, statusReason: outcome.error ?? outcome.decision.reason })
        if (outcome.status === 'denied') usage = { ...usage, quality: { ...usage.quality, actionsBlocked: usage.quality.actionsBlocked + 1 } }
      }
    }
    usage = { ...usage, quality: { ...usage.quality, actionsSkipped: usage.quality.actionsSkipped + skipped } }
    if (waiting.size === 0) {
      run = await this.#save(run, { usage })
      if (needsPerson && needsPerson === skipped) return this.#stopNow(run, 'awaiting-approval', 'The approved actions are not eligible for automatic execution (risk, side effect or cost); they need a person')
      return this.#stopNow(run, skipped ? 'budget-exhausted' : 'policy-blocked', skipped ? 'Approved actions could not run within the run’s action or cost budget' : 'The broker refused every approved action at submission')
    }
    run = await this.#save(run, { usage, waitingOn: [...waiting] }, 'execute', `${waiting.size} execution${waiting.size === 1 ? '' : 's'} running through the broker; waiting for their evidence`)
    // Released while waiting; whoever drives it next (the worker, on the executions' completion) resumes at `await`.
    const waitingRow = await updateReasoningRun(this.#db, run.id, { leaseOwner: this.#ownerId }, { stage: 'await', status: 'waiting', leaseOwner: null, heartbeatAt: null })
    return { run: waitingRow ?? run, stop: true }
  }

  async #await(run: ReasoningRunRow): Promise<StepResult> {
    if (!(await this.#allSettled(run.waitingOn))) {
      const row = await updateReasoningRun(this.#db, run.id, { leaseOwner: this.#ownerId }, { status: 'waiting', leaseOwner: null, heartbeatAt: null })
      return { run: row ?? run, stop: true }
    }
    const actions = (await listReasoningActionRows(this.#db, { runId: run.id })).filter((a) => a.status === 'queued' && a.executionId)
    const notes: string[] = []
    for (const action of actions) {
      const execution = await getSecurityExecutionRow(this.#db, action.executionId!)
      if (!execution) continue
      const output = (execution.result?.output ?? null) as SensorResult | null
      const ok = execution.status === 'succeeded'
      await updateReasoningAction(this.#db, action.id, {
        status: ok ? 'completed' : 'failed',
        statusReason: ok ? (output?.summary ?? 'Execution succeeded') : `Execution ${execution.status}${execution.failure ? `: ${execution.failure.message}` : ''}`,
        result: { executionStatus: execution.status, observations: output?.observations ?? 0, summary: output?.summary ?? execution.result?.summary ?? null },
      })
      notes.push(`${action.capabilityId} ${execution.status}${output ? ` (${output.observations} observations)` : ''}`)
    }
    return this.#advance(run, 'ingest', `Executions settled: ${notes.join('; ') || 'none'}`, { waitingOn: [] })
  }

  // ── Hypothesis review and persistence ────────────────────────────────────────────────────────────────

  async #reviewAndPersist(run: ReasoningRunRow, view: KnowledgeView, proposals: ProposedHypothesis[], researcher: ReasoningAiResult, signal: AbortSignal) {
    const verdicts: ProposalVerdict[] = []
    const acceptedKeys: { dedupeKey: string }[] = []
    for (const p of proposals) {
      const verdict = validateProposal(p, view, acceptedKeys)
      if (verdict.kind === 'accept') acceptedKeys.push({ dedupeKey: verdict.dedupeKey })
      verdicts.push(verdict)
    }
    const rejected: Record<string, number> = {}
    for (const v of verdicts) if (v.kind === 'reject') rejected[v.reason] = (rejected[v.reason] ?? 0) + 1

    // Independent review: the verifier can only make things more conservative (reject, merge, mark as needing evidence).
    const toReview = verdicts.filter((v): v is Extract<ProposalVerdict, { kind: 'accept' }> => v.kind === 'accept')
    const review = new Map<number, { verdict: string; note: string; duplicateOf: string | null; contradicting: string[] }>()
    let reviewer: string | null = null
    let freshRun = (await getReasoningRunRow(this.#db, run.id))!
    if (toReview.length && freshRun.usage.aiCalls < freshRun.budget.maxAiCalls) {
      const ctx = verifierContext(view, toReview.map((v) => v.proposal))
      const result = await this.#runAi(freshRun, 'verifier', ctx.context, ctx.instruction, signal)
      freshRun = result.run
      const parsed = result.outcome.outcome === 'succeeded' ? VerifierOutput.safeParse(result.outcome.output) : null
      if (parsed?.success) {
        reviewer = result.outcome.provenance.at(-1)?.providerId ?? result.outcome.selection.providerId
        for (const r of parsed.data.reviews) review.set(r.proposal, { verdict: r.verdict, note: r.note, duplicateOf: r.duplicateOf, contradicting: r.contradictingObservationIds })
      } else if (parsed && !parsed.success) {
        await this.#markAiInvalid(freshRun)
      }
    }

    let accepted = 0
    let merged = 0
    // The provider that actually answered (after any transient fallback), not merely the router's first choice.
    const answered = researcher.provenance.at(-1)
    const origin = { kind: 'ai' as const, runId: run.id, providerId: answered?.providerId ?? researcher.selection.providerId, model: answered?.model ?? null, promptVersion: researcher.promptVersion }
    for (const v of verdicts) {
      if (v.kind === 'reject') continue
      if (v.kind === 'duplicate') {
        merged++
        await this.#merge(run, v.existing, v.proposal, v.notes.join('; '))
        continue
      }
      const index = toReview.indexOf(v)
      const r = review.get(index)
      if (r?.verdict === 'unsupported') {
        rejected['verifier-unsupported'] = (rejected['verifier-unsupported'] ?? 0) + 1
        continue
      }
      if (r?.verdict === 'contradicted') {
        const related = observationsAbout(view, v.proposal.subjectEntityIds)
        if (r.contradicting.length && r.contradicting.every((id) => related.has(id))) {
          rejected['verifier-contradicted'] = (rejected['verifier-contradicted'] ?? 0) + 1
          continue
        }
      }
      if (r?.verdict === 'duplicate' && r.duplicateOf) {
        const existing = view.hypotheses.find((h) => h.id === r.duplicateOf)
        if (existing && v.proposal.subjectEntityIds.every((id) => existing.subjectEntityIds.includes(id))) {
          merged++
          await this.#merge(run, existing, v.proposal, 'The verifier identified a restatement and the affected entities agree')
          continue
        }
      }
      accepted++
      await this.#create(run, v, origin, r ? { verdict: r.verdict as SecurityHypothesis['review']['verdict'], note: r.note, providerId: reviewer } : { verdict: 'not-reviewed', note: null, providerId: null })
    }
    return { accepted, merged, rejected }
  }

  async #create(run: ReasoningRunRow, v: Extract<ProposalVerdict, { kind: 'accept' }>, origin: SecurityHypothesis['origin'], review: SecurityHypothesis['review']) {
    const p = v.proposal
    const now = this.#now()
    const reason = v.notes.length ? `Proposed; ${v.notes.join('; ')}` : 'Proposed'
    const status: HypothesisStatus = review.verdict === 'needs-evidence' ? 'needs-evidence' : 'proposed'
    const id = newHypothesisId()
    const row = await insertHypothesis(this.#db, {
      id,
      engagementId: run.engagementId,
      dedupeKey: v.dedupeKey,
      claim: p.claim,
      category: p.category,
      status,
      statusReason: reason,
      confidence: v.confidence,
      impact: p.impact,
      rationale: p.rationale,
      evidenceChecks: p.evidenceChecks,
      checkResults: [],
      candidateCapabilities: v.candidateCapabilities,
      attempts: 0,
      origin,
      review,
      history: [{ at: now.toISOString(), from: null, to: status, reason, actor: 'ai', runId: run.id }],
      createdAt: now,
      updatedAt: now,
    }).catch(async (error: unknown) => {
      // A concurrent proposal with the same structural key won the insert: it is a duplicate.
      if (String(error).includes('security_hypotheses_dedupe_idx')) return null
      throw error
    })
    if (!row) return
    await addHypothesisLinks(this.#db, run.engagementId, id, [
      ...p.subjectEntityIds.map((t) => ({ role: 'affects' as const, targetType: 'node' as const, targetId: t, addedBy: 'ai' as const })),
      ...p.supportingObservationIds.map((t) => ({ role: 'supports' as const, targetType: 'observation' as const, targetId: t, addedBy: 'ai' as const })),
      ...p.contradictingObservationIds.map((t) => ({ role: 'contradicts' as const, targetType: 'observation' as const, targetId: t, addedBy: 'ai' as const })),
      ...p.gapIds.map((t) => ({ role: 'gap' as const, targetType: 'gap' as const, targetId: t, addedBy: 'ai' as const })),
    ])
    await this.#event(run, 'hypothesis.proposed', `Hypothesis proposed: ${p.claim.slice(0, 200)}`, { runId: run.id, hypothesisId: id, category: p.category, impact: p.impact })
  }

  async #merge(run: ReasoningRunRow, existing: SecurityHypothesis, p: ProposedHypothesis, note: string) {
    await addHypothesisLinks(this.#db, run.engagementId, existing.id, [
      ...p.supportingObservationIds.map((t) => ({ role: 'supports' as const, targetType: 'observation' as const, targetId: t, addedBy: 'ai' as const, note: 'From a merged restatement' })),
      ...p.gapIds.map((t) => ({ role: 'gap' as const, targetType: 'gap' as const, targetId: t, addedBy: 'ai' as const })),
    ])
    const history = [...existing.history, { at: this.#now().toISOString(), from: existing.status, to: existing.status, reason: `Merged a restated proposal ("${p.claim.slice(0, 120)}"): ${note}`, actor: 'audivra' as const, runId: run.id }].slice(-50)
    await updateHypothesis(this.#db, existing.id, { history })
  }

  /** AI relationship enrichment: validated references only; stored as `inferred`, never overriding observed facts. */
  async #persistRelationships(run: ReasoningRunRow, view: KnowledgeView, relationships: ProposedRelationship[]): Promise<{ accepted: number; rejected: number }> {
    const ALLOWED: Record<string, [string[], string[]]> = { CALLS: [['endpoint'], ['endpoint']], BELONGS_TO: [['endpoint'], ['api-operation']], DEPENDS_ON: [['host'], ['technology']], READS: [['endpoint', 'api-operation'], ['parameter']] }
    let accepted = 0
    let rejected = 0
    for (const [index, r] of relationships.entries()) {
      const from = view.nodes.get(r.fromEntityId)
      const to = view.nodes.get(r.toEntityId)
      const kinds = ALLOWED[r.type]
      const related = observationsAbout(view, [r.fromEntityId, r.toEntityId])
      const valid =
        from && to && kinds && (AI_RELATION_TYPES as readonly string[]).includes(r.type) && kinds[0].includes(from.kind) && kinds[1].includes(to.kind) &&
        ![from, to].some((n) => n.scopeClass === 'out-of-scope' || n.scopeClass === 'third-party') &&
        r.supportingObservationIds.every((id) => view.observations.has(id) && related.has(id))
      if (!valid) {
        rejected++
        continue
      }
      const key = edgeKey(r.type, from.key, to.key)
      const now = this.#now()
      const evidenceRefs = [...new Set(r.supportingObservationIds.flatMap((id) => view.observations.get(id)?.evidenceRefs ?? []))].slice(0, 20)
      await withGraphLock(this.#db, run.engagementId, async (tx) => {
        const rows = await loadGraphRows(tx, run.engagementId)
        let edgeId = rows.edges.find((e) => e.key === key)?.id
        if (!edgeId) {
          edgeId = newGraphEdgeId()
          await insertGraphEdges(tx, [{ id: edgeId, engagementId: run.engagementId, type: r.type, key, fromNodeId: from.id, toNodeId: to.id, attributes: { inferredBy: 'ai' }, basis: 'inferred', confidence: Math.min(INFERRED_CONFIDENCE_CAP, r.confidence), corroboration: 0, tools: [], status: 'active', conflicts: [], firstObservedAt: now, lastObservedAt: now, createdAt: now, updatedAt: now }])
        }
        const sourceRef = `${run.id}:${index}`
        if (!rows.provenance.some((p) => p.subjectId === edgeId && p.source === 'ai-inference' && p.sourceRef === sourceRef)) {
          await insertGraphProvenance(tx, [{ id: newGraphProvenanceId(), engagementId: run.engagementId, subjectType: 'edge', subjectId: edgeId, source: 'ai-inference', trust: 'ai-inference', sourceRef, observationId: null, evidenceRefs, executionIds: [], capabilityIds: [], tools: [], confidence: Math.min(INFERRED_CONFIDENCE_CAP, r.confidence), rationale: r.rationale, reasoningRunId: run.id, firstAt: now, lastAt: now, createdAt: now, updatedAt: now }])
        }
      })
      accepted++
    }
    return { accepted, rejected }
  }

  async #transition(run: ReasoningRunRow, h: SecurityHypothesis, to: HypothesisStatus, reason: string, extra: { confidence?: number; checkResults?: SecurityHypothesis['checkResults']; attempts?: number } = {}) {
    const at = this.#now().toISOString()
    const history = [...h.history, { at, from: h.status, to, reason: reason.slice(0, 600), actor: 'audivra' as const, runId: run.id }].slice(-50)
    await updateHypothesis(this.#db, h.id, { status: to, statusReason: reason, history, ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}), ...(extra.checkResults ? { checkResults: extra.checkResults } : {}), ...(extra.attempts !== undefined ? { attempts: extra.attempts } : {}) })
    const type: SecurityEventType = to === 'disproved' ? 'hypothesis.disproved' : 'hypothesis.updated'
    await this.#event(run, type, `Hypothesis ${h.status} → ${to}: ${h.claim.slice(0, 140)}`, { runId: run.id, hypothesisId: h.id, from: h.status, to, reason: reason.slice(0, 300) }, to === 'blocked' ? 'warn' : 'info')
  }

  // ── AI calls ─────────────────────────────────────────────────────────────────────────────────────────

  async #runAi(run: ReasoningRunRow, task: ReasoningTaskName, context: { trusted: { label: string; content: string }[]; untrusted: { label: string; content: string }[] }, instruction: string, signal: AbortSignal): Promise<{ run: ReasoningRunRow; outcome: ReasoningAiResult }> {
    // The call is counted before it is made: a crash mid-call still consumes budget (bounded retries).
    run = await this.#save(run, { usage: { ...run.usage, aiCalls: run.usage.aiCalls + 1 } })
    const definition = REASONING_TASKS[task]
    const outcome = await this.#ai!.run({ spec: definition.spec, prompt: definition.prompt, context, instruction, jsonSchema: reasoningJsonSchema(task), engagementId: run.engagementId, runId: run.id, signal })
    const fresh = (await getReasoningRunRow(this.#db, run.id)) ?? run
    const providers = { ...fresh.usage.providers }
    for (const p of outcome.provenance) providers[p.providerId] = (providers[p.providerId] ?? 0) + 1
    const cost = outcome.provenance.reduce<number | null>((sum, p) => (p.costUsd === null || p.costUsd === undefined ? sum : (sum ?? 0) + p.costUsd), fresh.usage.aiCostUsd)
    const usage: Usage = { ...fresh.usage, aiAttempts: fresh.usage.aiAttempts + outcome.attempts, providers, aiCostUsd: cost }
    const aiRuns = [...fresh.aiRuns, ...outcome.provenance].slice(-MAX_AI_RUNS)
    const message = outcome.outcome === 'succeeded' ? `${definition.spec.role} answered (${outcome.selection.providerId})` : `${definition.spec.role}: ${outcome.outcome}${outcome.refused ? ' (provider policy refusal; not rerouted)' : ''}`
    const saved = await this.#save(fresh, { usage, aiRuns }, fresh.stage, message)
    if (outcome.outcome !== 'succeeded') {
      await this.#event(saved, 'reasoning.blocked', `AI ${definition.spec.role} ${outcome.outcome}: ${outcome.selection.reason}`, { runId: run.id, task: definition.spec.taskType, outcome: outcome.outcome, providerId: outcome.selection.providerId }, 'warn')
    }
    return { run: saved, outcome }
  }

  async #markAiInvalid(run: ReasoningRunRow) {
    const fresh = (await getReasoningRunRow(this.#db, run.id)) ?? run
    const last = fresh.aiRuns.at(-1)
    if (!last) return
    const aiRuns = [...fresh.aiRuns.slice(0, -1), { ...last, outcome: 'invalid-structured-output' as const, outputStatus: 'invalid' as const }]
    await this.#save(fresh, { aiRuns })
  }

  // ── Persistence helpers ─────────────────────────────────────────────────────────────────────────────

  async #view(run: ReasoningRunRow): Promise<KnowledgeView> {
    return loadKnowledge(this.#db, run.engagementId, this.#registry)
  }

  #agent(run: ReasoningRunRow): SecurityActor {
    return { kind: 'agent', id: 'audivra-reasoning', agentRunId: run.id }
  }

  #overTime(run: ReasoningRunRow): boolean {
    const started = (run.startedAt ?? run.createdAt).getTime()
    return this.#now().getTime() - started > run.budget.wallClockMs
  }

  async #allSettled(executionIds: string[]): Promise<boolean> {
    const store = createDbExecutionStore(this.#db)
    for (const id of executionIds) {
      const row = await store.get(id)
      if (row && !isTerminalExecutionStatus(row.status)) return false
    }
    return true
  }

  async #save(run: ReasoningRunRow, patch: Partial<ReasoningRunRow>, stage?: ReasoningStage, message?: string): Promise<ReasoningRunRow> {
    const decisions = message ? [...run.decisions, { at: this.#now().toISOString(), iteration: patch.iteration ?? run.iteration, stage: stage ?? run.stage, message: message.slice(0, 600) }].slice(-MAX_DECISIONS) : undefined
    const row = await updateReasoningRun(this.#db, run.id, { leaseOwner: this.#ownerId }, { ...patch, ...(decisions ? { decisions } : {}) })
    if (!row) throw new LeaseLostError(run.id)
    return row
  }

  async #advance(run: ReasoningRunRow, stage: ReasoningStage, message: string, extra: Partial<ReasoningRunRow> & { aiProblem?: string } = {}): Promise<StepResult> {
    const { aiProblem, ...patch } = extra
    const msg = aiProblem ? `${message} [ai:${aiProblem}]` : message
    const row = await this.#save(run, { ...patch, stage }, run.stage, msg)
    return { run: row, stop: false }
  }

  async #addStageTime(run: ReasoningRunRow, stage: ReasoningStage, ms: number): Promise<ReasoningRunRow> {
    const usage: Usage = { ...run.usage, stageMs: { ...run.usage.stageMs, [stage]: (run.usage.stageMs[stage] ?? 0) + Math.round(ms) } }
    return (await updateReasoningRun(this.#db, run.id, {}, { usage })) ?? run
  }

  async #stopNow(run: ReasoningRunRow, reason: ReasoningStopReason, detail: string): Promise<StepResult> {
    return { run: await this.#finish(run, reason, detail, this.#ownerId), stop: true }
  }

  async #finish(run: ReasoningRunRow, reason: ReasoningStopReason, detail: string, owner: string | null): Promise<ReasoningRunRow> {
    const now = this.#now()
    const status = reason === 'provider-unavailable' || reason === 'provider-refused' || reason === 'ai-output-invalid' ? 'blocked' : reason === 'internal-error' ? 'failed' : reason === 'cancelled' ? 'cancelled' : 'completed'
    const fresh = (await getReasoningRunRow(this.#db, run.id)) ?? run
    const usage: Usage = { ...fresh.usage, elapsedMs: now.getTime() - (fresh.startedAt ?? fresh.createdAt).getTime() }
    const decisions = [...fresh.decisions, { at: now.toISOString(), iteration: fresh.iteration, stage: fresh.stage, message: `Stopped: ${reason} — ${detail}`.slice(0, 600) }].slice(-MAX_DECISIONS)
    const row =
      (await updateReasoningRun(this.#db, run.id, { from: ['queued', 'running', 'waiting'], ...(owner ? { leaseOwner: owner } : {}) }, {
        status,
        stage: 'done',
        stopReason: reason,
        stopDetail: detail,
        aiCoverage: aiCoverage(fresh, reason),
        usage,
        decisions,
        finishedAt: now,
        leaseOwner: null,
        heartbeatAt: null,
      })) ?? fresh
    if (reason === 'cancelled') {
      // Cancelling reasoning also cancels the executions it is still waiting for (exactly those).
      for (const id of fresh.waitingOn) {
        await requestExecutionCancel({ store: createDbSecurityStore(this.#db), executions: createDbExecutionStore(this.#db) }, id, this.#agent(fresh)).catch(() => undefined)
      }
    }
    const blocked = status === 'blocked' || reason === 'policy-blocked'
    await this.#event(row, blocked ? 'reasoning.blocked' : 'reasoning.completed', `Reasoning ${status}: ${reason} — ${detail}`.slice(0, 500), { runId: row.id, status, stopReason: reason, usage: { aiCalls: usage.aiCalls, actionsExecuted: usage.actionsExecuted, iterations: row.iteration } }, blocked ? 'warn' : 'info')
    return row
  }

  async #event(run: Pick<ReasoningRunRow, 'engagementId' | 'id' | 'requestedBy'>, type: SecurityEventType, message: string, data: Record<string, unknown>, level: 'info' | 'warn' = 'info', actor?: SecurityActor) {
    const engagement = await getEngagementRow(this.#db, run.engagementId)
    if (!engagement) return
    await recordSecurityEvent(this.#db, { engagementId: run.engagementId, type, level, message, actor: actor ?? { kind: 'system', id: 'audivra-reasoning', agentRunId: run.id }, configVersion: engagement.configVersion, data })
  }
}

export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Reasoning run ${runId} is no longer held by this driver`)
    this.name = 'LeaseLostError'
  }
}

function addCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n
  return out
}

/** The last AI problem recorded in this iteration's decisions (the marker added by `#advance`). */
function lastAiProblem(run: ReasoningRunRow): string | null {
  for (let i = run.decisions.length - 1; i >= 0; i--) {
    const d = run.decisions[i]!
    if (d.iteration !== run.iteration) break
    const match = d.message.match(/\[ai:([a-z-]+)\]$/)
    if (match) return match[1]!
  }
  return null
}

function aiCoverage(run: ReasoningRunRow, reason: ReasoningStopReason): AiCoverageState {
  if (reason === 'provider-unavailable') return 'provider-unavailable'
  if (reason === 'provider-refused') return 'provider-refused'
  if (run.usage.aiCalls === 0) return 'not-required'
  if (run.aiRuns.some((p) => p.outcome !== 'succeeded') || reason === 'ai-output-invalid') return 'partial'
  return 'completed'
}

/** Evidence-check summary for a hypothesis (used by read APIs). */
export function checkSummary(h: SecurityHypothesis, view: KnowledgeView) {
  return h.evidenceChecks.map((c, i) => evaluateCheck(c, i, view))
}
