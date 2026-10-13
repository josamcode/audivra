import type {
  ConfidenceFactors,
  FindingAffectedEntity,
  FindingCategory,
  FindingProseOutput,
  ReproductionRecord,
  Severity,
  SeverityInputs,
  VerificationState,
} from '@audivra/contracts'
import { keyKind } from '../graph/identity.ts'
import type { KnowledgeView } from '../reasoning/knowledge.ts'
import { buildSeverityInputs, confidenceFor, type VerificationDecision } from './engine.ts'
import type { DeterministicOutcome, EvaluableCandidate } from './evaluate.ts'
import { buildReproduction } from './reproduction.ts'
import { computeSeverity, lessSevere } from './severity.ts'

/*
 * Phase 6A — turning a settled candidate into a Security Finding. Severity is computed deterministically from
 * the candidate's inputs; the reviewer's suggestion may only LOWER it. Confidence comes from evidence
 * quality. The AI prose fills title/impact/remediation but changes no fact, no severity and no confidence —
 * and when there is no prose (no provider, or synthesizing a supported signal) a deterministic fallback is
 * used so a finding is never blocked on narrative.
 */

export interface FindingSynthesisInput {
  candidate: EvaluableCandidate & { issueKey: string; category: FindingCategory; claim: string }
  view: KnowledgeView
  outcome: DeterministicOutcome
  decision: VerificationDecision
  prose: FindingProseOutput | null
  /** A reviewer's suggested severity (already validated structurally); it may only lower the severity. */
  reviewerSeverity?: Severity | null
}

export interface FindingSynthesis {
  issueKey: string
  title: string
  category: FindingCategory
  severity: Severity
  severityReason: string
  confidence: number
  verificationState: VerificationState
  affectedEntities: FindingAffectedEntity[]
  claim: string
  evidenceRefs: string[]
  contradictingEvidenceRefs: string[]
  impact: string
  remediation: string
  reproduction: ReproductionRecord | null
  severityInputs: SeverityInputs
  confidenceFactors: ConfidenceFactors
}

function affectedEntities(candidate: EvaluableCandidate, view: KnowledgeView): FindingAffectedEntity[] {
  return candidate.affectedEntityKeys.map((key) => {
    const node = view.nodesByKey.get(key)
    return { key, kind: node?.kind ?? keyKind(key), label: node?.label ?? key }
  })
}

export function synthesizeFinding(input: FindingSynthesisInput): FindingSynthesis {
  const { candidate, view, outcome, decision, prose, reviewerSeverity } = input
  const { confidence, factors } = confidenceFor(candidate, view, outcome)
  const severityInputs = buildSeverityInputs(candidate, view, confidence)
  const base = computeSeverity(severityInputs)
  // A reviewer may only make a finding more cautious: clamp its suggestion to no higher than AUDIVRA's.
  const severity: Severity = reviewerSeverity ? lessSevere(base.severity, reviewerSeverity) : base.severity
  const severityReason = reviewerSeverity && severity !== base.severity ? `${base.reason}; reviewer lowered to ${severity}` : base.reason

  const fallbackTitle = candidate.claim.slice(0, 120)
  return {
    issueKey: candidate.issueKey,
    title: (prose?.title ?? fallbackTitle).slice(0, 160),
    category: candidate.category,
    severity,
    severityReason,
    confidence,
    verificationState: decision.status,
    affectedEntities: affectedEntities(candidate, view),
    claim: candidate.claim,
    evidenceRefs: candidate.supportingEvidenceRefs,
    contradictingEvidenceRefs: candidate.contradictingEvidenceRefs,
    impact: prose?.impact ?? '',
    remediation: prose?.remediation ?? '',
    reproduction: buildReproduction(candidate, view),
    severityInputs,
    confidenceFactors: factors,
  }
}
