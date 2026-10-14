import { randomUUID } from 'node:crypto'
import type { Logger } from '@audivra/config'
import {
  ResearchPlannerOutput,
  type CreateResearchRunInput,
  type ResearchProposal,
  type ResearchTermination,
  type SecurityActor,
  type SecurityEventType,
  type SecurityResearchAction,
  type SecurityResearchRun,
  type SpecialistEngineId,
} from '@audivra/contracts'
import {
  getEngagementRow,
  getResearchRunRow,
  insertResearchAction,
  insertResearchRun,
  listAttackPathsForEngagement,
  listCandidatesForEngagement,
  listComparisonRows,
  listDomainDeclarationRows,
  listFindingsForEngagement,
  listResumableResearchRuns,
  listRunActionHistory,
  newResearchActionId,
  newResearchRunId,
  recordSecurityEvent,
  TERMINAL_RESEARCH_STATES,
  toComparison,
  toResearchRun,
  updateResearchAction,
  updateResearchRun,
  type Db,
  type PgBoss,
} from '@audivra/database'
import type { CapabilityBroker } from '../broker.ts'
import { ComparisonEngine } from '../comparison/engine.ts'
import { ComparisonService } from '../comparison/service.ts'
import { comparisonCoverage } from '../comparison/coverage.ts'
import { GraphProjector } from '../graph/projector.ts'
import { jsonSection, type ReasoningAi } from '../reasoning/ai.ts'
import { AttackPathService } from '../attack-path/service.ts'
import { RetestService } from '../retest/service.ts'
import { SpecialistRunService } from '../specialist/service.ts'
import { StrixSpecialistEngine } from '../specialist/strix-engine.ts'
import type { SpecialistEngine } from '../specialist/engine.ts'
import { createRuntimeRegistry } from '../capabilities/catalog.ts'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import { VerificationService } from '../verification/service.ts'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import { assess, type AssessContext, type CandidateAction } from './assess.ts'
import { actionFingerprint, comparisonPlanFingerprint } from './fingerprint.ts'
import { budgetExhausted, defaultBudget, zeroUsage } from './budget.ts'
import { coverageSnapshot, residualUncertainty } from './coverage.ts'
import { executeAction, type ExecuteDeps } from './execute.ts'
import { rankCandidates } from './rank.ts'
import { researchJsonSchema, RESEARCH_TASKS } from './ai.ts'
import { validateBatch } from './validate.ts'

