import type {
  ConfidenceFactors,
  DataSensitivity,
  ExploitPrerequisite,
  FindingVerifierOutput,
  FindingVerifierVerdict,
  SeverityInputs,
  VerificationState,
} from '@audivra/contracts'
import type { KnowledgeView } from '../reasoning/knowledge.ts'
import type { DeterministicOutcome, EvaluableCandidate } from './evaluate.ts'
import { computeConfidence } from './severity.ts'
import { buildReproduction } from './reproduction.ts'

/*
 * Phase 6A — the verification decision. The deterministic disposition (does the required evidence exist?)
 * and the independent verifier's verdict (does a cautious reviewer agree?) are combined under one rule: the
 * verifier may only ever make the outcome MORE cautious. A candidate becomes `verified` only when AUDIVRA's
 * checks are all met AND an independent verifier confirms; a provider failure is `blocked`, never `verified`;
 * a material contradiction is `inconclusive`; and the verifier can never upgrade partial evidence.
 */

export type VerifierResolution =
  | { kind: 'ran'; output: FindingVerifierOutput }
  | { kind: 'failed'; detail: string }
  | { kind: 'skipped' }

export interface VerificationDecision {
  status: VerificationState
  statusReason: string
  verdict: FindingVerifierVerdict
}

export function resolveVerification(outcome: DeterministicOutcome, verifier: VerifierResolution): VerificationDecision {
  // Provider failure never yields a verified (or even supported) finding.
  if (verifier.kind === 'failed') return { status: 'blocked', statusReason: `Independent verification unavailable: ${verifier.detail}`, verdict: 'not-run' }
  const verdict: FindingVerifierVerdict = verifier.kind === 'ran' ? verifier.output.verdict : 'not-run'

  if (outcome.disposition === 'contradicted') return { status: 'inconclusive', statusReason: outcome.reason, verdict }
  if (outcome.disposition === 'insufficient') return { status: 'needs-evidence', statusReason: outcome.reason, verdict }

  // The verifier disproving overrides down to rejected from any positive disposition.
  if (verifier.kind === 'ran' && verifier.output.verdict === 'disprove') {
    return { status: 'rejected', statusReason: `Independent verifier disproved it: ${verifier.output.rationale}`, verdict }
  }
  if (verifier.kind === 'ran' && verifier.output.verdict === 'alternative') {
    return { status: 'inconclusive', statusReason: `A plausible benign explanation remains: ${verifier.output.alternativeExplanation ?? verifier.output.rationale}`, verdict }
  }

  if (outcome.disposition === 'partial') {
    return { status: 'supported', statusReason: `${outcome.reason} (not fully verified)`, verdict }
  }

  // disposition === 'complete'
  if (verifier.kind === 'ran' && verifier.output.verdict === 'confirm') {
    return { status: 'verified', statusReason: `All requirements met and independently confirmed: ${verifier.output.rationale}`, verdict }
  }
  if (verifier.kind === 'ran' && verifier.output.verdict === 'needs-evidence') {
    return { status: 'supported', statusReason: `All deterministic requirements met; verifier wants more evidence before confirming`, verdict }
  }
  // Complete but no independent verifier confirmed it — scanner/AI alone cannot make a verified finding.
  return { status: 'supported', statusReason: `All deterministic requirements met; awaiting independent confirmation`, verdict }
}

// ── Severity inputs & confidence factors (deterministic, from stored state) ──────────────────────────────

const PRIVILEGE_DIMENSIONS = new Set(['role-boundary', 'function-level'])

export function buildSeverityInputs(candidate: EvaluableCandidate, view: KnowledgeView, confidence: number): SeverityInputs {
  const comparison = candidate.source.comparisonId ? view.comparisons.find((c) => c.id === candidate.source.comparisonId) : undefined
  const subject = comparison?.arms.find((a) => a.role === 'subject')
  const nodes = candidate.affectedEntityKeys.map((k) => view.nodesByKey.get(k)).filter((n) => !!n)
  const scopeClass = nodes.find((n) => n!.scopeClass === 'out-of-scope')?.scopeClass ?? nodes.find((n) => n!.scopeClass === 'third-party')?.scopeClass ?? 'in-scope'

  const tenantBoundaryCrossed = comparison?.result === 'inconsistent' && (comparison.dimension === 'tenant-boundary' || comparison.resourceRelationship === 'different-tenant')
  const privilegeBoundaryCrossed = comparison?.result === 'inconsistent' && PRIVILEGE_DIMENSIONS.has(comparison.dimension)

  let exploitPrerequisites: ExploitPrerequisite = 'none'
  if (comparison) exploitPrerequisites = subject?.identityRef ? 'authenticated' : 'none'
  else if (candidate.category === 'authorization' || candidate.category === 'tenant-isolation' || candidate.category === 'business-logic') exploitPrerequisites = 'authenticated'

  const dataSensitivity: DataSensitivity = tenantBoundaryCrossed ? 'high' : candidate.category === 'tenant-isolation' ? 'high' : 'unknown'

  return {
    category: candidate.category as SeverityInputs['category'],
    scopeClass,
    privilegeBoundaryCrossed: !!privilegeBoundaryCrossed,
    tenantBoundaryCrossed: !!tenantBoundaryCrossed,
    dataSensitivity,
    exploitPrerequisites,
    confidence,
    environment: view.engagement.environment ?? 'production',
  }
}

export function buildConfidenceFactors(candidate: EvaluableCandidate, view: KnowledgeView, outcome: DeterministicOutcome): ConfidenceFactors {
  const comparison = candidate.source.comparisonId ? view.comparisons.find((c) => c.id === candidate.source.comparisonId) : undefined
  const subject = comparison?.arms.find((a) => a.role === 'subject')
  const corroborationMet = outcome.results.some((r) => r.check === 'independent-corroboration' && r.met)
  const reproduction = buildReproduction(candidate, view)
  return {
    directObservation: candidate.supportingEvidenceRefs.length > 0 && outcome.disposition !== 'insufficient',
    independentCorroboration: corroborationMet || !!(comparison?.controls.positive && comparison.controls.negative),
    positiveControl: comparison?.controls.positive === true,
    negativeControl: comparison?.controls.negative === true,
    deterministicReproduction: !!reproduction && reproduction.executionIds.length > 0,
    contradictoryEvidence: candidate.contradictingEvidenceRefs.length > 0,
    aiInferenceDependency: subject?.expected.basis === 'ai-inferred' || (!comparison && candidate.source.origin === 'confirmed-signal-hypothesis'),
  }
}

/** Confidence from the candidate's evidence quality, in one call. */
export function confidenceFor(candidate: EvaluableCandidate, view: KnowledgeView, outcome: DeterministicOutcome): { confidence: number; factors: ConfidenceFactors } {
  const factors = buildConfidenceFactors(candidate, view, outcome)
  return { confidence: computeConfidence(factors), factors }
}
