import type { ActionRejection, SecurityResearchAction, SecurityResearchRun } from '@audivra/contracts'
import type { CandidateAction } from './assess.ts'
import { isRepeat } from './assess.ts'

/*
 * Phase 6E — deterministic proposal validation. Every candidate (deterministic OR AI-proposed) must pass
 * these checks before it can run. The AI can never bypass them. Cross-candidate rules (cheap-before-expensive)
 * are applied over the whole batch so an expensive specialist action is rejected while a cheaper alternative
 * is viable.
 */

export interface ValidateContext {
  run: SecurityResearchRun
  history: readonly SecurityResearchAction[]
  declaredResourceRefs: Set<string>
  findingIds: Set<string>
  specialistAvailable: boolean
}

export interface Validated {
  candidate: CandidateAction
  ok: boolean
  rejection: ActionRejection | null
  detail: string
}

function validateOne(candidate: CandidateAction, ctx: ValidateContext): { rejection: ActionRejection; detail: string } | null {
  if (isRepeat(candidate, ctx.history)) return { rejection: 'duplicate', detail: 'This action was already attempted with the same meaningful input.' }

  // AI-proposed references must already exist — the AI can never invent a resource/finding.
  if (candidate.origin === 'ai-proposed') {
    if (candidate.kind === 'comparison' && !candidate.inputRef.arms) return { rejection: 'input-invalid', detail: 'No resolvable comparison plan for the proposed resource.' }
    if (candidate.objectiveRef && candidate.kind === 'retest' && !ctx.findingIds.has(candidate.objectiveRef)) return { rejection: 'reference-missing', detail: `Finding ${candidate.objectiveRef} does not exist.` }
    const resourceRef = typeof candidate.inputRef.resourceRef === 'string' ? candidate.inputRef.resourceRef : null
    if (resourceRef && !ctx.declaredResourceRefs.has(resourceRef)) return { rejection: 'reference-missing', detail: `Resource ${resourceRef} is not declared.` }
  }

  if (candidate.kind === 'specialist') {
    if (!ctx.specialistAvailable) return { rejection: 'specialist-unavailable', detail: 'The specialist engine is not available/ready.' }
    if (ctx.run.usage.specialistRuns >= ctx.run.budget.maxSpecialistRuns || ctx.run.usage.expensiveActions >= ctx.run.budget.maxExpensiveActions) return { rejection: 'budget-exceeded', detail: 'The specialist/expensive-action budget is exhausted.' }
  }
  return null
}

export function validateBatch(candidates: readonly CandidateAction[], ctx: ValidateContext): Validated[] {
  const results: Validated[] = candidates.map((candidate) => {
    const failed = validateOne(candidate, ctx)
    return failed ? { candidate, ok: false, rejection: failed.rejection, detail: failed.detail } : { candidate, ok: true, rejection: null, detail: '' }
  })
  // Cheap-before-expensive (§15): reject an expensive specialist action while a cheaper valid one remains.
  const cheaperValid = results.some((r) => r.ok && r.candidate.costClass !== 'expensive')
  if (cheaperValid) {
    for (const r of results) {
      if (r.ok && r.candidate.costClass === 'expensive') {
        r.ok = false
        r.rejection = 'too-expensive'
        r.detail = 'A cheaper focused capability can answer this question first (cheap-before-expensive).'
      }
    }
  }
  return results
}
