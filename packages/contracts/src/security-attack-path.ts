import { z } from 'zod'
import { Severity } from './enums.ts'
import { FindingCategory } from './security-finding.ts'

/*
 * Phase 6B — evidence-backed attack path analysis. An attack path connects what AUDIVRA has already verified
 * (findings, graph relationships, identities/resources/trust boundaries, comparisons, invariants) into an
 * ordered, structured route from a known start condition to a structured impact. A path is NOT a narrative
 * invented after the fact: every step references stored structured state and carries an explicit edge
 * verification state, and a path with any inferred or missing edge is never presented as fully demonstrated.
 *
 *   verified findings + security graph + trust relationships
 *     → candidate path → validate every step → verified / partial / supported / speculative / rejected path
 *
 * This phase adds no offensive execution: it analyses what Audivra already knows. A gap is represented, never
 * manufactured into proof.
 */

// ── Edge (step) verification — kept distinct, never collapsed into one number ─────────────────────────

export const EDGE_VERIFICATION_STATES = ['verified', 'supported', 'inferred', 'missing', 'contradicted'] as const
export const EdgeVerificationState = z.enum(EDGE_VERIFICATION_STATES)
export type EdgeVerificationState = z.infer<typeof EdgeVerificationState>

/** Rank for "weakest edge" selection; a higher number is weaker/worse evidence. */
export const EDGE_VERIFICATION_RANK: Record<EdgeVerificationState, number> = { verified: 0, supported: 1, inferred: 2, missing: 3, contradicted: 4 }

// ── Path verification state (cautious; a path is only as strong as its weakest meaningful edge) ───────

export const PATH_STATES = ['verified', 'partially-verified', 'supported', 'speculative', 'rejected'] as const
export const PathState = z.enum(PATH_STATES)
export type PathState = z.infer<typeof PathState>

/** States solid enough to show as a path (never as demonstrated compromise unless `verified`). */
export const PATH_PRESENTABLE_STATES: readonly PathState[] = ['verified', 'partially-verified', 'supported']

// ── Start conditions (every one must come from graph/domain state) ────────────────────────────────────

export const START_CONDITION_KINDS = ['anonymous', 'authenticated-identity', 'tenant-member', 'tenant-admin', 'resource-access', 'exposed-endpoint'] as const
export const StartConditionKind = z.enum(START_CONDITION_KINDS)
export type StartConditionKind = z.infer<typeof StartConditionKind>

export const StartCondition = z.object({
  kind: StartConditionKind,
  /** The declared identity the start assumes (null for anonymous / endpoint). */
  identityRef: z.string().nullable(),
  /** The graph node key the start references (an identity, resource or endpoint). */
  entityKey: z.string().nullable(),
  label: z.string(),
})
export type StartCondition = z.infer<typeof StartCondition>

// ── End impact (structured, never claimed beyond the evidence) ────────────────────────────────────────

export const IMPACT_CLASSES = ['unauthorized-data-access', 'cross-tenant-access', 'unauthorized-state-change', 'privilege-boundary-crossed', 'sensitive-capability-reached', 'security-control-bypassed'] as const
export const ImpactClass = z.enum(IMPACT_CLASSES)
export type ImpactClass = z.infer<typeof ImpactClass>

export const EndImpact = z.object({
  impactClass: ImpactClass,
  entityKey: z.string().nullable(),
  label: z.string(),
})
export type EndImpact = z.infer<typeof EndImpact>

// ── Trust boundaries ──────────────────────────────────────────────────────────────────────────────────

export const TRUST_BOUNDARY_KINDS = ['tenant', 'role', 'authentication', 'service', 'business-state'] as const
export const TrustBoundaryKind = z.enum(TRUST_BOUNDARY_KINDS)
export type TrustBoundaryKind = z.infer<typeof TrustBoundaryKind>

// ── Steps (structured; never only prose) ──────────────────────────────────────────────────────────────

export const STEP_REFERENCE_KINDS = ['finding', 'graph-node', 'graph-edge', 'invariant', 'comparison', 'identity', 'resource', 'business-action', 'state-transition'] as const
export const StepReferenceKind = z.enum(STEP_REFERENCE_KINDS)
export type StepReferenceKind = z.infer<typeof StepReferenceKind>

/** A reference from a step to the stored state that backs it. `ref` is an id or a graph key, by kind. */
export const AttackStepReference = z.object({ kind: StepReferenceKind, ref: z.string(), label: z.string() })
export type AttackStepReference = z.infer<typeof AttackStepReference>

export const AttackStep = z.object({
  index: z.number().int(),
  /** The condition this step starts from (the previous step's `toCondition`, or the path start). */
  fromCondition: z.string(),
  /** What happens: the finding exploited or the verified relationship traversed. */
  relationship: z.string(),
  /** The condition reached after the step. */
  toCondition: z.string(),
  edgeVerification: EdgeVerificationState,
  /** The finding that backs this step, when a finding does. */
  findingId: z.string().nullable(),
  /** A trust boundary crossed on this step, when any. */
  boundaryCrossed: TrustBoundaryKind.nullable(),
  references: z.array(AttackStepReference),
  evidenceRefs: z.array(z.string()),
  rationale: z.string(),
})
export type AttackStep = z.infer<typeof AttackStep>

