import type { CandidateSource, SecurityComparison, VerificationCheck, VerificationCheckResult } from '@audivra/contracts'
import type { KnowledgeView } from '../reasoning/knowledge.ts'

/*
 * Phase 6A — the deterministic verification core. AUDIVRA (not the AI) decides whether the machine-checkable
 * evidence a candidate's requirements demand actually exists in stored state. Each VerificationCheck is
 * evaluated against the graph, the observations, the comparisons and the candidate's own cited evidence;
 * the verifier's prose never satisfies a check. A material contradiction (`no-material-contradiction` unmet)
 * forces an inconclusive disposition — contradicting evidence is preserved, never discarded.
 */

/** The candidate fields the evaluator reads (satisfied by a generated or a persisted candidate). */
export interface EvaluableCandidate {
  category: string
  affectedEntityKeys: string[]
  supportingEvidenceRefs: string[]
  contradictingEvidenceRefs: string[]
  source: CandidateSource
  requiredChecks: VerificationCheck[]
}

export interface DeterministicOutcome {
  results: VerificationCheckResult[]
  /**
   * `complete`   — every required check met; eligible to become `verified` once an independent verifier confirms.
   * `partial`    — some supporting checks met, but not all required ones; at most `supported`.
   * `contradicted` — a material contradiction; forces `inconclusive`.
   * `insufficient` — effectively no evidence; `needs-evidence`.
   */
  disposition: 'complete' | 'partial' | 'contradicted' | 'insufficient'
  reason: string
}

const comparisonOf = (candidate: EvaluableCandidate, view: KnowledgeView): SecurityComparison | undefined =>
  candidate.source.comparisonId ? view.comparisons.find((c) => c.id === candidate.source.comparisonId) : undefined

/** Distinct tools that reported the candidate's supporting observations. */
function supportingTools(candidate: EvaluableCandidate, view: KnowledgeView): string[] {
  const tools = new Set<string>()
  for (const id of candidate.source.observationIds) for (const c of view.observations.get(id)?.contributions ?? []) tools.add(c.tool)
  return [...tools]
}

