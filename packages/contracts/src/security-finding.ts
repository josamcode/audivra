import { z } from 'zod'
import { Severity } from './enums.ts'
import { ComparisonResult } from './security-comparison.ts'
import { ObservationType } from './security-observation.ts'

/*
 * Phase 6A — independent verification and evidence-backed finding synthesis. A Security Finding is the end of
 * a deliberate boundary: an observation, a hypothesis, a comparison inconsistency or a scanner signal is NEVER
 * a finding by itself. A strong signal becomes a Verification Candidate; an independent verifier (AI, through
 * the Phase 3C router) may reason about it, but AUDIVRA deterministically decides whether the required,
 * machine-checkable evidence exists. Only then — and never on provider failure — is a finding synthesized,
 * with a deterministically-constrained severity, evidence-quality confidence, a structured reproduction
 * record and prose whose every factual reference points back to stored state.
 *
 *   signals → candidate → required checks → independent verification → verified/supported/rejected/inconclusive → finding
 */

// ── Categories (generic, extensible; reuse the existing taxonomy where possible) ──────────────────────

export const FINDING_CATEGORIES = [
  'authentication',
  'authorization',
  'tenant-isolation',
  'business-logic',
  'session-management',
  'api-behavior',
  'configuration',
  'dependency',
  'transport-tls',
  'exposure',
  'source-runtime-inconsistency',
] as const
export const FindingCategory = z.enum(FINDING_CATEGORIES)
export type FindingCategory = z.infer<typeof FindingCategory>

// ── Verification lifecycle (its own, never overloaded onto hypothesis status) ─────────────────────────

export const VERIFICATION_STATES = ['unverified', 'needs-evidence', 'supported', 'verified', 'rejected', 'inconclusive', 'blocked'] as const
export const VerificationState = z.enum(VERIFICATION_STATES)
export type VerificationState = z.infer<typeof VerificationState>

/** States that are settled enough to synthesize (or keep) a finding. `verified` requires independent confirmation. */
export const FINDING_WORTHY_STATES: readonly VerificationState[] = ['supported', 'verified']

export const CANDIDATE_ORIGINS = ['confirmed-signal-hypothesis', 'differential-comparison', 'contradicted-invariant', 'corroborated-observation', 'source-runtime-correlation'] as const
export const CandidateOrigin = z.enum(CANDIDATE_ORIGINS)
export type CandidateOrigin = z.infer<typeof CandidateOrigin>

// ── Machine-checkable verification requirements ───────────────────────────────────────────────────────

/**
 * A deterministic requirement, evaluated against stored state (candidate, graph, comparisons, evidence). The
 * verifier's prose never satisfies a check — only real evidence/controls do.
 */
export const VerificationCheck = z.discriminatedUnion('check', [
  z.strictObject({ check: z.literal('evidence-present'), min: z.number().int().min(1).default(1) }),
  z.strictObject({ check: z.literal('affected-entity-known') }),
  z.strictObject({ check: z.literal('positive-control') }),
  z.strictObject({ check: z.literal('negative-control') }),
  z.strictObject({ check: z.literal('semantic-difference') }),
  z.strictObject({ check: z.literal('comparison-result'), results: z.array(ComparisonResult).min(1).max(5) }),
  z.strictObject({ check: z.literal('invariant-contradicted') }),
  z.strictObject({ check: z.literal('independent-corroboration'), min: z.number().int().min(2).default(2) }),
  z.strictObject({ check: z.literal('config-observation'), observationType: ObservationType }),
  z.strictObject({ check: z.literal('dependency-evidence') }),
  z.strictObject({ check: z.literal('expectation-provenance') }),
  /** No unresolved contradicting evidence; a material contradiction forces INCONCLUSIVE. */
  z.strictObject({ check: z.literal('no-material-contradiction') }),
])
export type VerificationCheck = z.infer<typeof VerificationCheck>

export const VerificationCheckResult = z.object({
  index: z.number().int(),
  check: z.string(),
  met: z.boolean(),
  detail: z.string(),
  evidenceRefs: z.array(z.string()),
})
export type VerificationCheckResult = z.infer<typeof VerificationCheckResult>

// ── Candidate ─────────────────────────────────────────────────────────────────────────────────────────

export const CandidateSource = z.object({
  origin: CandidateOrigin,
  hypothesisId: z.string().nullable().default(null),
  comparisonId: z.string().nullable().default(null),
  invariantRef: z.string().nullable().default(null),
  observationIds: z.array(z.string()).default([]),
})
export type CandidateSource = z.infer<typeof CandidateSource>

export const FindingVerifierVerdict = z.enum(['confirm', 'disprove', 'alternative', 'needs-evidence', 'not-run'])
export type FindingVerifierVerdict = z.infer<typeof FindingVerifierVerdict>