// ── Missing evidence (explicit gaps — the later autonomous researcher's input) ────────────────────────

export const MISSING_EVIDENCE_KINDS = ['unknown-identity-relationship', 'unverified-transition', 'incomplete-comparison', 'unsupported-impact-edge', 'unverified-reachability', 'contradicted-step'] as const
export const MissingEvidenceKind = z.enum(MISSING_EVIDENCE_KINDS)
export type MissingEvidenceKind = z.infer<typeof MissingEvidenceKind>

export const MissingEvidenceRequirement = z.object({ kind: MissingEvidenceKind, detail: z.string(), stepIndex: z.number().int().nullable() })
export type MissingEvidenceRequirement = z.infer<typeof MissingEvidenceRequirement>

// ── The persisted path ────────────────────────────────────────────────────────────────────────────────

export const PATH_ORIGINS = ['deterministic', 'ai-proposed'] as const
export const PathOrigin = z.enum(PATH_ORIGINS)
export type PathOrigin = z.infer<typeof PathOrigin>

export const AttackPathTransition = z.object({ at: z.string(), from: PathState.nullable(), to: PathState, reason: z.string(), actor: z.enum(['audivra', 'ai', 'user']) })
export type AttackPathTransition = z.infer<typeof AttackPathTransition>

export const SecurityAttackPath = z.object({
  id: z.string(),
  engagementId: z.string(),
  /** Stable semantic key: start condition + ordered semantic transitions + end impact + principal entities. */
  pathKey: z.string(),
  title: z.string(),
  /** Normalized, human-facing purpose of the route. */
  purpose: z.string(),
  start: StartCondition,
  end: EndImpact,
  steps: z.array(AttackStep),
  affectedEntityKeys: z.array(z.string()),
  findingIds: z.array(z.string()),
  comparisonIds: z.array(z.string()),
  invariantRefs: z.array(z.string()),
  /** Bounded by the weakest meaningful edge — never an average. */
  confidence: z.number().min(0).max(1),
  state: PathState,
  stateReason: z.string(),
  missingEvidence: z.array(MissingEvidenceRequirement),
  impactClass: ImpactClass,
  /** A separate path-level priority — NOT the finding severity. */
  impactPriority: Severity,
  boundariesCrossed: z.array(TrustBoundaryKind),
  origin: PathOrigin,
  /** When an AI proposed/enriched it, which provider (null for purely deterministic). */
  providerId: z.string().nullable(),
  /** AI-authored explanation; every fact traces to the structured steps. */
  explanation: z.string(),
  /** Another path this one is dominated by / a subpath of (null when it stands alone). */
  dominatedBy: z.string().nullable(),
  history: z.array(AttackPathTransition),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityAttackPath = z.infer<typeof SecurityAttackPath>

// ── Read views & coverage ─────────────────────────────────────────────────────────────────────────────

export const AttackPathDetail = z.object({
  path: SecurityAttackPath,
  findings: z.array(z.object({ id: z.string(), title: z.string(), category: FindingCategory, severity: Severity, verificationState: z.string() })),
  evidence: z.array(z.object({ ref: z.string(), type: z.string(), title: z.string() })),
})
export type AttackPathDetail = z.infer<typeof AttackPathDetail>

export const AttackPathCoverage = z.object({
  total: z.number().int(),
  byState: z.record(z.string(), z.number().int()),
  byImpact: z.record(z.string(), z.number().int()),
  missingEvidenceEdges: z.number().int(),
  boundariesCrossed: z.record(z.string(), z.number().int()),
})
export type AttackPathCoverage = z.infer<typeof AttackPathCoverage>

// ── AI outputs (validated before anything is persisted) ───────────────────────────────────────────────

/** A proposed chain: ordered finding ids and the entity keys it claims connect them. Refs only, never new state. */
export const AttackPathProposalOutput = z.strictObject({
  proposals: z
    .array(
      z.strictObject({
        title: z.string().trim().min(5).max(160),
        /** Ordered finding ids to correlate (must already exist and be finding-worthy). */
        findingIds: z.array(z.string()).min(1).max(8),
        /** Graph node keys the proposal claims connect the findings (must already exist). */
        connectingEntityKeys: z.array(z.string()).max(16).default([]),
        impactClass: ImpactClass,
        rationale: z.string().trim().min(5).max(800),
      }),
    )
    .max(12)
    .default([]),
})
export type AttackPathProposalOutput = z.infer<typeof AttackPathProposalOutput>

export const AttackPathExplanationOutput = z.strictObject({
  title: z.string().trim().min(5).max(160),
  explanation: z.string().trim().min(10).max(1500),
})
export type AttackPathExplanationOutput = z.infer<typeof AttackPathExplanationOutput>

// ── Report section ────────────────────────────────────────────────────────────────────────────────────

export const AttackPathReport = z.object({
  engagementId: z.string(),
  generatedAt: z.string(),
  verifiedPaths: z.array(SecurityAttackPath),
  partiallyVerifiedPaths: z.array(SecurityAttackPath),
  openEvidenceGaps: z.array(z.object({ pathId: z.string(), title: z.string(), missing: z.array(MissingEvidenceRequirement) })),
  coverage: AttackPathCoverage,
})
export type AttackPathReport = z.infer<typeof AttackPathReport>
