import { z } from 'zod'

/*
 * Phase 6E — autonomous security-researcher orchestration. A Research Run is one bounded, persistent,
 * adaptive investigation session inside an existing engagement. It ORCHESTRATES the systems Audivra already
 * owns — graph projection, hypotheses, the comparison planner/engine, the Capability Broker, verification,
 * attack paths, retesting and the optional specialist engine — through a deterministic cycle:
 *
 *   ASSESS → PLAN → VALIDATE → EXECUTE → INGEST → VERIFY → REFLECT  (repeat or stop)
 *
 * The AI reasons (proposes TYPED next actions and concise rationale); Audivra owns authority and truth. The
 * AI cannot change authorization, scope, runtime, secrets, verification or findings, cannot promote the run
 * mode, and its priority is advisory only. All state is persisted outside the model, so a provider/worker
 * restart resumes deterministically. The run is never optimized for finding count — it optimizes for useful
 * evidence, coverage, precision, verified findings, low unnecessary-action rate, and honest residual
 * uncertainty.
 */

// ── Modes (set at creation, immutable; the AI can never promote the mode) ─────────────────────────────

export const RESEARCH_MODES = ['propose-only', 'investigate', 'deep-authorized'] as const
export const ResearchMode = z.enum(RESEARCH_MODES)
export type ResearchMode = z.infer<typeof ResearchMode>

// ── Objective (structured; a free-form note may accompany it but never carries execution authority) ──

export const RESEARCH_OBJECTIVES = ['maximize-coverage', 'investigate-finding', 'investigate-hypothesis', 'investigate-authorization', 'investigate-api-surface', 'investigate-business-rules', 'retest-previous'] as const
export const ResearchObjective = z.enum(RESEARCH_OBJECTIVES)
export type ResearchObjective = z.infer<typeof ResearchObjective>

// ── Run + cycle state ─────────────────────────────────────────────────────────────────────────────────

export const RESEARCH_RUN_STATES = ['created', 'running', 'paused', 'degraded', 'stopped', 'failed'] as const
export const ResearchRunState = z.enum(RESEARCH_RUN_STATES)
export type ResearchRunState = z.infer<typeof ResearchRunState>

export const RESEARCH_STAGES = ['assess', 'plan', 'validate', 'execute', 'ingest', 'verify', 'reflect'] as const
export const ResearchStage = z.enum(RESEARCH_STAGES)
export type ResearchStage = z.infer<typeof ResearchStage>

export const RESEARCH_TERMINATIONS = [
  'objective-satisfied',
  'no-useful-action',
  'information-gain-too-low',
  'coverage-target-reached',
  'budget-exhausted',
  'time-limit',
  'action-limit',
  'ai-unavailable',
  'policy-blocked',
  'user-cancelled',
  'system-failure',
] as const
export const ResearchTermination = z.enum(RESEARCH_TERMINATIONS)
export type ResearchTermination = z.infer<typeof ResearchTermination>

// ── Budget + usage (safe defaults; deep modes may be larger; the model never supplies raw budget) ───

export const ResearchBudget = z.object({
  wallClockMs: z.number().int().positive(),
  maxIterations: z.number().int().positive(),
  maxActions: z.number().int().positive(),
  maxAiCalls: z.number().int().nonnegative(),
  maxSpecialistRuns: z.number().int().nonnegative(),
  maxExpensiveActions: z.number().int().nonnegative(),
})
export type ResearchBudget = z.infer<typeof ResearchBudget>

export const ResearchUsage = z.object({
  iterations: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  aiCalls: z.number().int().nonnegative(),
  specialistRuns: z.number().int().nonnegative(),
  expensiveActions: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
})
export type ResearchUsage = z.infer<typeof ResearchUsage>

// ── Coverage snapshot + residual uncertainty (honest; never "complete pentest") ──────────────────────

