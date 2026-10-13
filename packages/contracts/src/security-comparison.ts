import { z } from 'zod'
import { SecurityActor } from './security.ts'

/*
 * Phase 5 Step 4 — differential authorization & business-logic comparison. Audivra compares application
 * behaviour across *authorized test identities / roles / tenants / resources / states* using the trusted
 * identity-aware execution system (Step 3). A comparison is a structured, persisted experiment:
 *
 *   graph knowledge → identity/resource boundary hypothesis → bounded comparison plan
 *     → identity-aware executions (one per arm) → expected vs observed behaviour
 *     → evidence → result classification → hypothesis / invariant update
 *
 * The AI only *proposes* comparisons; Audivra deterministically validates, executes, normalizes, compares,
 * classifies and stores. No identity/session/resource/action/credential is ever invented, and a comparison
 * is never itself called a vulnerability — that is a later phase. `UNKNOWN != FALSE` throughout.
 */

// ── Dimensions (generic authorization / business boundaries) ──────────────────────────────────────────

export const COMPARISON_DIMENSIONS = [
  'object-boundary',
  'role-boundary',
  'tenant-boundary',
  'function-level',
  'field-boundary',
  'session-boundary',
  'state-transition',
  'ownership',
] as const
export const ComparisonDimension = z.enum(COMPARISON_DIMENSIONS)
export type ComparisonDimension = z.infer<typeof ComparisonDimension>

// ── Expected behaviour (always carries explicit provenance) ───────────────────────────────────────────

/** The authorization outcome a comparison arm is expected to produce. `unknown` is first-class. */
export const AUTHORIZATION_EXPECTATIONS = ['allow', 'deny', 'limited', 'unknown'] as const
export const AuthorizationExpectation = z.enum(AUTHORIZATION_EXPECTATIONS)
export type AuthorizationExpectation = z.infer<typeof AuthorizationExpectation>

/** Where an expectation comes from. An AI-inferred expectation stays visibly inferred — never ground truth. */
export const EXPECTATION_BASES = ['declared', 'code-derived', 'observed', 'ai-inferred', 'unknown'] as const
export const ExpectationBasis = z.enum(EXPECTATION_BASES)
export type ExpectationBasis = z.infer<typeof ExpectationBasis>

export const ExpectedBehavior = z.strictObject({
  outcome: AuthorizationExpectation,
  basis: ExpectationBasis,
  /** The declared/derived invariant this expectation came from, when any. */
  invariantRef: z.string().nullable().default(null),
  /** An observation / hypothesis / graph-key the expectation is grounded in, when any. */
  sourceRef: z.string().nullable().default(null),
  rationale: z.string().trim().max(600).default(''),
})
export type ExpectedBehavior = z.infer<typeof ExpectedBehavior>

// ── Arms (each arm is one identity-aware execution against one resource/action) ───────────────────────

/** A comparison is made of arms. Controls make the signal trustworthy: a positive arm is expected to work. */
export const COMPARISON_ARM_ROLES = ['subject', 'positive-control', 'negative-control', 'baseline'] as const
export const ComparisonArmRole = z.enum(COMPARISON_ARM_ROLES)
export type ComparisonArmRole = z.infer<typeof ComparisonArmRole>

export const COMPARISON_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export const ComparisonMethod = z.enum(COMPARISON_METHODS)
export type ComparisonMethod = z.infer<typeof ComparisonMethod>

/** Semantic class of a response — never the raw status alone. */
export const RESPONSE_CLASSES = ['success', 'denied', 'not-found', 'auth-required', 'redirect-login', 'error', 'empty', 'other'] as const
export const ResponseClass = z.enum(RESPONSE_CLASSES)
export type ResponseClass = z.infer<typeof ResponseClass>

/** A bounded, normalized view of one arm's observed behaviour (volatile noise removed; evidence kept). */
export const ComparisonObservation = z.object({
  executionId: z.string().nullable(),
  status: z.number().int().nullable(),
  responseClass: ResponseClass,
  bodyBytes: z.number().int(),
  /** Hash of the normalized (noise-stripped) body, for content-equality comparison. */
  normalizedHash: z.string().nullable(),
  /** Top-level JSON field names seen (sorted, bounded) — for field-boundary comparison. */
  fields: z.array(z.string()),
  returnedFields: z.number().int(),
  /** The resource/object id the response appears to concern, when detectable. */
  objectRef: z.string().nullable(),
  /** Whether the arm's action changed server state (a mutating method that succeeded). */
  stateMutation: z.boolean(),
  /** The response bounced to a login / auth challenge. */
  redirectToLogin: z.boolean(),
  /** A business outcome the response reports, when observable (e.g. an approval status). */
  businessResult: z.string().nullable(),
  authenticatedAs: z.string().nullable(),
  evidenceRefs: z.array(z.string()),
})
export type ComparisonObservation = z.infer<typeof ComparisonObservation>