/*
 * Phase 6E — the autonomous research orchestrator. It coordinates the existing services (graph, comparison
 * planner/engine, broker, verification, attack paths, retesting, specialist) through a bounded, persistent
 * cycle. It owns no domain logic and no execution authority: the broker/policy decide eligibility, 6A owns
 * verification, 6B owns paths, 6C owns history, Phase 5 owns comparisons, and the AI only proposes typed
 * actions. All state is persisted every cycle, so a worker/provider restart resumes deterministically.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

interface LoopContext extends AssessContext {
  declaredResourceRefs: Set<string>
  findingIds: Set<string>
  history: SecurityResearchAction[]
}

export interface ResearchServiceOptions {
  db: Db
  broker: CapabilityBroker
  registry?: CapabilityRegistry
  ai?: ReasoningAi
  specialistEngines?: Partial<Record<SpecialistEngineId, SpecialistEngine>>
  graphProjector?: GraphProjector
  boss?: PgBoss
  now?: () => Date
  log?: Logger
}

export class ResearchService {
  readonly #db: Db
  readonly #ai: ReasoningAi | undefined
  readonly #boss: PgBoss | undefined
  readonly #now: () => Date
  readonly #log: Logger | undefined
  readonly #projector: GraphProjector
  readonly #comparisonService: ComparisonService
  readonly #execDeps: ExecuteDeps
  readonly #specialist: SpecialistRunService

  constructor(options: ResearchServiceOptions) {
    this.#db = options.db
    this.#ai = options.ai
    this.#boss = options.boss
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
    const registry = options.registry ?? createRuntimeRegistry()
    this.#projector = options.graphProjector ?? new GraphProjector({ db: options.db, log: options.log })
    const comparisonEngine = new ComparisonEngine({ db: options.db, broker: options.broker, projector: this.#projector, log: options.log })
    this.#comparisonService = new ComparisonService({ db: options.db, engine: comparisonEngine })
    const verification = new VerificationService({ db: options.db, registry, ai: options.ai, graphProjector: this.#projector, log: options.log })
    const attackPath = new AttackPathService({ db: options.db, ai: options.ai, log: options.log })
    const retest = new RetestService({ db: options.db, comparisonEngine, registry, ai: options.ai, log: options.log })
    // No boss here: the research loop drives the specialist inline (request does not enqueue a second driver).
    this.#specialist = new SpecialistRunService({ db: options.db, broker: options.broker, engines: options.specialistEngines ?? { strix: new StrixSpecialistEngine() }, graphProjector: this.#projector, log: options.log })
    this.#execDeps = { db: options.db, broker: options.broker, comparisonEngine, verification, attackPath, retest, specialist: this.#specialist }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────────────────────────────

  async create(engagementId: string, input: CreateResearchRunInput, actor: SecurityActor = LOCAL_USER): Promise<SecurityResearchRun> {
    const engagement = ENGAGEMENT_ID.test(engagementId) ? await getEngagementRow(this.#db, engagementId) : undefined
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    const budget = defaultBudget(input.mode, input.budget)
    const coverageBefore = await coverageSnapshot(this.#db, engagementId)
    const residual = await residualUncertainty(this.#db, engagementId, coverageBefore)
    const row = await insertResearchRun(this.#db, {
      id: newResearchRunId(),
      engagementId,
      parentRunId: null,
      mode: input.mode,
      objective: input.objective,
      objectiveNote: input.objectiveNote,
      objectiveDetail: input.objectiveDetail,
      state: 'created',
      stage: 'assess',
      budget,
      usage: zeroUsage(),
      coverageBefore,
      residual,
      providerAvailable: !!this.#ai,
      startingGraphRevision: null,
    })
    await this.#event(engagementId, engagement.configVersion, 'research.created', `Research run created (${input.mode}, ${input.objective})`, actor, { runId: row.id })
    return toResearchRun(row)
  }

  /** Start a created run: enqueue it for the worker (or the caller drives it directly in tests). */
  async start(runId: string, actor: SecurityActor = LOCAL_USER): Promise<SecurityResearchRun> {
    const run = await this.#load(runId)
    if (run.state !== 'created' && run.state !== 'paused') return run
    await updateResearchRun(this.#db, runId, { state: 'running', startedAt: run.startedAt ? undefined : this.#now() })
    const engagement = await getEngagementRow(this.#db, run.engagementId)
    await this.#event(run.engagementId, engagement?.configVersion ?? 0, 'research.started', `Research run started`, actor, { runId })
    if (this.#boss) {
      const { enqueueSecurityResearch } = await import('@audivra/database')
      await enqueueSecurityResearch(this.#boss, runId)
    }
    return toResearchRun((await getResearchRunRow(this.#db, runId))!)
  }

  async pause(runId: string): Promise<SecurityResearchRun> {
    const run = await this.#load(runId)
    if (TERMINAL_RESEARCH_STATES.includes(run.state)) return run
    return toResearchRun((await updateResearchRun(this.#db, runId, { state: 'paused', lastDecision: 'Paused by request.' }))!)
  }

  async resume(runId: string): Promise<SecurityResearchRun> {
    const run = await this.#load(runId)
    if (run.state !== 'paused') return run
    await updateResearchRun(this.#db, runId, { state: 'running' })
    if (this.#boss) {
      const { enqueueSecurityResearch } = await import('@audivra/database')
      await enqueueSecurityResearch(this.#boss, runId)
    }
    return toResearchRun((await getResearchRunRow(this.#db, runId))!)
  }

  async cancel(runId: string): Promise<SecurityResearchRun> {
    const run = await this.#load(runId)
    if (TERMINAL_RESEARCH_STATES.includes(run.state)) return run
    return this.#terminate(run, 'user-cancelled', 'Cancelled by request.')
  }

  /** Re-enqueue resumable runs after a worker restart (idempotent; drive resumes from the persisted state). */
  async recover(): Promise<{ resumed: number }> {
    const runs = await listResumableResearchRuns(this.#db)
    if (this.#boss) {
      const { enqueueSecurityResearch } = await import('@audivra/database')
      for (const run of runs) await enqueueSecurityResearch(this.#boss, run.id)
    }
    return { resumed: runs.length }
  }

  // ── The research loop ────────────────────────────────────────────────────────────────────────────────

  async drive(runId: string, options: { actor?: SecurityActor; signal?: AbortSignal } = {}): Promise<SecurityResearchRun> {
    const actor = options.actor ?? LOCAL_USER
    let run = await this.#load(runId)
    if (TERMINAL_RESEARCH_STATES.includes(run.state) || run.state === 'paused') return run
    const engagement = await getEngagementRow(this.#db, run.engagementId)
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    const configVersion = engagement.configVersion
    if (run.state === 'created') await updateResearchRun(this.#db, runId, { state: 'running', startedAt: this.#now() })

    const startMs = this.#now().getTime()
    const usage = { ...run.usage }
    let providerAvailable = run.providerAvailable
    let lowValueStreak = 0

    for (;;) {
      // A pause/cancel requested mid-loop is honored at the top of each cycle.
      const fresh = await getResearchRunRow(this.#db, runId)
      if (!fresh || fresh.state === 'paused' || TERMINAL_RESEARCH_STATES.includes(fresh.state)) return toResearchRun(fresh ?? (await getResearchRunRow(this.#db, runId))!)
      run = toResearchRun(fresh)

      usage.elapsedMs = run.usage.elapsedMs + (this.#now().getTime() - startMs)
      const exhausted = budgetExhausted(run.budget, usage)
      if (exhausted) return this.#terminate(run, exhausted, `Budget reached (${exhausted}).`)

      // ASSESS
      await updateResearchRun(this.#db, runId, { stage: 'assess' })
      const ctx = await this.#assessContext(run)
      const deterministic = assess(ctx)
      await this.#event(run.engagementId, configVersion, 'research.assessed', `Assessed: ${deterministic.length} deterministic candidate action(s)`, actor, { runId, iteration: run.iteration })

      // PLAN (AI advisory; degrade gracefully if unavailable)
      await updateResearchRun(this.#db, runId, { stage: 'plan' })
      let aiCandidates: CandidateAction[] = []
      const aiPriority = new Map<string, 'low' | 'medium' | 'high'>()
      if (this.#ai && usage.aiCalls < run.budget.maxAiCalls) {
        usage.aiCalls++
        const planned = await this.#plan(run, ctx, deterministic, options.signal)
        if (planned === 'unavailable') providerAvailable = false
        else {
          aiCandidates = planned.candidates
          for (const [fp, p] of planned.priority) aiPriority.set(fp, p)
        }
      }
      const merged = this.#dedupe([...deterministic, ...aiCandidates])
      await this.#event(run.engagementId, configVersion, 'research.plan-created', `Planned ${merged.length} candidate(s) (${aiCandidates.length} AI-proposed)`, actor, { runId })

      // VALIDATE (persist every candidate as an action; rejected ones recorded with a reason)
      await updateResearchRun(this.#db, runId, { stage: 'validate' })
      const validated = validateBatch(merged, { run, history: ctx.history, declaredResourceRefs: ctx.declaredResourceRefs, findingIds: ctx.findingIds, specialistAvailable: ctx.specialistAvailable })
      const valid = validated.filter((v) => v.ok).map((v) => v.candidate)
      const ranked = rankCandidates(valid, ctx.history, aiPriority)

      // Persist proposed/rejected actions for the timeline.
      const actionIds = new Map<string, string>()
      for (const v of validated) {
        const r = ranked.find((x) => x.candidate.fingerprint === v.candidate.fingerprint)
        const id = await this.#recordAction(run, v.candidate, v.ok ? 'proposed' : 'rejected', r?.rank ?? 999, v.rejection)
        actionIds.set(v.candidate.fingerprint, id)
        if (!v.ok) await this.#event(run.engagementId, configVersion, 'research.action-blocked', `Rejected ${v.candidate.kind} (${v.rejection}): ${v.detail}`.slice(0, 200), actor, { runId, rejection: v.rejection }, 'info')
      }

      if (ranked.length === 0) {
        const policyBlocked = validated.length > 0 && validated.every((v) => v.rejection === 'too-expensive' || v.rejection === 'budget-exceeded' || v.rejection === 'specialist-unavailable' || v.rejection === 'environment-disallows')
        return this.#terminate(run, policyBlocked ? 'policy-blocked' : 'no-useful-action', policyBlocked ? 'All candidate actions were blocked by policy/budget.' : 'No useful next action remains.')
      }

      const top = ranked[0]!.candidate
      const topActionId = actionIds.get(top.fingerprint)!
      await this.#event(run.engagementId, configVersion, 'research.action-selected', `Selected ${top.kind}${top.objectiveRef ? ` on ${top.objectiveRef}` : ''}: ${top.reason}`.slice(0, 220), actor, { runId, kind: top.kind })

      // PROPOSE-ONLY: record proposals and stop without executing.
      if (run.mode === 'propose-only') {
        for (const r of ranked) await updateResearchAction(this.#db, actionIds.get(r.candidate.fingerprint)!, { state: 'policy-allowed' })
        return this.#terminate(run, 'objective-satisfied', `Proposed ${ranked.length} eligible action(s) for review (propose-only).`)
      }

      // EXECUTE → INGEST → VERIFY (all through existing services)
      await updateResearchRun(this.#db, runId, { stage: 'execute' })
      await updateResearchAction(this.#db, topActionId, { state: 'running' })
      usage.actions++
      if (top.costClass === 'expensive') usage.expensiveActions++
      if (top.kind === 'specialist') usage.specialistRuns++
      let outcome
      try {
        outcome = await executeAction(this.#execDeps, run.engagementId, top, actor, options.signal ?? AbortSignal.timeout(run.budget.wallClockMs))
      } catch (error) {
        await updateResearchAction(this.#db, topActionId, { state: 'blocked', usefulness: 'failed', outcome: error instanceof Error ? error.message.slice(0, 300) : 'error' })
        await this.#event(run.engagementId, configVersion, 'research.action-completed', `Action ${top.kind} failed`, actor, { runId }, 'warn')
        lowValueStreak++
        run = await this.#advance(runId, usage, providerAvailable, `Action ${top.kind} failed.`)
        if (lowValueStreak >= 2) return this.#terminate(run, 'information-gain-too-low', 'Repeated low-value/failed actions.')
        continue
      }
      await updateResearchRun(this.#db, runId, { stage: 'ingest' })
      await updateResearchAction(this.#db, topActionId, { state: 'completed', usefulness: outcome.usefulness, outcome: outcome.outcome, producedRefs: outcome.producedRefs })
      await this.#event(run.engagementId, configVersion, 'research.action-completed', `${top.kind} → ${outcome.usefulness}: ${outcome.outcome}`.slice(0, 220), actor, { runId, usefulness: outcome.usefulness })
      if (top.kind === 'verify') await this.#event(run.engagementId, configVersion, 'research.verification-triggered', 'Verification pass run', actor, { runId })
      if (top.kind === 'attack-path') await this.#event(run.engagementId, configVersion, 'research.path-updated', 'Attack paths refreshed', actor, { runId })

      // REFLECT
      await updateResearchRun(this.#db, runId, { stage: 'reflect' })
      lowValueStreak = outcome.usefulness === 'no-new-information' || outcome.usefulness === 'low-value' || outcome.usefulness === 'failed' || outcome.usefulness === 'blocked' ? lowValueStreak + 1 : 0
      run = await this.#advance(runId, usage, providerAvailable, `${top.kind} → ${outcome.usefulness}`)
      if (lowValueStreak >= 2) return this.#terminate(run, 'information-gain-too-low', 'Two consecutive low-value actions; stopping.')
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────────────

  async #assessContext(run: SecurityResearchRun): Promise<LoopContext> {
    const engagementId = run.engagementId
    const [{ plans }, comparisonRows, candidates, findings, attackPaths, declaredResources, history] = await Promise.all([
      this.#comparisonService.propose(engagementId),
      listComparisonRows(this.#db, engagementId, { limit: 2000 }),
      listCandidatesForEngagement(this.#db, engagementId),
      listFindingsForEngagement(this.#db, engagementId),
      listAttackPathsForEngagement(this.#db, engagementId),
      listDomainDeclarationRows(this.#db, engagementId, { kind: 'resource' }),
      listRunActionHistory(this.#db, run.id),
    ])
    const comparisons = comparisonRows.map(toComparison)
    const availability = await this.#specialist.availability('strix')
    const retestCases = run.objective === 'retest-previous' ? await this.#retestCases(run) : []
    return {
      run,
      proposals: plans,
      comparisons,
      candidates,
      findings,
      attackPaths,
      retestCases,
      specialistAvailable: availability.state === 'ready' && availability.enabledModes.length > 0,
      specialistBudgetLeft: run.usage.specialistRuns < run.budget.maxSpecialistRuns && run.usage.expensiveActions < run.budget.maxExpensiveActions,
      declaredResourceRefs: new Set(declaredResources.map((d) => d.ref)),
      findingIds: new Set(findings.map((f) => f.id)),
      history,
    }
  }

  async #retestCases(run: SecurityResearchRun) {
    const previous = typeof run.objectiveDetail.previousEngagementId === 'string' ? run.objectiveDetail.previousEngagementId : null
    if (!previous) return []
    return this.#execDeps.retest.planRetests(previous, { eligibleOnly: true }).catch(() => [])
  }

  /** Call the AI planner for advisory proposals, mapped to typed candidates (resolvable ones only). */
  async #plan(run: SecurityResearchRun, ctx: AssessContext, deterministic: CandidateAction[], signal: AbortSignal | undefined): Promise<'unavailable' | { candidates: CandidateAction[]; priority: Map<string, 'low' | 'medium' | 'high'> }> {
    if (!this.#ai) return { candidates: [], priority: new Map() }
    const task = RESEARCH_TASKS.planner
    const trusted = [
      jsonSection('objective', { objective: run.objective, mode: run.mode, note: run.objectiveNote }),
      jsonSection('coverage', run.coverageBefore),
      jsonSection('deterministic-candidates', deterministic.map((c) => ({ kind: c.kind, ref: c.objectiveRef, cost: c.costClass, reason: c.reason }))),
      jsonSection('findings', ctx.findings.map((f) => ({ id: f.id, title: f.title, state: f.verificationState }))),
      jsonSection('resources', [...ctx.proposals].map((p) => p.plan.resourceRef).slice(0, 20)),
    ]
    let out
    try {
      out = await this.#ai.run({ spec: task.spec, prompt: task.prompt, context: { trusted, untrusted: [] }, instruction: 'Propose a small number of typed next actions referencing only existing ids/resources, cheapest useful first. An empty list is valid. Never propose an expensive specialist run when a cheaper capability can answer the question.', jsonSchema: researchJsonSchema('planner'), engagementId: run.engagementId, runId: `research-${randomUUID().slice(0, 8)}`, signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs) })
    } catch {
      return 'unavailable'
    }
    if (out.outcome !== 'succeeded') return 'unavailable'
    const parsed = ResearchPlannerOutput.safeParse(out.output)
    if (!parsed.success) return { candidates: [], priority: new Map() }
    const priority = new Map<string, 'low' | 'medium' | 'high'>()
    const candidates: CandidateAction[] = []
    for (const proposal of parsed.data.proposals) {
      const candidate = this.#mapProposal(proposal, ctx)
      if (candidate) {
        candidates.push(candidate)
        priority.set(candidate.fingerprint, proposal.priority)
      }
    }
    return { candidates, priority }
  }

  #mapProposal(proposal: ResearchProposal, ctx: AssessContext): CandidateAction | null {
    const base = { origin: 'ai-proposed' as const, reason: proposal.reason }
    switch (proposal.kind) {
      case 'comparison': {
        const plan = proposal.resourceRef ? ctx.proposals.find((p) => p.plan.resourceRef === proposal.resourceRef)?.plan : undefined
        // Keep an unresolved proposal so deterministic validation can reject it (input-invalid), surfacing the attempt.
        const inputRef = plan ? (plan as unknown as Record<string, unknown>) : { resourceRef: proposal.resourceRef, arms: undefined }
        return { ...base, kind: 'comparison', objectiveRef: proposal.resourceRef, capabilityId: null, inputRef, fingerprint: plan ? actionFingerprint('comparison', { input: comparisonPlanFingerprint(plan) }) : actionFingerprint('comparison', { objectiveRef: proposal.resourceRef }), costClass: 'normal', expectedInformationGain: 2 }
      }
      case 'specialist':
        return { ...base, kind: 'specialist', objectiveRef: proposal.resourceRef, capabilityId: 'specialist.strix-research', inputRef: { mode: 'source-only', resourceRef: proposal.resourceRef }, fingerprint: actionFingerprint('specialist', { input: `source-only:${proposal.resourceRef ?? ''}` }), costClass: 'expensive', expectedInformationGain: 2 }
      case 'retest':
        return { ...base, kind: 'retest', objectiveRef: proposal.findingId, capabilityId: null, inputRef: { findingId: proposal.findingId }, fingerprint: actionFingerprint('retest', { objectiveRef: proposal.findingId }), costClass: 'normal', expectedInformationGain: 2 }
      case 'verify':
        return { ...base, kind: 'verify', objectiveRef: null, capabilityId: null, inputRef: {}, fingerprint: actionFingerprint('verify', { input: 'ai' }), costClass: 'cheap', expectedInformationGain: 2 }
      case 'attack-path':
        return { ...base, kind: 'attack-path', objectiveRef: null, capabilityId: null, inputRef: {}, fingerprint: actionFingerprint('attack-path', { input: 'ai' }), costClass: 'cheap', expectedInformationGain: 1 }
      default:
        return null
    }
  }

  #dedupe(candidates: CandidateAction[]): CandidateAction[] {
    const seen = new Set<string>()
    const out: CandidateAction[] = []
    for (const c of candidates) {
      if (seen.has(c.fingerprint)) continue
      seen.add(c.fingerprint)
      out.push(c)
    }
    return out
  }

  async #recordAction(run: SecurityResearchRun, candidate: CandidateAction, state: 'proposed' | 'rejected', rank: number, rejection: import('@audivra/contracts').ActionRejection | null): Promise<string> {
    const id = newResearchActionId()
    await insertResearchAction(this.#db, {
      id,
      runId: run.id,
      engagementId: run.engagementId,
      iteration: run.iteration,
      kind: candidate.kind,
      origin: candidate.origin,
      state,
      objectiveRef: candidate.objectiveRef,
      capabilityId: candidate.capabilityId,
      inputRef: candidate.inputRef,
      fingerprint: candidate.fingerprint,
      costClass: candidate.costClass,
      expectedInformationGain: candidate.expectedInformationGain,
      rank,
      reason: candidate.reason,
    })
    if (rejection) await updateResearchAction(this.#db, id, { rejection })
    return id
  }

  async #advance(runId: string, usage: SecurityResearchRun['usage'], providerAvailable: boolean, decision: string): Promise<SecurityResearchRun> {
    usage.iterations++
    const row = await updateResearchRun(this.#db, runId, { iteration: usage.iterations, usage, providerAvailable, lastDecision: decision.slice(0, 400), state: providerAvailable ? 'running' : 'degraded' })
    return toResearchRun(row!)
  }

  async #terminate(run: SecurityResearchRun, reason: ResearchTermination, decision: string): Promise<SecurityResearchRun> {
    const coverageAfter = await coverageSnapshot(this.#db, run.engagementId)
    const residual = await residualUncertainty(this.#db, run.engagementId, coverageAfter)
    const row = await updateResearchRun(this.#db, run.id, { state: reason === 'system-failure' ? 'failed' : 'stopped', stage: 'reflect', terminationReason: reason, coverageAfter, residual, lastDecision: decision.slice(0, 400), finishedAt: this.#now() })
    const engagement = await getEngagementRow(this.#db, run.engagementId)
    await this.#event(run.engagementId, engagement?.configVersion ?? 0, 'research.stopped', `Research stopped: ${reason} — ${decision}`.slice(0, 220), LOCAL_USER, { runId: run.id, reason }, reason === 'system-failure' ? 'error' : 'info')
    this.#log?.info({ runId: run.id, reason, usage: row?.usage }, 'research run stopped')
    return toResearchRun(row!)
  }

  async #load(runId: string): Promise<SecurityResearchRun> {
    const row = await getResearchRunRow(this.#db, runId)
    if (!row) throw new SecurityRequestError(404, `No research run ${runId}`)
    return toResearchRun(row)
  }

  async #event(engagementId: string, configVersion: number, type: SecurityEventType, message: string, actor: SecurityActor, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    await recordSecurityEvent(this.#db, { engagementId, type, level, message, actor, configVersion, data })
  }
}