export const ResearchCoverageSnapshot = z.object({
  findings: z.number().int(),
  verifiedFindings: z.number().int(),
  supportedFindings: z.number().int(),
  comparisons: z.number().int(),
  identitiesTested: z.number().int(),
  resourcesSampled: z.number().int(),
  attackPaths: z.number().int(),
  openGaps: z.number().int(),
  specialistRuns: z.number().int(),
})
export type ResearchCoverageSnapshot = z.infer<typeof ResearchCoverageSnapshot>

export const ResidualUncertainty = z.object({
  tested: z.array(z.string()),
  partiallyTested: z.array(z.string()),
  notTested: z.array(z.string()),
  unknown: z.array(z.string()),
})
export type ResidualUncertainty = z.infer<typeof ResidualUncertainty>

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────

/** The orchestration surface: every kind maps to an EXISTING Audivra service, never new domain logic. */
export const RESEARCH_ACTION_KINDS = ['observe', 'comparison', 'verify', 'attack-path', 'retest', 'specialist'] as const
export const ResearchActionKind = z.enum(RESEARCH_ACTION_KINDS)
export type ResearchActionKind = z.infer<typeof ResearchActionKind>

export const RESEARCH_ACTION_STATES = ['proposed', 'policy-allowed', 'queued', 'running', 'completed', 'blocked', 'rejected', 'cancelled'] as const
export const ResearchActionState = z.enum(RESEARCH_ACTION_STATES)
export type ResearchActionState = z.infer<typeof ResearchActionState>

export const RESEARCH_ACTION_ORIGINS = ['deterministic', 'ai-proposed'] as const
export const ResearchActionOrigin = z.enum(RESEARCH_ACTION_ORIGINS)
export type ResearchActionOrigin = z.infer<typeof ResearchActionOrigin>

export const ACTION_USEFULNESS = ['high-information-gain', 'useful', 'low-value', 'no-new-information', 'failed', 'blocked'] as const
export const ActionUsefulness = z.enum(ACTION_USEFULNESS)
export type ActionUsefulness = z.infer<typeof ActionUsefulness>

/** Why a proposal was rejected by deterministic validation (never by AI opinion). */
export const ACTION_REJECTIONS = [
  'reference-missing',
  'capability-unavailable',
  'input-invalid',
  'out-of-scope',
  'identity-invalid',
  'environment-disallows',
  'duplicate',
  'evidence-mismatch',
  'budget-exceeded',
  'specialist-unavailable',
  'too-expensive',
  'not-eligible',
] as const
export const ActionRejection = z.enum(ACTION_REJECTIONS)
export type ActionRejection = z.infer<typeof ActionRejection>

/** The cost class used for the cheap-before-expensive rule and concurrency classing. */
export const ACTION_COST_CLASSES = ['cheap', 'normal', 'expensive'] as const
export const ActionCostClass = z.enum(ACTION_COST_CLASSES)
export type ActionCostClass = z.infer<typeof ActionCostClass>

