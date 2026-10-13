import type { CheckResult, EvidenceCheck, HypothesisImpact, HypothesisRanking, SecurityGraphNode, SecurityHypothesis } from '@audivra/contracts'
import { checkEntity, checkNeeds, evaluateCheck } from './hypotheses.ts'
import { entityTargetUrl, type KnowledgeView, type PlanningCapability } from './knowledge.ts'

/*
 * Deterministic, explainable hypothesis ranking. Priority comes from what investigating would *teach*
 * Audivra per unit of cost and risk — never from how enthusiastic a model sounded.
 *
 *   uncertainty      binary entropy of the confidence (1 = no idea, 0 = settled)
 *   resolvability    how directly the best eligible capability produces the evidence the unmet checks need
 *   expected gain    uncertainty × resolvability × 0.5^failedAttempts
 *   priority         100 × impact × (0.55·gain + 0.20·evidenceGap + 0.15·centrality + 0.10·novelty)
 *                    ÷ (1 + 0.25·(costUnits − 1))  − 10·riskPenalty
 *
 * So a high-impact, low-confidence hypothesis one cheap capability can settle outranks a well-supported one
 * that only an expensive capability could nudge.
 */

export const IMPACT_WEIGHT: Record<HypothesisImpact, number> = { low: 0.4, medium: 0.7, high: 1 }
const RISK_PENALTY: Record<string, number> = { passive: 0, 'low-impact': 0.1, 'state-changing': 1, 'high-impact': 1, destructive: 1 }
/** Below this expected gain the loop stops rather than spend budget learning almost nothing. */
export const LOW_GAIN_THRESHOLD = 0.12

export function binaryEntropy(p: number): number {
  const c = Math.min(0.99, Math.max(0.01, p))
  return -(c * Math.log2(c) + (1 - c) * Math.log2(1 - c))
}

/** Where a capability would have to look to learn about an entity (in-scope URLs only). */
export function planningTargets(view: KnowledgeView, entityId: string): string[] {
  const node = view.nodes.get(entityId)
  if (!node) return []
  const inScope = (n: SecurityGraphNode | undefined) => !!n && (n.scopeClass === 'in-scope' || n.scopeClass === null)
  const direct = entityTargetUrl(node)
  if (direct) return inScope(node) ? [direct] : []
  const edges = view.adjacency.get(node.id) ?? []
  const via = (n: SecurityGraphNode | undefined): string[] => (n && n.kind !== node.kind ? planningTargets(view, n.id) : [])
  if (node.kind === 'technology') {
    // A technology is learned about on the hosts that depend on it (where it was seen).
    return [...new Set(edges.filter((e) => e.type === 'DEPENDS_ON' && e.toId === node.id).flatMap((e) => via(view.nodes.get(e.fromId))))]
  }
  if (node.kind === 'signal') return [...new Set(edges.filter((e) => e.type === 'AFFECTS' && e.fromId === node.id).flatMap((e) => via(view.nodes.get(e.toId))))]
  if (node.kind === 'parameter') return [...new Set(edges.filter((e) => e.type === 'READS' && e.toId === node.id).flatMap((e) => via(view.nodes.get(e.fromId))))]
  return []
}

export interface CapabilityFit {
  capability: PlanningCapability
  /** Fraction of the unmet checks it can produce evidence for (0..1). */
  resolvability: number
  targets: string[]
  previouslyTried: boolean
}