export const COMPARISON_ARM_STATUSES = ['planned', 'executed', 'blocked', 'failed', 'skipped'] as const
export const ComparisonArmStatus = z.enum(COMPARISON_ARM_STATUSES)
export type ComparisonArmStatus = z.infer<typeof ComparisonArmStatus>

export const ComparisonArm = z.object({
  role: ComparisonArmRole,
  /** The identity the arm runs as (null = anonymous). References a declared identity. */
  identityRef: z.string().nullable(),
  /** The established session used (null = anonymous / none). */
  sessionRef: z.string().nullable(),
  /** The resource the arm acts on (a declared resource ref). */
  resourceRef: z.string(),
  url: z.string(),
  method: ComparisonMethod,
  body: z.string().nullable().default(null),
  expected: ExpectedBehavior,
  status: ComparisonArmStatus,
  statusReason: z.string().nullable(),
  executionId: z.string().nullable(),
  observation: ComparisonObservation.nullable(),
})
export type ComparisonArm = z.infer<typeof ComparisonArm>

// ── Resource boundary (from Step-1 ownership/tenant graph data; UNKNOWN stays UNKNOWN) ────────────────

export const RESOURCE_RELATIONSHIPS = ['same-owner', 'different-owner', 'same-tenant', 'different-tenant', 'unknown'] as const
export const ResourceRelationship = z.enum(RESOURCE_RELATIONSHIPS)
export type ResourceRelationship = z.infer<typeof ResourceRelationship>

// ── Semantic differences ──────────────────────────────────────────────────────────────────────────────

export const DIFFERENCE_ASPECTS = ['status', 'response-class', 'object', 'fields', 'content', 'state', 'redirect', 'business-result', 'authenticated-identity'] as const
export const DifferenceAspect = z.enum(DIFFERENCE_ASPECTS)
export type DifferenceAspect = z.infer<typeof DifferenceAspect>

export const SemanticDifference = z.object({
  aspect: DifferenceAspect,
  /** The two arm roles being contrasted. */
  between: z.tuple([ComparisonArmRole, ComparisonArmRole]),
  a: z.unknown(),
  b: z.unknown(),
  /** A difference that matters for authorization/business correctness (vs. incidental noise). */
  securityRelevant: z.boolean(),
  detail: z.string(),
})
export type SemanticDifference = z.infer<typeof SemanticDifference>

// ── Controls, cleanup, result ─────────────────────────────────────────────────────────────────────────

export const ComparisonControls = z.object({ positive: z.boolean(), negative: z.boolean() })
export type ComparisonControls = z.infer<typeof ComparisonControls>

export const CleanupStatus = z.object({
  required: z.boolean(),
  attempted: z.boolean(),
  /** null until attempted; failure stays visible and is never reported as restored. */
  succeeded: z.boolean().nullable(),
  detail: z.string().nullable(),
})
export type CleanupStatus = z.infer<typeof CleanupStatus>

/**
 * Cautious result classification — never "vulnerability". `consistent` = behaviour matched the expectation;
 * `inconsistent` = a security-relevant difference contradicted it; `inconclusive` = evidence/controls were
 * insufficient; `blocked` = policy/environment/validation stopped it; `not-tested` = never executed.
 */
export const COMPARISON_RESULTS = ['consistent', 'inconsistent', 'inconclusive', 'blocked', 'not-tested'] as const
export const ComparisonResult = z.enum(COMPARISON_RESULTS)
export type ComparisonResult = z.infer<typeof ComparisonResult>

export const INVARIANT_EVAL_STATUSES = ['supported', 'contradicted', 'inconclusive', 'not-tested'] as const
export const InvariantEvalStatus = z.enum(INVARIANT_EVAL_STATUSES)
export type InvariantEvalStatus = z.infer<typeof InvariantEvalStatus>