function evaluateOne(check: VerificationCheck, index: number, candidate: EvaluableCandidate, view: KnowledgeView): VerificationCheckResult {
  const base = { index, check: check.check }
  switch (check.check) {
    case 'evidence-present': {
      const refs = candidate.supportingEvidenceRefs
      return { ...base, met: refs.length >= check.min, detail: `${refs.length} supporting evidence artifact(s); needs ${check.min}`, evidenceRefs: refs.slice(0, 20) }
    }
    case 'affected-entity-known': {
      const known = candidate.affectedEntityKeys.filter((k) => view.nodesByKey.has(k))
      return { ...base, met: known.length > 0, detail: known.length ? `Affects known entities: ${known.join(', ')}` : 'No affected entity resolves to a graph node', evidenceRefs: [] }
    }
    case 'positive-control': {
      const c = comparisonOf(candidate, view)
      return { ...base, met: c?.controls.positive === true, detail: c ? `Positive control ${c.controls.positive ? 'present' : 'absent'} in comparison ${c.id}` : 'No linked comparison', evidenceRefs: [] }
    }
    case 'negative-control': {
      const c = comparisonOf(candidate, view)
      return { ...base, met: c?.controls.negative === true, detail: c ? `Negative control ${c.controls.negative ? 'present' : 'absent'} in comparison ${c.id}` : 'No linked comparison', evidenceRefs: [] }
    }
    case 'semantic-difference': {
      const c = comparisonOf(candidate, view)
      const relevant = c?.semanticDifferences.filter((d) => d.securityRelevant) ?? []
      return { ...base, met: relevant.length > 0, detail: relevant.length ? `${relevant.length} security-relevant difference(s): ${relevant.map((d) => d.aspect).join(', ')}` : 'No security-relevant semantic difference', evidenceRefs: [] }
    }
    case 'comparison-result': {
      const c = comparisonOf(candidate, view)
      const met = !!c && c.status === 'completed' && check.results.includes(c.result)
      return { ...base, met, detail: c ? `Comparison ${c.id} → ${c.result} (needs ${check.results.join('/')})` : 'No linked comparison', evidenceRefs: c?.evidenceRefs.slice(0, 20) ?? [] }
    }
    case 'invariant-contradicted': {
      const c = comparisonOf(candidate, view)
      return { ...base, met: c?.invariantEvaluation === 'contradicted', detail: c ? `Invariant evaluation: ${c.invariantEvaluation ?? 'none'}` : 'No linked comparison', evidenceRefs: [] }
    }
    case 'independent-corroboration': {
      const c = comparisonOf(candidate, view)
      const controlBases = c && c.controls.positive && c.controls.negative ? 2 : c && (c.controls.positive || c.controls.negative) ? 1 : 0
      const tools = supportingTools(candidate, view)
      const bases = Math.max(tools.length, controlBases)
      return { ...base, met: bases >= check.min, detail: `${bases} independent basis/bases (${tools.length} tools${controlBases ? `, ${controlBases} control arm(s)` : ''}); needs ${check.min}`, evidenceRefs: [] }
    }
    case 'config-observation': {
      const matching = candidate.source.observationIds.map((id) => view.observations.get(id)).filter((o) => o?.type === check.observationType)
      return { ...base, met: matching.length > 0, detail: matching.length ? `${matching.length} ${check.observationType} observation(s)` : `No ${check.observationType} observation cited`, evidenceRefs: matching.flatMap((o) => o?.evidenceRefs ?? []).slice(0, 20) }
    }
    case 'dependency-evidence': {
      const matching = candidate.source.observationIds.map((id) => view.observations.get(id)).filter((o) => o?.type === 'dependency' || o?.type === 'dependency-vulnerability')
      return { ...base, met: matching.length > 0, detail: matching.length ? `${matching.length} dependency observation(s)` : 'No dependency observation cited', evidenceRefs: matching.flatMap((o) => o?.evidenceRefs ?? []).slice(0, 20) }
    }
    case 'expectation-provenance': {
      const c = comparisonOf(candidate, view)
      const subject = c?.arms.find((a) => a.role === 'subject')
      const basis = subject?.expected.basis ?? 'unknown'
      const grounded = basis === 'declared' || basis === 'code-derived' || basis === 'observed'
      return { ...base, met: grounded, detail: `Expectation basis: ${basis}${grounded ? '' : ' (not grounded — an AI-inferred or unknown expectation is not proof)'}`, evidenceRefs: [] }
    }
    case 'no-material-contradiction': {
      const refs = candidate.contradictingEvidenceRefs
      return { ...base, met: refs.length === 0, detail: refs.length ? `${refs.length} unresolved contradicting artifact(s)` : 'No material contradiction', evidenceRefs: refs.slice(0, 20) }
    }
  }
}

/**
 * Evaluates every required check against stored state and decides the deterministic disposition. A material
 * contradiction dominates (inconclusive); otherwise all-met is `complete`, any-supporting-met is `partial`,
 * and nothing met is `insufficient`.
 */
export function evaluateCandidate(candidate: EvaluableCandidate, view: KnowledgeView): DeterministicOutcome {
  const results = candidate.requiredChecks.map((c, i) => evaluateOne(c, i, candidate, view))
  const contradiction = results.find((r) => r.check === 'no-material-contradiction' && !r.met)
  if (contradiction) return { results, disposition: 'contradicted', reason: `Material contradiction: ${contradiction.detail}` }
  const substantive = results.filter((r) => r.check !== 'no-material-contradiction')
  const met = substantive.filter((r) => r.met)
  if (substantive.length && met.length === substantive.length) return { results, disposition: 'complete', reason: `All ${substantive.length} verification requirement(s) met` }
  if (met.length) return { results, disposition: 'partial', reason: `${met.length}/${substantive.length} requirement(s) met: ${results.filter((r) => !r.met).map((r) => r.check).join(', ')} outstanding` }
  return { results, disposition: 'insufficient', reason: 'No verification requirement met' }
}
