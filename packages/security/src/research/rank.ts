import type { ActionCostClass, SecurityResearchAction } from '@audivra/contracts'
import type { CandidateAction } from './assess.ts'

/*
 * Phase 6E — deterministic ranking. Audivra (not the model) orders actions by expected information gain,
 * cost, repeated-failure memory and risk. The AI's own priority is advisory only (a small bonus). This is
 * what keeps the researcher from doing redundant or needlessly expensive work.
 */

const COST_PENALTY: Record<ActionCostClass, number> = { cheap: 0, normal: 0.5, expensive: 4 }

export interface RankedCandidate {
  candidate: CandidateAction
  score: number
  rank: number
}

export function rankCandidates(candidates: readonly CandidateAction[], history: readonly SecurityResearchAction[], aiPriority: Map<string, 'low' | 'medium' | 'high'>): RankedCandidate[] {
  // Failed-action memory: a fingerprint that previously failed/produced nothing is strongly penalized (§8, §28).
  const penalized = new Map<string, number>()
  for (const a of history) {
    if (a.usefulness === 'failed' || a.usefulness === 'no-new-information' || a.usefulness === 'blocked' || a.state === 'blocked' || a.state === 'rejected') {
      // A fingerprint that previously failed / produced nothing is strongly deprioritized so the loop does
      // not keep selecting equivalent unproductive work.
      penalized.set(a.fingerprint, (penalized.get(a.fingerprint) ?? 0) + 5)
    }
  }
  const bonus = { low: 0, medium: 0.3, high: 0.6 } as const
  const scored = candidates.map((candidate) => {
    const ai = aiPriority.get(candidate.fingerprint)
    const score = candidate.expectedInformationGain * 2 - COST_PENALTY[candidate.costClass] - (penalized.get(candidate.fingerprint) ?? 0) + (ai ? bonus[ai] : 0)
    return { candidate, score }
  })
  scored.sort((a, b) => b.score - a.score || a.candidate.costClass.localeCompare(b.candidate.costClass))
  return scored.map((s, i) => ({ ...s, rank: i }))
}
