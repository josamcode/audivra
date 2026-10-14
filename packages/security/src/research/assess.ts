import type {
  ActionCostClass,
  ResearchActionKind,
  ResearchActionOrigin,
  RetestCase,
  SecurityAttackPath,
  SecurityComparison,
  SecurityFinding,
  SecurityResearchAction,
  SecurityResearchRun,
  SecurityVerificationCandidate,
} from '@audivra/contracts'
import type { RankedPlan } from '../comparison/plan.ts'
import { actionFingerprint, comparisonPlanFingerprint } from './fingerprint.ts'

/*
 * Phase 6E — the deterministic ASSESS stage. From the engagement's STORED state it derives the candidate next
 * actions, cheap-first: controlled comparisons the planner proposes (the focused authorization/business-rule
 * investigations), a verification pass when inconsistent comparisons lack findings, an attack-path refresh
 * when findings exist, retests when the objective is historical, and — only as a conservative last resort —
 * an expensive specialist run. This stage is largely deterministic; the AI's proposals are merged in later as
 * advisory candidates. A valid outcome of ASSESS is "no useful next action".
 */

export interface CandidateAction {
  kind: ResearchActionKind
  origin: ResearchActionOrigin
  objectiveRef: string | null
  capabilityId: string | null
  inputRef: Record<string, unknown>
  fingerprint: string
  costClass: ActionCostClass
  expectedInformationGain: number
  reason: string
}

export interface AssessContext {
  run: SecurityResearchRun
  proposals: readonly RankedPlan[]
  comparisons: readonly SecurityComparison[]
  candidates: readonly SecurityVerificationCandidate[]
  findings: readonly SecurityFinding[]
  attackPaths: readonly SecurityAttackPath[]
  retestCases: readonly RetestCase[]
  specialistAvailable: boolean
  specialistBudgetLeft: boolean
}

export function assess(ctx: AssessContext): CandidateAction[] {
  const out: CandidateAction[] = []
  const objective = ctx.run.objective

  // 1. Controlled comparisons (cheap, focused) — the core of authorization / business-rule investigation.
  if (objective !== 'retest-previous') {
    for (const ranked of ctx.proposals.slice(0, 6)) {
      out.push({
        kind: 'comparison',
        origin: 'deterministic',
        objectiveRef: ranked.plan.resourceRef,
        capabilityId: null,
        inputRef: ranked.plan as unknown as Record<string, unknown>,
        fingerprint: actionFingerprint('comparison', { input: comparisonPlanFingerprint(ranked.plan) }),
        costClass: 'normal',
        expectedInformationGain: ranked.informationGain,
        reason: ranked.reason,
      })
    }
  }

  // 2. Verification — when inconsistent comparisons exist without a corresponding finding.
  const inconsistent = ctx.comparisons.filter((c) => c.result === 'inconsistent').length
  if (inconsistent > ctx.findings.length) {
    out.push({
      kind: 'verify',
      origin: 'deterministic',
      objectiveRef: null,
      capabilityId: null,
      inputRef: {},
      fingerprint: actionFingerprint('verify', { input: `inconsistent:${inconsistent}:findings:${ctx.findings.length}` }),
      costClass: 'cheap',
      expectedInformationGain: Math.min(5, (inconsistent - ctx.findings.length) * 2),
      reason: `${inconsistent} inconsistent comparison(s) await independent verification.`,
    })
  }

  // 3. Attack-path refresh — when findings exist and the route picture may have changed.
  if (ctx.findings.length > 0) {
    out.push({
      kind: 'attack-path',
      origin: 'deterministic',
      objectiveRef: null,
      capabilityId: null,
      inputRef: {},
      fingerprint: actionFingerprint('attack-path', { input: `findings:${ctx.findings.length}:paths:${ctx.attackPaths.length}` }),
      costClass: 'cheap',
      expectedInformationGain: ctx.attackPaths.length === 0 ? 3 : 1,
      reason: `Analyse evidence-backed attack paths over ${ctx.findings.length} finding(s).`,
    })
  }

  // 4. Retest — for a historical objective with eligible cases.
  if (objective === 'retest-previous') {
    for (const testCase of ctx.retestCases.slice(0, 6)) {
      if (!testCase.eligibility.eligible) continue
      out.push({
        kind: 'retest',
        origin: 'deterministic',
        objectiveRef: testCase.findingId,
        capabilityId: null,
        inputRef: { retestCaseId: testCase.id },
        fingerprint: actionFingerprint('retest', { objectiveRef: testCase.id }),
        costClass: 'normal',
        expectedInformationGain: 3,
        reason: `Retest a previously verified issue (${testCase.title.slice(0, 80)}).`,
      })
    }
  }

  // 5. Specialist — a conservative last resort (cheap-before-expensive). Only when no cheaper comparison
  //    remains, the objective is broad, the engine is available and budget allows. Never because of uncertainty.
  const cheaperRemains = out.some((a) => a.costClass !== 'expensive')
  if (!cheaperRemains && ctx.specialistAvailable && ctx.specialistBudgetLeft && (objective === 'investigate-api-surface' || objective === 'maximize-coverage')) {
    out.push({
      kind: 'specialist',
      origin: 'deterministic',
      objectiveRef: null,
      capabilityId: 'specialist.strix-research',
      inputRef: { mode: 'source-only' },
      fingerprint: actionFingerprint('specialist', { input: 'source-only' }),
      costClass: 'expensive',
      expectedInformationGain: 2,
      reason: 'No cheaper focused capability remains; broad specialist source-review may add meaningful information.',
    })
  }

  return out
}

/** Whether a candidate repeats recent work (same fingerprint) without new evidence to justify it. */
export function isRepeat(candidate: CandidateAction, history: readonly SecurityResearchAction[]): boolean {
  return history.some((a) => a.fingerprint === candidate.fingerprint && (a.state === 'completed' || a.state === 'blocked'))
}