export const CandidateTransition = z.object({ at: z.string(), from: VerificationState.nullable(), to: VerificationState, reason: z.string(), actor: z.enum(['audivra', 'ai', 'user']) })
export type CandidateTransition = z.infer<typeof CandidateTransition>

export const SecurityVerificationCandidate = z.object({
  id: z.string(),
  engagementId: z.string(),
  /** Stable issue key: category + affected entities + security property + normalized condition. */
  issueKey: z.string(),
  claim: z.string(),
  category: FindingCategory,
  affectedEntityKeys: z.array(z.string()),
  supportingEvidenceRefs: z.array(z.string()),
  contradictingEvidenceRefs: z.array(z.string()),
  source: CandidateSource,
  requiredChecks: z.array(VerificationCheck),
  checkResults: z.array(VerificationCheckResult),
  status: VerificationState,
  statusReason: z.string(),
  verifier: z.object({ verdict: FindingVerifierVerdict, note: z.string().nullable(), providerId: z.string().nullable() }),
  /** The finding this candidate was synthesized into (null until a finding exists). */
  findingId: z.string().nullable(),
  history: z.array(CandidateTransition),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityVerificationCandidate = z.infer<typeof SecurityVerificationCandidate>

// ── Severity (deterministically constrained) & confidence (evidence quality) ──────────────────────────

export const EXPLOIT_PREREQUISITES = ['none', 'authenticated', 'privileged', 'complex'] as const
export const ExploitPrerequisite = z.enum(EXPLOIT_PREREQUISITES)
export type ExploitPrerequisite = z.infer<typeof ExploitPrerequisite>

export const DATA_SENSITIVITIES = ['high', 'medium', 'low', 'unknown'] as const
export const DataSensitivity = z.enum(DATA_SENSITIVITIES)
export type DataSensitivity = z.infer<typeof DataSensitivity>

/** Deterministic severity inputs — Audivra computes the allowed range; the AI may only explain within it. */
export const SeverityInputs = z.object({
  category: FindingCategory,
  scopeClass: z.string(),
  privilegeBoundaryCrossed: z.boolean(),
  tenantBoundaryCrossed: z.boolean(),
  dataSensitivity: DataSensitivity,
  exploitPrerequisites: ExploitPrerequisite,
  confidence: z.number().min(0).max(1),
  environment: z.string(),
})
export type SeverityInputs = z.infer<typeof SeverityInputs>

export const ConfidenceFactors = z.object({
  directObservation: z.boolean(),
  independentCorroboration: z.boolean(),
  positiveControl: z.boolean(),
  negativeControl: z.boolean(),
  deterministicReproduction: z.boolean(),
  contradictoryEvidence: z.boolean(),
  aiInferenceDependency: z.boolean(),
})
export type ConfidenceFactors = z.infer<typeof ConfidenceFactors>

// ── Reproduction record (structured; links to real executions/arms/evidence) ──────────────────────────

export const ReproductionArm = z.object({
  role: z.string(),
  identityRef: z.string().nullable(),
  sessionRef: z.string().nullable(),
  resourceRef: z.string().nullable(),
  url: z.string().nullable(),
  method: z.string().nullable(),
  responseClass: z.string().nullable(),
  status: z.number().int().nullable(),
})
export type ReproductionArm = z.infer<typeof ReproductionArm>

export const ReproductionRecord = z.object({
  executionIds: z.array(z.string()),
  comparisonId: z.string().nullable(),
  arms: z.array(ReproductionArm),
  stateBefore: z.string().nullable(),
  stateAfter: z.string().nullable(),
  evidenceRefs: z.array(z.string()),
})
export type ReproductionRecord = z.infer<typeof ReproductionRecord>

// ── Finding ───────────────────────────────────────────────────────────────────────────────────────────

/** 6A lifecycle subset. `not-found-again` / `fixed` / `regressed` (historical retesting) are 6C. */
export const FINDING_STATUSES = ['open', 'verified', 'rejected', 'accepted-risk'] as const
export const FindingStatus = z.enum(FINDING_STATUSES)
export type FindingStatus = z.infer<typeof FindingStatus>

export const FindingAffectedEntity = z.object({ key: z.string(), kind: z.string(), label: z.string() })
export type FindingAffectedEntity = z.infer<typeof FindingAffectedEntity>

export const FindingTransition = z.object({ at: z.string(), field: z.string(), from: z.string(), to: z.string(), reason: z.string(), actor: z.enum(['audivra', 'ai', 'user']) })
export type FindingTransition = z.infer<typeof FindingTransition>

export const SecurityFinding = z.object({
  id: z.string(),
  engagementId: z.string(),
  issueKey: z.string(),
  title: z.string(),
  category: FindingCategory,
  severity: Severity,
  /** Why the severity is what it is (deterministic rationale; the AI explanation is `impact`). */
  severityReason: z.string(),
  confidence: z.number().min(0).max(1),
  verificationState: VerificationState,
  status: FindingStatus,
  affectedEntities: z.array(FindingAffectedEntity),
  claim: z.string(),
  evidenceRefs: z.array(z.string()),
  contradictingEvidenceRefs: z.array(z.string()),
  /** AI-authored explanatory prose; every factual reference is validated against stored state. */
  impact: z.string(),
  remediation: z.string(),
  reproduction: ReproductionRecord.nullable(),
  severityInputs: SeverityInputs,
  confidenceFactors: ConfidenceFactors,
  candidateIds: z.array(z.string()),
  hypothesisIds: z.array(z.string()),
  comparisonIds: z.array(z.string()),
  invariantRefs: z.array(z.string()),
  /** The second-stage reviewer ran and (only ever) made it more cautious. */
  reviewed: z.boolean(),
  reviewNote: z.string().nullable(),
  history: z.array(FindingTransition),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityFinding = z.infer<typeof SecurityFinding>

// ── AI outputs (validated by Audivra before anything is persisted) ────────────────────────────────────

export const FindingVerifierOutput = z.strictObject({
  verdict: z.enum(['confirm', 'disprove', 'alternative', 'needs-evidence']),
  rationale: z.string().trim().min(5).max(1200),
  /** Evidence refs the verifier relied on; must already exist on the candidate. */
  citedEvidenceRefs: z.array(z.string()).max(30).default([]),
  alternativeExplanation: z.string().trim().max(600).nullable().default(null),
  missingEvidence: z.string().trim().max(600).nullable().default(null),
  /** At most one bounded re-check through the broker (capability + input; never a command). */
  proposedAction: z
    .strictObject({ capabilityId: z.string().min(3).max(120), input: z.record(z.string(), z.unknown()), identityRef: z.string().max(120).nullable().default(null), expectedEvidence: z.string().trim().min(5).max(300) })
    .nullable()
    .default(null),
})
export type FindingVerifierOutput = z.infer<typeof FindingVerifierOutput>

export const FindingProseOutput = z.strictObject({
  title: z.string().trim().min(5).max(160),
  impact: z.string().trim().min(10).max(1500),
  remediation: z.string().trim().min(10).max(1500),
  severityExplanation: z.string().trim().max(600).default(''),
})
export type FindingProseOutput = z.infer<typeof FindingProseOutput>

export const FindingReviewOutput = z.strictObject({
  verdict: z.enum(['ok', 'too-strong', 'duplicate', 'needs-caution']),
  note: z.string().trim().max(600),
  /** The reviewer may only lower severity (Audivra ignores an attempt to raise it). */
  suggestedSeverity: Severity.nullable().default(null),
})
export type FindingReviewOutput = z.infer<typeof FindingReviewOutput>

// ── Read views & coverage ─────────────────────────────────────────────────────────────────────────────

export const SecurityFindingDetail = z.object({
  finding: SecurityFinding,
  candidates: z.array(SecurityVerificationCandidate),
  evidence: z.array(z.object({ ref: z.string(), type: z.string(), title: z.string(), identityRef: z.string().nullable(), sessionRef: z.string().nullable() })),
  hypotheses: z.array(z.object({ id: z.string(), claim: z.string(), status: z.string() })),
  comparisons: z.array(z.object({ id: z.string(), dimension: z.string(), result: z.string() })),
})
export type SecurityFindingDetail = z.infer<typeof SecurityFindingDetail>

export const VerificationCoverage = z.object({
  candidates: z.object({ total: z.number().int(), byStatus: z.record(z.string(), z.number().int()) }),
  findings: z.object({
    total: z.number().int(),
    byCategory: z.record(z.string(), z.number().int()),
    bySeverity: z.record(z.string(), z.number().int()),
    byVerification: z.record(z.string(), z.number().int()),
    byStatus: z.record(z.string(), z.number().int()),
  }),
})
export type VerificationCoverage = z.infer<typeof VerificationCoverage>

/** A security assessment report: verified findings, supported signals, open investigation, coverage limits — kept apart. */
export const SecurityAssessmentReport = z.object({
  engagementId: z.string(),
  generatedAt: z.string(),
  verifiedFindings: z.array(SecurityFinding),
  supportedSignals: z.array(SecurityFinding),
  openInvestigation: z.array(SecurityVerificationCandidate),
  coverage: VerificationCoverage,
})
export type SecurityAssessmentReport = z.infer<typeof SecurityAssessmentReport>