/** How well each eligible capability fits a hypothesis' unmet checks. */
export function capabilityFits(h: Pick<SecurityHypothesis, 'id' | 'evidenceChecks' | 'candidateCapabilities'>, results: CheckResult[], view: KnowledgeView): CapabilityFit[] {
  const unmet: EvidenceCheck[] = h.evidenceChecks.filter((_, i) => !results[i]?.met)
  if (unmet.length === 0) return []
  const fits: CapabilityFit[] = []
  for (const capability of view.capabilities) {
    if (!capability.eligibleHere || !capability.plannable) continue
    let covered = 0
    const targets = new Set<string>()
    for (const check of unmet) {
      const needs = checkNeeds(check, view)
      if (!capability.observationTypes.some((t) => needs.includes(t))) continue
      const entityId = checkEntity(check, view)
      if (!entityId) continue
      // Independent corroboration needs a *different* sensor than the ones that already reported it.
      if (check.check === 'independent-corroboration' && view.nodes.get(entityId)?.tools.includes(capability.tool)) continue
      const entityTargets = planningTargets(view, entityId)
      if (entityTargets.length === 0) continue
      covered++
      for (const t of entityTargets) targets.add(t)
    }
    if (covered === 0) continue
    const previouslyTried = view.actions.some((a) => a.hypothesisId === h.id && a.capabilityId === capability.id && (a.status === 'completed' || a.status === 'failed'))
    fits.push({ capability, resolvability: covered / unmet.length, targets: [...targets].sort(), previouslyTried })
  }
  // Named candidates first among equals, then cheaper, then by id (deterministic).
  return fits.sort(
    (a, b) =>
      b.resolvability * (b.previouslyTried ? 0.3 : 1) / b.capability.costUnits - (a.resolvability * (a.previouslyTried ? 0.3 : 1)) / a.capability.costUnits ||
      Number(h.candidateCapabilities.includes(b.capability.id)) - Number(h.candidateCapabilities.includes(a.capability.id)) ||
      a.capability.id.localeCompare(b.capability.id),
  )
}

export function rankHypothesis(h: SecurityHypothesis, view: KnowledgeView, now: string): HypothesisRanking {
  const results = h.evidenceChecks.map((c, i) => evaluateCheck(c, i, view))
  const fits = capabilityFits(h, results, view)
  const best = fits[0] ?? null
  const unmet = results.filter((r) => !r.met).length
  const impact = IMPACT_WEIGHT[h.impact]
  const uncertainty = binaryEntropy(h.confidence)
  const resolvability = best ? best.resolvability * (best.previouslyTried ? 0.3 : 1) : 0
  const failedAttempts = h.attempts
  const expectedInformationGain = Math.round(uncertainty * resolvability * 0.5 ** failedAttempts * 1000) / 1000
  const degree = Math.max(0, ...h.subjectEntityIds.map((id) => view.adjacency.get(id)?.length ?? 0))
  const centrality = Math.min(1, degree / 8)
  const evidenceGap = h.evidenceChecks.length ? unmet / h.evidenceChecks.length : 0
  const novelty = view.actions.some((a) => a.hypothesisId === h.id && a.status !== 'rejected') ? 0.3 : 1
  const costUnits = best?.capability.costUnits ?? 0
  const riskPenalty = best ? (RISK_PENALTY[best.capability.riskClass] ?? 1) : 0
  const value = 0.55 * expectedInformationGain + 0.2 * evidenceGap + 0.15 * centrality + 0.1 * novelty
  const priority = best ? Math.max(0, Math.min(100, Math.round((100 * impact * value) / (1 + 0.25 * (costUnits - 1)) - 10 * riskPenalty))) : 0
  const explanation = best
    ? `${h.impact} impact, confidence ${h.confidence.toFixed(2)} (uncertainty ${uncertainty.toFixed(2)}); ${best.capability.id} (${best.capability.costClass} cost, ${best.capability.riskClass}) can produce evidence for ${Math.round(best.resolvability * h.evidenceChecks.filter((_, i) => !results[i]?.met).length)} of ${unmet} unmet check${unmet === 1 ? '' : 's'}${best.previouslyTried ? ' (already tried once)' : ''} → expected gain ${expectedInformationGain.toFixed(2)}${failedAttempts ? `, ${failedAttempts} earlier attempt${failedAttempts === 1 ? '' : 's'} did not resolve it` : ''}.`
    : unmet === 0
      ? 'Every check has been decided; nothing left to learn.'
      : 'No capability that may run here can produce the evidence the unmet checks need.'
  return {
    priority,
    expectedInformationGain,
    factors: { impact, confidence: h.confidence, uncertainty: Math.round(uncertainty * 1000) / 1000, resolvability: Math.round(resolvability * 1000) / 1000, centrality, evidenceGap: Math.round(evidenceGap * 1000) / 1000, novelty, costUnits, riskPenalty, failedAttempts, environmentEligible: !!best },
    bestCapabilityId: best?.capability.id ?? null,
    explanation,
    rankedAt: now,
  }
}