// ── Business state (before → action → after) ──────────────────────────────────────────────────────────

/** A compensating request that restores state after a state-changing comparison. */
export const CleanupAction = z.strictObject({
  identityRef: z.string().trim().min(1).max(120).nullable().default(null),
  url: z.string().trim().min(1).max(2048),
  method: ComparisonMethod.default('POST'),
  body: z.string().max(16_384).nullable().default(null),
})
export type CleanupAction = z.infer<typeof CleanupAction>

export const BusinessStateChange = z.object({
  before: ComparisonObservation.nullable(),
  after: ComparisonObservation.nullable(),
  /** The expected transition name, from the declared state machine, when any. */
  expectedTransition: z.string().nullable(),
  /** Whether the observed before→after transition matched the expected one. */
  transitionObserved: z.boolean().nullable(),
  detail: z.string().nullable(),
})
export type BusinessStateChange = z.infer<typeof BusinessStateChange>

// ── The persisted comparison ──────────────────────────────────────────────────────────────────────────

export const ComparisonTransition = z.object({
  at: z.string(),
  from: ComparisonResult.nullable(),
  to: ComparisonResult,
  reason: z.string(),
  actor: z.enum(['audivra', 'ai', 'user']),
})
export type ComparisonTransition = z.infer<typeof ComparisonTransition>

export const COMPARISON_STATUSES = ['planned', 'validated', 'running', 'completed', 'blocked', 'failed'] as const
export const ComparisonStatus = z.enum(COMPARISON_STATUSES)
export type ComparisonStatus = z.infer<typeof ComparisonStatus>