export const SecurityResearchAction = z.object({
  id: z.string(),
  runId: z.string(),
  engagementId: z.string(),
  iteration: z.number().int(),
  kind: ResearchActionKind,
  origin: ResearchActionOrigin,
  state: ResearchActionState,
  /** The structured target of the action: a hypothesis/gap/candidate/finding id or a resource ref. */
  objectiveRef: z.string().nullable(),
  capabilityId: z.string().nullable(),
  /** The typed input Audivra constructed (e.g. a comparison plan) — never a raw command/flags. */
  inputRef: z.record(z.string(), z.unknown()),
  /** Stable fingerprint (kind + asset + identity + meaningful input) for repetition prevention. */
  fingerprint: z.string(),
  costClass: ActionCostClass,
  expectedInformationGain: z.number(),
  rank: z.number(),
  reason: z.string(),
  /** Filled after validation/execution. */
  rejection: ActionRejection.nullable(),
  usefulness: ActionUsefulness.nullable(),
  outcome: z.string(),
  /** Ids this action produced in the existing systems (executions, comparisons, findings, runs). */
  producedRefs: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityResearchAction = z.infer<typeof SecurityResearchAction>

// ── The persistent research run ───────────────────────────────────────────────────────────────────────

export const SecurityResearchRun = z.object({
  id: z.string(),
  engagementId: z.string(),
  parentRunId: z.string().nullable(),
  mode: ResearchMode,
  objective: ResearchObjective,
  objectiveNote: z.string().nullable(),
  /** Structured objective detail (e.g. { findingId } / { previousEngagementId }) — never free-form authority. */
  objectiveDetail: z.record(z.string(), z.unknown()),
  state: ResearchRunState,
  stage: ResearchStage,
  iteration: z.number().int(),
  budget: ResearchBudget,
  usage: ResearchUsage,
  coverageBefore: ResearchCoverageSnapshot,
  coverageAfter: ResearchCoverageSnapshot.nullable(),
  residual: ResidualUncertainty,
  terminationReason: ResearchTermination.nullable(),
  /** A concise structured decision summary (never hidden chain-of-thought). */
  lastDecision: z.string(),
  startingGraphRevision: z.number().int().nullable(),
  providerAvailable: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
})
export type SecurityResearchRun = z.infer<typeof SecurityResearchRun>

// ── Read views ────────────────────────────────────────────────────────────────────────────────────────

export const ResearchTimelineEntry = z.object({ at: z.string(), type: z.string(), message: z.string(), level: z.enum(['info', 'warn', 'error']) })
export type ResearchTimelineEntry = z.infer<typeof ResearchTimelineEntry>

export const SecurityResearchRunDetail = z.object({
  run: SecurityResearchRun,
  actions: z.array(SecurityResearchAction),
  timeline: z.array(ResearchTimelineEntry),
  /** The findings surfaced during this run (read from the authoritative finding store, never asserted here). */
  findings: z.array(z.object({ id: z.string(), title: z.string(), severity: z.string(), verificationState: z.string() })),
})
export type SecurityResearchRunDetail = z.infer<typeof SecurityResearchRunDetail>

// ── AI output (typed proposals only; validated by Audivra before anything runs) ──────────────────────

export const ResearchProposal = z.strictObject({
  kind: ResearchActionKind,
  /** A hypothesis/gap/candidate/finding id or a resource ref the action targets (must already exist). */
  objectiveRef: z.string().trim().max(200).nullable().default(null),
  /** A resource ref to focus a comparison/specialist on (must already be declared). */
  resourceRef: z.string().trim().max(200).nullable().default(null),
  /** A finding id to retest / deepen (must already exist). */
  findingId: z.string().trim().max(120).nullable().default(null),
  /** The AI's advisory priority — never authoritative (Audivra ranks deterministically). */
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  reason: z.string().trim().min(5).max(600),
})
export type ResearchProposal = z.infer<typeof ResearchProposal>

export const ResearchPlannerOutput = z.strictObject({
  proposals: z.array(ResearchProposal).max(6).default([]),
  /** A short structured note; never hidden chain-of-thought. */
  note: z.string().trim().max(600).default(''),
})
export type ResearchPlannerOutput = z.infer<typeof ResearchPlannerOutput>

// ── API input ─────────────────────────────────────────────────────────────────────────────────────────

export const CreateResearchRunInput = z.strictObject({
  mode: ResearchMode.default('propose-only'),
  objective: ResearchObjective.default('maximize-coverage'),
  objectiveNote: z.string().trim().max(1000).nullable().default(null),
  /** Structured objective detail, e.g. { findingId } or { previousEngagementId } (references only). */
  objectiveDetail: z.record(z.string(), z.unknown()).default({}),
  /** Optional budget overrides within safe ceilings; omitted uses the mode's default budget. */
  budget: ResearchBudget.partial().optional(),
})
export type CreateResearchRunInput = z.infer<typeof CreateResearchRunInput>

export const RESEARCH_LIFECYCLE_ACTIONS = ['start', 'pause', 'resume', 'cancel'] as const
export const ResearchLifecycleAction = z.enum(RESEARCH_LIFECYCLE_ACTIONS)
export type ResearchLifecycleAction = z.infer<typeof ResearchLifecycleAction>
