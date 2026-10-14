import { z } from 'zod'
import { Severity } from './enums.ts'
import { ComparisonPlanInput, ComparisonResult, ComparisonDimension } from './security-comparison.ts'
import { EdgeVerificationState } from './security-attack-path.ts'
import { FindingCategory, VerificationCheck, VerificationCheckResult, VerificationState } from './security-finding.ts'

/*
 * Phase 6C — retesting and historical security comparison. Audivra answers "is this issue still present, was
 * it actually fixed, did it regress, did the surface change, did an attack path disappear, or is it simply
 * not reproducible right now?" — WITHOUT ever equating "not observed again" with "fixed".
 *
 *   verified finding → structured retest case → readiness/broker/durable execution → evidence
 *     → the 6A verification engine (checks the ORIGINAL requirements against fresh evidence) → historical result
 *
 *   assessment A findings/paths/coverage  +  assessment B findings/paths/coverage
 *     → exact-key (then cautious semantic) matching → new/still-present/fixed/changed/regressed/... → persisted comparison
 *
 * A fix must be proven: the retest actually ran, its controls still worked, and the vulnerable behaviour is
 * gone. A timeout, a missing session, an unavailable tool, a changed route or an unavailable provider is a
 * gap (cannot-reproduce / blocked / inconclusive), never a fix. Nothing here invents target state, changes a
 * security property, or executes a new offensive capability — 6C compares what Audivra observed, twice.
 */

// ── Retest result states (repository-consistent; `resolved` is deliberately avoided) ──────────────────

export const RETEST_STATES = ['still-present', 'fixed', 'regressed', 'changed', 'cannot-reproduce', 'blocked', 'not-tested', 'inconclusive'] as const
export const RetestState = z.enum(RETEST_STATES)
export type RetestState = z.infer<typeof RetestState>

/** Only `fixed` claims remediation; it is the single state that requires positive evidence of absence. */
export const RETEST_FIX_STATE: RetestState = 'fixed'

// ── Eligibility (decided BEFORE execution; a blocker is stored explicitly) ────────────────────────────

export const RETEST_BLOCKER_KINDS = [
  'environment-changed',
  'scope-excludes-target',
  'authorization-invalid',
  'capability-unavailable',
  'identity-unavailable',
  'session-unavailable',
  'resource-missing',
  'unsupported-reproduction',
] as const
export const RetestBlockerKind = z.enum(RETEST_BLOCKER_KINDS)
export type RetestBlockerKind = z.infer<typeof RetestBlockerKind>

export const RetestEligibility = z.object({
  eligible: z.boolean(),
  blocker: RetestBlockerKind.nullable(),
  reason: z.string(),
  /** The capability ids the retest would need, and whether each is currently registered/available. */
  capabilities: z.array(z.object({ capabilityId: z.string(), available: z.boolean() })).default([]),
})
export type RetestEligibility = z.infer<typeof RetestEligibility>

// ── Reproduction format ───────────────────────────────────────────────────────────────────────────────

/** How a finding can be replayed. `unsupported` never becomes `fixed` — it is a gap, not a remediation. */
export const REPRODUCTION_FORMATS = ['differential-comparison', 'observation-only', 'unsupported'] as const
export const ReproductionFormat = z.enum(REPRODUCTION_FORMATS)
export type ReproductionFormat = z.infer<typeof ReproductionFormat>

// ── Retestable case (structured; every reference typed and stable — never stored only as prose) ───────