export const SecurityComparison = z.object({
  id: z.string(),
  engagementId: z.string(),
  hypothesisId: z.string().nullable(),
  dimension: ComparisonDimension,
  /** Stable key of dimension + arms (identity/resource/action/expectation) — redundancy control. */
  dedupeKey: z.string(),
  title: z.string(),
  resourceRef: z.string(),
  action: z.string(),
  resourceRelationship: ResourceRelationship,
  invariantRef: z.string().nullable(),
  status: ComparisonStatus,
  arms: z.array(ComparisonArm),
  controls: ComparisonControls,
  semanticDifferences: z.array(SemanticDifference),
  state: BusinessStateChange.nullable(),
  result: ComparisonResult,
  resultReason: z.string(),
  confidence: z.number().min(0).max(1),
  invariantEvaluation: InvariantEvalStatus.nullable(),
  evidenceRefs: z.array(z.string()),
  /** The compensating request run after a state-changing comparison (null: none). */
  cleanupAction: CleanupAction.nullable(),
  /** For a state-transition comparison, the URL read (as the subject) to capture state, and the expected transition. */
  stateProbe: z.object({ url: z.string(), expectedTransition: z.string().nullable() }).nullable(),
  cleanup: CleanupStatus,
  /** True when this stands in for other equivalent resources (coverage is sampled, not exhaustive). */
  coverageSampled: z.boolean(),
  origin: z.enum(['ai', 'user']),
  /** Completed executions that did not settle it (justified transient retries only). */
  retries: z.number().int().min(0),
  history: z.array(ComparisonTransition),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityComparison = z.infer<typeof SecurityComparison>

// ── Plan input (user/AI → engine); every reference must already exist ─────────────────────────────────

export const ComparisonArmPlan = z.strictObject({
  role: ComparisonArmRole,
  identityRef: z.string().trim().min(1).max(120).nullable().default(null),
  resourceRef: z.string().trim().min(1).max(200),
  /** The path/URL to request; validated against engagement scope before execution. */
  url: z.string().trim().min(1).max(2048),
  method: ComparisonMethod.default('GET'),
  /** Request body for a state-changing arm (never a secret; the session is injected by the runtime). */
  body: z.string().max(16_384).nullable().default(null),
  expected: ExpectedBehavior,
})
export type ComparisonArmPlan = z.infer<typeof ComparisonArmPlan>

export const ComparisonPlanInput = z.strictObject({
  hypothesisId: z.string().trim().max(120).nullable().default(null),
  dimension: ComparisonDimension,
  resourceRef: z.string().trim().min(1).max(200),
  action: z.string().trim().min(1).max(120),
  invariantRef: z.string().trim().max(120).nullable().default(null),
  arms: z.array(ComparisonArmPlan).min(1).max(6),
  /** For a state-changing action, whether the engine must attempt cleanup afterwards. */
  cleanupRequired: z.boolean().default(false),
  /** The compensating request that restores state (required in effect when cleanupRequired and state changed). */
  cleanup: CleanupAction.nullable().default(null),
  /** For a state-transition comparison, a URL (as the subject) read before and after to capture the state. */
  stateProbeUrl: z.string().trim().max(2048).nullable().default(null),
  /** The declared state transition the action should cause, when this is a state-transition comparison. */
  expectedTransition: z.string().trim().max(120).nullable().default(null),
  reason: z.string().trim().min(5).max(400).default(''),
  /** The comparison represents a sampled group of equivalent resources. */
  coverageSampled: z.boolean().default(false),
})
export type ComparisonPlanInput = z.infer<typeof ComparisonPlanInput>

/** What the planner (AI) may propose — validated by Audivra before anything executes. */
export const ProposedComparison = z.strictObject({
  hypothesisId: z.string().regex(/^hy_[0-9a-z]{14}$/, 'a hypothesis id (hy_…)'),
  dimension: ComparisonDimension,
  resourceRef: z.string().trim().min(1).max(200),
  action: z.string().trim().min(1).max(120),
  invariantRef: z.string().trim().max(120).nullable().default(null),
  arms: z.array(ComparisonArmPlan).min(1).max(4),
  expectedTransition: z.string().trim().max(120).nullable().default(null),
  reason: z.string().trim().min(5).max(400),
})
export type ProposedComparison = z.infer<typeof ProposedComparison>

export const ComparisonPlannerOutput = z.strictObject({
  comparisons: z.array(ProposedComparison).max(4),
  notes: z.string().max(600).default(''),
})
export type ComparisonPlannerOutput = z.infer<typeof ComparisonPlannerOutput>

// ── Read views ────────────────────────────────────────────────────────────────────────────────────────

/** One invariant and whether controlled comparisons have supported / contradicted it. */
export const InvariantEvaluation = z.object({
  invariantRef: z.string(),
  category: z.string(),
  rule: z.string(),
  status: InvariantEvalStatus,
  supportingComparisonIds: z.array(z.string()),
  contradictingComparisonIds: z.array(z.string()),
  detail: z.string(),
})
export type InvariantEvaluation = z.infer<typeof InvariantEvaluation>

export const ComparisonCoverageDimension = z.object({ tested: z.number().int(), inconsistent: z.number().int(), inconclusive: z.number().int(), blocked: z.number().int() })
export type ComparisonCoverageDimension = z.infer<typeof ComparisonCoverageDimension>

/** Authorization / business coverage — counts and states, never a single fabricated score. */
export const ComparisonCoverage = z.object({
  entities: z.object({
    identities: z.number().int(),
    roles: z.number().int(),
    tenants: z.number().int(),
    resources: z.number().int(),
    actions: z.number().int(),
    businessStates: z.number().int(),
    invariants: z.number().int(),
  }),
  comparisons: z.object({ total: z.number().int(), byResult: z.record(z.string(), z.number().int()), sampled: z.number().int() }),
  dimensions: z.record(z.string(), ComparisonCoverageDimension),
  controls: z.object({ positive: z.number().int(), negative: z.number().int(), both: z.number().int(), neither: z.number().int() }),
  invariants: z.object({ total: z.number().int(), supported: z.number().int(), contradicted: z.number().int(), inconclusive: z.number().int(), notTested: z.number().int() }),
})
export type ComparisonCoverage = z.infer<typeof ComparisonCoverage>

export const SecurityComparisonDetail = z.object({
  comparison: SecurityComparison,
  hypothesis: z.object({ id: z.string(), claim: z.string(), status: z.string() }).nullable(),
  invariant: z.object({ ref: z.string(), rule: z.string(), category: z.string() }).nullable(),
  evidence: z.array(z.object({ ref: z.string(), type: z.string(), title: z.string(), identityRef: z.string().nullable(), sessionRef: z.string().nullable() })),
})
export type SecurityComparisonDetail = z.infer<typeof SecurityComparisonDetail>

/** Actor helper kept consistent with the rest of the security domain. */
export const comparisonActor = (actor: SecurityActor): 'ai' | 'user' => (actor.kind === 'agent' ? 'ai' : 'user')
