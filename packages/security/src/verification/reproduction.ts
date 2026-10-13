import type { ReproductionArm, ReproductionRecord } from '@audivra/contracts'
import type { KnowledgeView } from '../reasoning/knowledge.ts'
import type { EvaluableCandidate } from './evaluate.ts'

/*
 * Phase 6A — a structured, replayable reproduction record built from REAL stored state: the executed
 * comparison arms (who ran as which identity against which resource, and what came back), the executions
 * that produced them, the before/after state of a state-changing comparison, and the evidence artifacts.
 * Nothing is invented; an arm that never executed carries nulls, and a candidate with no runnable evidence
 * yields null rather than a fabricated recipe.
 */

export function buildReproduction(candidate: EvaluableCandidate, view: KnowledgeView): ReproductionRecord | null {
  const comparison = candidate.source.comparisonId ? view.comparisons.find((c) => c.id === candidate.source.comparisonId) : undefined
  if (comparison) {
    const arms: ReproductionArm[] = comparison.arms.map((a) => ({
      role: a.role,
      identityRef: a.identityRef,
      sessionRef: a.sessionRef,
      resourceRef: a.resourceRef,
      url: a.url,
      method: a.method,
      responseClass: a.observation?.responseClass ?? null,
      status: a.observation?.status ?? null,
    }))
    const executionIds = [...new Set(comparison.arms.map((a) => a.executionId).filter((id): id is string => !!id))]
    const evidenceRefs = [...new Set([...comparison.evidenceRefs, ...comparison.arms.flatMap((a) => a.observation?.evidenceRefs ?? [])])]
    return {
      executionIds,
      comparisonId: comparison.id,
      arms,
      stateBefore: comparison.state?.before?.businessResult ?? comparison.state?.before?.responseClass ?? null,
      stateAfter: comparison.state?.after?.businessResult ?? comparison.state?.after?.responseClass ?? null,
      evidenceRefs,
    }
  }

  // Non-comparison origin: record the executions and evidence behind the cited observations.
  const observations = candidate.source.observationIds.map((id) => view.observations.get(id)).filter((o) => !!o)
  const executionIds = [...new Set(observations.flatMap((o) => o!.contributions.map((c) => c.executionId)))]
  const evidenceRefs = [...new Set([...candidate.supportingEvidenceRefs, ...observations.flatMap((o) => o!.evidenceRefs)])]
  if (!executionIds.length && !evidenceRefs.length) return null
  return { executionIds, comparisonId: null, arms: [], stateBefore: null, stateAfter: null, evidenceRefs }
}