export const RetestCase = z.object({
  id: z.string(),
  /** The engagement the case was derived in (the source assessment of the finding). */
  engagementId: z.string(),
  findingId: z.string(),
  issueKey: z.string(),
  category: FindingCategory,
  title: z.string(),
  reproductionFormat: ReproductionFormat,
  affectedEntityKeys: z.array(z.string()),
  identityRefs: z.array(z.string()),
  resourceRef: z.string().nullable(),
  action: z.string().nullable(),
  invariantRef: z.string().nullable(),
  /** The original comparison whose arms/controls are replayed (null for observation-only / unsupported). */
  sourceComparisonId: z.string().nullable(),
  /** The frozen, replayable reproduction (a validated comparison plan) — self-contained, no live re-read needed. */
  reproduction: ComparisonPlanInput.nullable(),
  /** The 6A verification requirements the fresh evidence must still satisfy for the issue to remain. */
  requiredChecks: z.array(VerificationCheck),
  controlsRequired: z.object({ positive: z.boolean(), negative: z.boolean() }),
  /** Structured preconditions (identity/session/resource/state) that must hold to replay. */
  preconditions: z.array(z.string()),
  capabilityIds: z.array(z.string()),
  cleanupRequired: z.boolean(),
  originalEvidenceRefs: z.array(z.string()),
  originalSeverity: Severity,
  /** Current eligibility (recomputed when the case is read against a target engagement). */
  eligibility: RetestEligibility,
  /** Scheduling primitive only (Phase 6C builds no scheduler): marked to retest in a future assessment. */
  planned: z.boolean(),
  plannedReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RetestCase = z.infer<typeof RetestCase>

// ── Semantic adaptation (AI may move an endpoint/selector/resource — never the security property) ────

export const ADAPTATION_KINDS = ['endpoint-moved', 'selector-changed', 'resource-substituted', 'capability-input-adjusted'] as const
export const AdaptationKind = z.enum(ADAPTATION_KINDS)
export type AdaptationKind = z.infer<typeof AdaptationKind>

export const RetestAdaptation = z.object({
  kind: AdaptationKind,
  /** What changed, and to what (e.g. an old URL → the current one). Human + machine readable. */
  before: z.string(),
  after: z.string(),
  reason: z.string(),
  /** Current graph entity keys the adaptation references (must already exist; validated by Audivra). */
  referencedEntityKeys: z.array(z.string()),
  /** Audivra validated that nothing material (property/invariant/identity/claim) changed. */
  validated: z.boolean(),
  providerId: z.string().nullable(),
})
export type RetestAdaptation = z.infer<typeof RetestAdaptation>

/** What the AI adapter may return — Audivra validates every field before anything is replayed. */
export const RetestAdaptationOutput = z.strictObject({
  adaptable: z.boolean(),
  kind: AdaptationKind.nullable().default(null),
  /** A current endpoint/URL to use instead (same security property, different location). */
  newUrl: z.string().trim().max(2048).nullable().default(null),
  /** A current equivalent resource ref (must already exist as a declared resource / graph entity). */
  newResourceRef: z.string().trim().max(200).nullable().default(null),
  /** Current graph entity keys the proposal relies on (must already exist). */
  referencedEntityKeys: z.array(z.string()).max(24).default([]),
  reason: z.string().trim().min(5).max(800),
})
export type RetestAdaptationOutput = z.infer<typeof RetestAdaptationOutput>

// ── Retest result (the historical result row; full provenance, never conversational) ─────────────────

export const CapabilityVersionRef = z.object({ capabilityId: z.string(), version: z.number().int() })
export type CapabilityVersionRef = z.infer<typeof CapabilityVersionRef>

export const RetestResult = z.object({
  id: z.string(),
  /** The engagement the retest executed in (the current assessment). */
  engagementId: z.string(),
  retestCaseId: z.string(),
  findingId: z.string(),
  issueKey: z.string(),
  /** The assessment the finding originally came from. */
  sourceEngagementId: z.string(),
  state: RetestState,
  reason: z.string(),
  /** The fresh comparison this retest produced, and its deterministic result (null when it never executed). */
  freshComparisonId: z.string().nullable(),
  freshResult: ComparisonResult.nullable(),
  /** Whether the positive control still proved the test meaningful (a false here forbids `fixed`). */
  controlValid: z.boolean(),
  /** The original 6A requirements, re-evaluated against the fresh evidence. */
  checkResults: z.array(VerificationCheckResult),
  executionIds: z.array(z.string()),
  identityRefs: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  capabilityVersions: z.array(CapabilityVersionRef),
  adaptation: RetestAdaptation.nullable(),
  /** Severity observed by this retest (preserved alongside the original; never rewrites history). */
  severityNow: Severity.nullable(),
  createdAt: z.string(),
})
export type RetestResult = z.infer<typeof RetestResult>

// ── Historical matching (explicit basis + confidence; exact keys outrank similarity) ──────────────────

export const MATCH_BASES = ['exact-issue-key', 'semantic-match', 'manual-link', 'unmatched'] as const
export const MatchBasis = z.enum(MATCH_BASES)
export type MatchBasis = z.infer<typeof MatchBasis>

export const FindingMatch = z.object({
  basis: MatchBasis,
  confidence: z.number().min(0).max(1),
  previousFindingId: z.string().nullable(),
  currentFindingId: z.string().nullable(),
  previousIssueKey: z.string().nullable(),
  currentIssueKey: z.string().nullable(),
  reason: z.string(),
})
export type FindingMatch = z.infer<typeof FindingMatch>

// ── Change attributes (how a continued issue differs) ─────────────────────────────────────────────────

export const CHANGE_ASPECTS = ['endpoint', 'role', 'resource', 'tenant', 'scope', 'impact', 'severity', 'verification'] as const
export const ChangeAspect = z.enum(CHANGE_ASPECTS)
export type ChangeAspect = z.infer<typeof ChangeAspect>

export const SecurityFindingChange = z.object({ aspect: ChangeAspect, from: z.string(), to: z.string(), detail: z.string() })
export type SecurityFindingChange = z.infer<typeof SecurityFindingChange>

// ── Cross-assessment finding classification ───────────────────────────────────────────────────────────

export const FINDING_COMPARISON_CLASSES = ['new', 'still-present', 'fixed', 'changed', 'regressed', 'cannot-reproduce', 'not-tested', 'unmatched-historical'] as const
export const FindingComparisonClass = z.enum(FINDING_COMPARISON_CLASSES)
export type FindingComparisonClass = z.infer<typeof FindingComparisonClass>

export const FindingSideRef = z.object({ findingId: z.string(), issueKey: z.string(), title: z.string(), category: FindingCategory, severity: Severity, verificationState: VerificationState })
export type FindingSideRef = z.infer<typeof FindingSideRef>

export const FindingComparisonEntry = z.object({
  class: FindingComparisonClass,
  match: FindingMatch,
  previous: FindingSideRef.nullable(),
  current: FindingSideRef.nullable(),
  /** The retest (when one drove this classification). */
  retestResultId: z.string().nullable(),
  retestState: RetestState.nullable(),
  changes: z.array(SecurityFindingChange),
  reason: z.string(),
})
export type FindingComparisonEntry = z.infer<typeof FindingComparisonEntry>

// ── Finding lineage / timeline (first-class; previous rows are never overwritten) ─────────────────────

export const FindingTimelineEntry = z.object({
  engagementId: z.string(),
  assessmentAt: z.string(),
  findingId: z.string().nullable(),
  verificationState: VerificationState.nullable(),
  severity: Severity.nullable(),
  retestResultId: z.string().nullable(),
  retestState: RetestState.nullable(),
  matchBasis: MatchBasis,
  changes: z.array(SecurityFindingChange),
  reason: z.string(),
})
export type FindingTimelineEntry = z.infer<typeof FindingTimelineEntry>

export const FindingLineage = z.object({
  issueKey: z.string(),
  title: z.string(),
  category: FindingCategory,
  /** Preserved original and latest severity (historical severity is never rewritten). */
  originalSeverity: Severity.nullable(),
  currentSeverity: Severity.nullable(),
  entries: z.array(FindingTimelineEntry),
})
export type FindingLineage = z.infer<typeof FindingLineage>

// ── Attack-path historical comparison (reuses the 6B stable pathKey) ──────────────────────────────────

export const PATH_HISTORY_CLASSES = ['still-present', 'disappeared', 'changed', 'regressed', 'partially-remains', 'missing-evidence'] as const
export const PathHistoryClass = z.enum(PATH_HISTORY_CLASSES)
export type PathHistoryClass = z.infer<typeof PathHistoryClass>

export const PathEdgeLite = z.object({ label: z.string(), edgeVerification: EdgeVerificationState })
export type PathEdgeLite = z.infer<typeof PathEdgeLite>

export const PathVerificationChange = z.object({ label: z.string(), from: EdgeVerificationState, to: EdgeVerificationState })
export type PathVerificationChange = z.infer<typeof PathVerificationChange>

export const AttackPathDiffEntry = z.object({
  class: PathHistoryClass,
  pathKey: z.string(),
  title: z.string(),
  previousPathId: z.string().nullable(),
  currentPathId: z.string().nullable(),
  previousState: z.string().nullable(),
  currentState: z.string().nullable(),
  /** Verified edges present before and gone now (the reason a path weakened or disappeared). */
  removedVerifiedEdges: z.array(PathEdgeLite),
  newEdges: z.array(PathEdgeLite),
  verificationChanges: z.array(PathVerificationChange),
  impactChange: z.object({ from: Severity, to: Severity }).nullable(),
  reason: z.string(),
})
export type AttackPathDiffEntry = z.infer<typeof AttackPathDiffEntry>

// ── Important-graph comparison (a bounded set of entity kinds — never a generic JSON diff) ────────────

export const GRAPH_CHANGE_KINDS = ['added', 'removed', 'changed'] as const
export const GraphChangeKind = z.enum(GRAPH_CHANGE_KINDS)
export type GraphChangeKind = z.infer<typeof GraphChangeKind>

export const GraphChangeEntry = z.object({
  kind: GraphChangeKind,
  element: z.enum(['node', 'edge']),
  entityKind: z.string(),
  key: z.string(),
  label: z.string(),
  detail: z.string(),
})
export type GraphChangeEntry = z.infer<typeof GraphChangeEntry>

// ── Coverage comparison (a reduction must be visible before fewer findings reads as improvement) ──────

export const CoverageDelta = z.object({ previous: z.number().int(), current: z.number().int(), delta: z.number().int() })
export type CoverageDelta = z.infer<typeof CoverageDelta>

export const CoverageComparison = z.object({
  previousEngagementId: z.string(),
  currentEngagementId: z.string(),
  identitiesTested: CoverageDelta,
  resourcesSampled: CoverageDelta,
  comparisonsRun: CoverageDelta,
  findingsTotal: CoverageDelta,
  pathsTotal: CoverageDelta,
  /** True when the current assessment measured strictly less than the previous one (interpret with care). */
  coverageRegressed: z.boolean(),
  notes: z.array(z.string()),
})
export type CoverageComparison = z.infer<typeof CoverageComparison>

// ── The persisted assessment comparison ───────────────────────────────────────────────────────────────

export const AssessmentComparisonSummary = z.object({
  new: z.number().int(),
  stillPresent: z.number().int(),
  fixed: z.number().int(),
  changed: z.number().int(),
  regressed: z.number().int(),
  cannotReproduce: z.number().int(),
  notTested: z.number().int(),
  unmatchedHistorical: z.number().int(),
})
export type AssessmentComparisonSummary = z.infer<typeof AssessmentComparisonSummary>

export const SecurityAssessmentComparison = z.object({
  id: z.string(),
  previousEngagementId: z.string(),
  currentEngagementId: z.string(),
  summary: AssessmentComparisonSummary,
  findingChanges: z.array(FindingComparisonEntry),
  pathChanges: z.array(AttackPathDiffEntry),
  graphChanges: z.array(GraphChangeEntry),
  coverage: CoverageComparison,
  createdAt: z.string(),
})
export type SecurityAssessmentComparison = z.infer<typeof SecurityAssessmentComparison>

// ── Analyst decisions (manual overrides with an audit trail; never change underlying evidence) ────────

export const ANALYST_DECISION_KINDS = ['link-historical', 'unlink-historical', 'mark-comparison-incorrect', 'accept-risk', 'note'] as const
export const AnalystDecisionKind = z.enum(ANALYST_DECISION_KINDS)
export type AnalystDecisionKind = z.infer<typeof AnalystDecisionKind>

export const AnalystDecision = z.object({
  id: z.string(),
  engagementId: z.string(),
  kind: AnalystDecisionKind,
  /** The subject: an issueKey, a finding id pair, a pathKey — a reference, never evidence. */
  subjectRef: z.string(),
  relatedRef: z.string().nullable(),
  note: z.string(),
  actorId: z.string().nullable(),
  createdAt: z.string(),
})
export type AnalystDecision = z.infer<typeof AnalystDecision>

export const AnalystDecisionInput = z.strictObject({
  kind: AnalystDecisionKind,
  subjectRef: z.string().trim().min(1).max(200),
  relatedRef: z.string().trim().max(200).nullable().default(null),
  note: z.string().trim().min(1).max(2000),
})
export type AnalystDecisionInput = z.infer<typeof AnalystDecisionInput>

// ── Historical report section ─────────────────────────────────────────────────────────────────────────

export const SecurityHistoricalReport = z.object({
  previousEngagementId: z.string(),
  currentEngagementId: z.string(),
  generatedAt: z.string(),
  /** A deterministic executive change summary (never overstated; coverage caveats included). */
  executiveSummary: z.string(),
  summary: AssessmentComparisonSummary,
  newFindings: z.array(FindingComparisonEntry),
  fixedFindings: z.array(FindingComparisonEntry),
  regressedFindings: z.array(FindingComparisonEntry),
  changedFindings: z.array(FindingComparisonEntry),
  cannotReproduce: z.array(FindingComparisonEntry),
  pathChanges: z.array(AttackPathDiffEntry),
  coverage: CoverageComparison,
})
export type SecurityHistoricalReport = z.infer<typeof SecurityHistoricalReport>

// ── API input ─────────────────────────────────────────────────────────────────────────────────────────

/** Request a retest: a source finding, replayed in a target (current) assessment engagement. */
export const RequestRetestInput = z.strictObject({
  findingId: z.string().trim().min(1).max(120),
  /** The current assessment engagement to replay the finding in (defaults to the finding's own engagement). */
  targetEngagementId: z.string().trim().min(6).max(32).nullable().default(null),
  /** Allow a bounded AI adaptation when deterministic replay cannot run because the app changed. */
  allowAdaptation: z.boolean().default(false),
})
export type RequestRetestInput = z.infer<typeof RequestRetestInput>

/** Automatic retest planning: build eligible retest cases for a target assessment (does not run them). */
export const PlanRetestsInput = z.strictObject({
  /** The previous assessment whose findings are candidates for retest. */
  previousEngagementId: z.string().trim().min(6).max(32),
  /** Only build cases that are currently eligible (skip blocked ones). */
  eligibleOnly: z.boolean().default(true),
})
export type PlanRetestsInput = z.infer<typeof PlanRetestsInput>

export const CompareAssessmentsInput = z.strictObject({
  previousEngagementId: z.string().trim().min(6).max(32),
  /** Persist the comparison record (default) or compute it transiently. */
  persist: z.boolean().default(true),
})
export type CompareAssessmentsInput = z.infer<typeof CompareAssessmentsInput>

// Re-exported so downstream modules can build reproduction plans without importing two files.
export { ComparisonDimension }
