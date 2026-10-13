import { z } from 'zod'
import { AiCoverageState, AiRunProvenance } from './ai.ts'
import { SecurityActor } from './security.ts'
import { RiskClass } from './security-classes.ts'
import { ComparisonDimension, ComparisonResult } from './security-comparison.ts'
import { AiRelationType } from './security-graph.ts'
import { ObservationType } from './security-observation.ts'

/*
 * Hypothesis-driven reasoning (Phase 4). The AI reasons; Audivra stores and validates; the Capability
 * Broker remains the only execution authority.
 *
 *   graph + gaps ─► AI researcher (hypotheses) ─► deterministic validation / dedupe ─► AI verifier (review)
 *               ─► deterministic ranking (information gain) ─► AI planner (typed next capability)
 *               ─► action validation + broker preflight ─► [investigate mode] broker.submit ─► execution
 *               ─► new observations ─► graph projection ─► deterministic evidence checks ─► hypothesis state
 *
 * A hypothesis is a claim to investigate — never a verified vulnerability (that is a later phase). Its
 * support is defined by machine-checkable evidence checks, so its state changes deterministically when new
 * evidence arrives, never because a model says so.
 */

// ── Hypotheses ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle. `confirmed-signal` = independently corroborated signal (not a verified vulnerability);
 * `exhausted` = every eligible way to gather evidence was tried; `blocked` = policy/environment/provider
 * prevents investigating it; `deferred` = parked by ranking or budget.
 */
export const HYPOTHESIS_STATUSES = ['proposed', 'supported', 'needs-evidence', 'disproved', 'confirmed-signal', 'deferred', 'blocked', 'exhausted'] as const
export const HypothesisStatus = z.enum(HYPOTHESIS_STATUSES)
export type HypothesisStatus = z.infer<typeof HypothesisStatus>

/** Terminal for investigation (a later run does not plan actions for them). */
export const RESOLVED_HYPOTHESIS_STATUSES: readonly HypothesisStatus[] = ['disproved', 'confirmed-signal', 'exhausted']
export const isResolvedHypothesis = (status: HypothesisStatus): boolean => RESOLVED_HYPOTHESIS_STATUSES.includes(status)

/**
 * Phase 4 categories come from sensor observations; the Phase 5 Step 4 authorization/business-logic
 * categories are investigated by the differential-comparison engine (not the sensor-driven researcher), and
 * their evidence is a `comparison-result` check. They are kept generic.
 */
export const HYPOTHESIS_CATEGORIES = [
  'attack-surface',
  'technology',
  'endpoint-behavior',
  'api-surface',
  'configuration',
  'evidence-gap',
  'signal-confirmation',
  // Phase 5 Step 4 — authorization / business-logic boundaries (comparison-driven):
  'object-boundary',
  'role-boundary',
  'tenant-boundary',
  'function-level',
  'field-boundary',
  'session-boundary',
  'business-rule',
] as const
export const HypothesisCategory = z.enum(HYPOTHESIS_CATEGORIES)
export type HypothesisCategory = z.infer<typeof HypothesisCategory>

/** The authorization/business categories the differential-comparison engine owns (the sensor loop skips them). */
export const COMPARISON_HYPOTHESIS_CATEGORIES: readonly HypothesisCategory[] = ['object-boundary', 'role-boundary', 'tenant-boundary', 'function-level', 'field-boundary', 'session-boundary', 'business-rule']
export const isComparisonHypothesisCategory = (category: HypothesisCategory): boolean => COMPARISON_HYPOTHESIS_CATEGORIES.includes(category)

export const IMPACT_LEVELS_P4 = ['low', 'medium', 'high'] as const
export const HypothesisImpact = z.enum(IMPACT_LEVELS_P4)
export type HypothesisImpact = z.infer<typeof HypothesisImpact>

export const CheckEffect = z.enum(['supports', 'contradicts'])
export type CheckEffect = z.infer<typeof CheckEffect>

const EntityRef = z.string().regex(/^gn_[0-9a-z]{14}$/, 'an entity id from the graph (gn_…)')
const GapRef = z.string().regex(/^gg_[0-9a-z]{14}$/, 'a knowledge gap id (gg_…)')
const ObservationRef = z.string().regex(/^obs_[0-9a-z]{14}$/, 'an observation id (obs_…)')
const HypothesisRef = z.string().regex(/^hy_[0-9a-z]{14}$/, 'a hypothesis id (hy_…)')

/**
 * Machine-checkable evidence a hypothesis needs, evaluated deterministically against the graph:
 *
 *   response-status            the entity (an endpoint, or an endpoint BELONGS_TO the API operation) has an
 *                              observed HTTP response whose status is in `statuses`
 *   independent-corroboration  the entity is reported by at least two distinct sensors
 *   observation-present        an observation of `observationType` projects onto the entity
 *   entity-contradicted        the entity is in an unresolved conflict
 *   gap-resolved               the knowledge gap has been answered
 *   comparison-result          a differential comparison (Phase 5 Step 4) linked to this hypothesis settled
 *                              with a result in `results` (deterministic, evidence-backed — never AI-declared)
 *
 * At creation every check must be unmet (a claim that is already established or already contradicted is not
 * a useful hypothesis); a later satisfying observation or comparison changes the hypothesis state.
 */
export const EvidenceCheck = z.discriminatedUnion('check', [
  z.strictObject({ check: z.literal('response-status'), entityId: EntityRef, statuses: z.array(z.number().int().min(100).max(599)).min(1).max(20), effect: CheckEffect }),
  z.strictObject({ check: z.literal('independent-corroboration'), entityId: EntityRef, effect: z.literal('supports') }),
  z.strictObject({ check: z.literal('observation-present'), entityId: EntityRef, observationType: ObservationType, effect: CheckEffect }),
  z.strictObject({ check: z.literal('entity-contradicted'), entityId: EntityRef, effect: CheckEffect }),
  z.strictObject({ check: z.literal('gap-resolved'), gapId: GapRef, effect: z.literal('supports') }),
  z.strictObject({ check: z.literal('comparison-result'), dimension: ComparisonDimension.nullable().default(null), results: z.array(ComparisonResult).min(1).max(5), effect: CheckEffect }),
])
export type EvidenceCheck = z.infer<typeof EvidenceCheck>

export const CheckResult = z.object({
  index: z.number().int(),
  met: z.boolean(),
  effect: CheckEffect,
  /** What satisfied it (or why not), in plain words. */
  detail: z.string(),
  /** Observations that satisfied it. */
  observationIds: z.array(z.string()),
  /** Distinct tools behind those observations. */
  tools: z.array(z.string()),
})
export type CheckResult = z.infer<typeof CheckResult>

/** Deterministic, explainable priority. Raw model enthusiasm is not an input. */
export const HypothesisRanking = z.object({
  /** 0..100 — what the planner looks at first. */
  priority: z.number(),
  /** 0..1 — how much one eligible capability is expected to reduce uncertainty. */
  expectedInformationGain: z.number(),
  factors: z.object({
    impact: z.number(),
    confidence: z.number(),
    /** Binary entropy of the confidence: 1 = no idea, 0 = settled. */
    uncertainty: z.number(),
    /** How directly the best eligible capability produces the evidence the checks need (0..1). */
    resolvability: z.number(),
    centrality: z.number(),
    evidenceGap: z.number(),
    novelty: z.number(),
    costUnits: z.number(),
    riskPenalty: z.number(),
    failedAttempts: z.number(),
    environmentEligible: z.boolean(),
  }),
  bestCapabilityId: z.string().nullable(),
  explanation: z.string(),
  rankedAt: z.string(),
})
export type HypothesisRanking = z.infer<typeof HypothesisRanking>

export const HypothesisTransition = z.object({
  at: z.string(),
  from: HypothesisStatus.nullable(),
  to: HypothesisStatus,
  reason: z.string(),
  actor: z.enum(['audivra', 'ai', 'user']),
  runId: z.string().nullable(),
})
export type HypothesisTransition = z.infer<typeof HypothesisTransition>

export const HYPOTHESIS_REVIEW_VERDICTS = ['reasonable', 'unsupported', 'duplicate', 'contradicted', 'needs-evidence', 'not-reviewed'] as const
export const HypothesisReviewVerdict = z.enum(HYPOTHESIS_REVIEW_VERDICTS)
export type HypothesisReviewVerdict = z.infer<typeof HypothesisReviewVerdict>

export const HypothesisOrigin = z.object({
  kind: z.enum(['ai', 'user']),
  runId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
})
export type HypothesisOrigin = z.infer<typeof HypothesisOrigin>

export const SecurityHypothesis = z.object({
  id: z.string(),
  engagementId: z.string(),
  /** Structural dedupe key: category group + the affected entities. */
  dedupeKey: z.string(),
  claim: z.string(),
  category: HypothesisCategory,
  status: HypothesisStatus,
  statusReason: z.string(),
  confidence: z.number().min(0).max(1),
  impact: HypothesisImpact,
  /** Concise, user-facing reason for investigating (never hidden chain-of-thought). */
  rationale: z.string(),
  subjectEntityIds: z.array(z.string()),
  gapIds: z.array(z.string()),
  supportingObservationIds: z.array(z.string()),
  contradictingObservationIds: z.array(z.string()),
  evidenceChecks: z.array(EvidenceCheck),
  checkResults: z.array(CheckResult),
  candidateCapabilities: z.array(z.string()),
  ranking: HypothesisRanking.nullable(),
  expectedInformationGain: z.number().nullable(),
  estimatedCost: z.enum(['low', 'medium', 'high']).nullable(),
  executionRisk: RiskClass.nullable(),
  /** Completed actions that did not resolve it. */
  attempts: z.number().int().min(0),
  origin: HypothesisOrigin,
  review: z.object({ verdict: HypothesisReviewVerdict, note: z.string().nullable(), providerId: z.string().nullable() }),
  history: z.array(HypothesisTransition),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityHypothesis = z.infer<typeof SecurityHypothesis>

// ── Proposed actions (typed next capability) ──────────────────────────────────────────────────────────

/**
 * `rejected` = failed Audivra's validation (unknown capability, invalid input, unknown asset, redundant,
 * unnecessarily expensive); `blocked` = the broker's policy preflight or submission denied it; `skipped` =
 * allowed, but not executed (propose mode, not auto-eligible, or budget).
 */
export const ACTION_STATUSES = ['proposed', 'approved-by-policy', 'queued', 'completed', 'failed', 'blocked', 'rejected', 'skipped'] as const
export const ActionStatus = z.enum(ACTION_STATUSES)
export type ActionStatus = z.infer<typeof ActionStatus>

export const ReasoningAction = z.object({
  id: z.string(),
  engagementId: z.string(),
  runId: z.string(),
  hypothesisId: z.string().nullable(),
  capabilityId: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** Stable key of capability + canonical input (redundancy control). */
  actionKey: z.string(),
  expectedEvidence: z.string(),
  reason: z.string(),
  status: ActionStatus,
  /** Why it was rejected/blocked/skipped. */
  statusReason: z.string().nullable(),
  decision: z.object({ decision: z.enum(['allow', 'deny']), stage: z.string(), rule: z.string(), reason: z.string() }).nullable(),
  executionId: z.string().nullable(),
  result: z.object({ executionStatus: z.string(), observations: z.number().int(), summary: z.string().nullable() }).nullable(),
  costClass: z.enum(['low', 'medium', 'high']).nullable(),
  origin: z.enum(['ai', 'user']),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ReasoningAction = z.infer<typeof ReasoningAction>

// ── Reasoning runs (persistent, bounded loop state) ───────────────────────────────────────────────────

/** `propose` plans without executing (the default); `investigate` also runs policy-approved, auto-eligible actions. */
export const REASONING_MODES = ['propose', 'investigate'] as const
export const ReasoningMode = z.enum(REASONING_MODES)
export type ReasoningMode = z.infer<typeof ReasoningMode>

export const REASONING_RUN_STATUSES = ['queued', 'running', 'waiting', 'completed', 'blocked', 'failed', 'cancelled'] as const
export const ReasoningRunStatus = z.enum(REASONING_RUN_STATUSES)
export type ReasoningRunStatus = z.infer<typeof ReasoningRunStatus>
export const isTerminalReasoningStatus = (s: ReasoningRunStatus): boolean => s === 'completed' || s === 'blocked' || s === 'failed' || s === 'cancelled'

export const REASONING_STAGES = ['ingest', 'assess', 'generate', 'rank', 'plan', 'execute', 'await', 'done'] as const
export const ReasoningStage = z.enum(REASONING_STAGES)
export type ReasoningStage = z.infer<typeof ReasoningStage>

/** Why the loop stopped (persisted with every finished run). */
export const REASONING_STOP_REASONS = [
  'sufficient-evidence',
  'nothing-to-investigate',
  'no-eligible-capability',
  'low-information-gain',
  'policy-blocked',
  'awaiting-approval',
  'budget-exhausted',
  'provider-unavailable',
  'provider-refused',
  'ai-output-invalid',
  'cancelled',
  'internal-error',
] as const
export const ReasoningStopReason = z.enum(REASONING_STOP_REASONS)
export type ReasoningStopReason = z.infer<typeof ReasoningStopReason>

/** Strict ceilings; a request can lower them, never raise them. */
export const REASONING_BUDGET_CEILINGS = { maxIterations: 5, maxAiCalls: 20, maxActions: 6, wallClockMs: 60 * 60_000, maxCostUnits: 16 } as const

export const ReasoningBudget = z.strictObject({
  maxIterations: z.number().int().min(1).max(REASONING_BUDGET_CEILINGS.maxIterations).default(3),
  maxAiCalls: z.number().int().min(0).max(REASONING_BUDGET_CEILINGS.maxAiCalls).default(9),
  maxActions: z.number().int().min(0).max(REASONING_BUDGET_CEILINGS.maxActions).default(3),
  wallClockMs: z.number().int().min(10_000).max(REASONING_BUDGET_CEILINGS.wallClockMs).default(30 * 60_000),
  /** Capability cost units (low 1, medium 2, high 4). */
  maxCostUnits: z.number().int().min(0).max(REASONING_BUDGET_CEILINGS.maxCostUnits).default(6),
})
export type ReasoningBudget = z.infer<typeof ReasoningBudget>

export const ReasoningUsage = z.object({
  iterations: z.number().int(),
  aiCalls: z.number().int(),
  aiAttempts: z.number().int(),
  actionsProposed: z.number().int(),
  actionsExecuted: z.number().int(),
  costUnits: z.number(),
  elapsedMs: z.number().int(),
  /** Summed only where a provider reports cost. */
  aiCostUsd: z.number().nullable(),
  /** Provider id → AI calls served. */
  providers: z.record(z.string(), z.number().int()),
  /** Stage → milliseconds spent. */
  stageMs: z.record(z.string(), z.number().int()),
  /** What Audivra's validation did with model output (the false-positive pressure, made measurable). */
  quality: z.object({
    hypothesesProposed: z.number().int(),
    hypothesesAccepted: z.number().int(),
    hypothesesMerged: z.number().int(),
    /** Rejection reason → count (unknown-entity, unrelated-evidence, unsupported, claim-outside-graph, …). */
    hypothesesRejected: z.record(z.string(), z.number().int()),
    relationshipsAccepted: z.number().int(),
    relationshipsRejected: z.number().int(),
    /** Rejection reason → count (invalid-input, unknown-asset, redundant, unnecessary-cost, …). */
    actionsRejected: z.record(z.string(), z.number().int()),
    actionsBlocked: z.number().int(),
    actionsSkipped: z.number().int(),
  }),
})
export type ReasoningUsage = z.infer<typeof ReasoningUsage>

export const emptyReasoningUsage = (): ReasoningUsage => ({
  iterations: 0,
  aiCalls: 0,
  aiAttempts: 0,
  actionsProposed: 0,
  actionsExecuted: 0,
  costUnits: 0,
  elapsedMs: 0,
  aiCostUsd: null,
  providers: {},
  stageMs: {},
  quality: { hypothesesProposed: 0, hypothesesAccepted: 0, hypothesesMerged: 0, hypothesesRejected: {}, relationshipsAccepted: 0, relationshipsRejected: 0, actionsRejected: {}, actionsBlocked: 0, actionsSkipped: 0 },
})

/** One concise, auditable decision of the loop — the rationale trail, not a chain-of-thought. */
export const ReasoningDecision = z.object({ at: z.string(), iteration: z.number().int(), stage: ReasoningStage, message: z.string() })
export type ReasoningDecision = z.infer<typeof ReasoningDecision>

export const ReasoningRun = z.object({
  id: z.string(),
  engagementId: z.string(),
  mode: ReasoningMode,
  status: ReasoningRunStatus,
  stage: ReasoningStage,
  iteration: z.number().int(),
  budget: ReasoningBudget,
  usage: ReasoningUsage,
  stopReason: ReasoningStopReason.nullable(),
  stopDetail: z.string().nullable(),
  aiCoverage: AiCoverageState.nullable(),
  decisions: z.array(ReasoningDecision),
  aiRuns: z.array(AiRunProvenance),
  waitingOn: z.array(z.string()),
  requestedBy: SecurityActor,
  cancelRequestedAt: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
})
export type ReasoningRun = z.infer<typeof ReasoningRun>

export const StartReasoningInput = z.strictObject({
  mode: ReasoningMode.default('propose'),
  budget: ReasoningBudget.partial().optional(),
})
export type StartReasoningInput = z.input<typeof StartReasoningInput>

// ── Structured AI outputs (validated by Audivra before anything is persisted) ────────────────────────

export const ProposedHypothesis = z.strictObject({
  claim: z.string().trim().min(10).max(300),
  category: HypothesisCategory,
  impact: HypothesisImpact,
  confidence: z.number().min(0).max(1),
  subjectEntityIds: z.array(EntityRef).min(1).max(6),
  supportingObservationIds: z.array(ObservationRef).max(10).default([]),
  contradictingObservationIds: z.array(ObservationRef).max(10).default([]),
  gapIds: z.array(GapRef).max(6).default([]),
  evidenceChecks: z.array(EvidenceCheck).min(1).max(4),
  candidateCapabilities: z.array(z.string().max(120)).max(3).default([]),
  rationale: z.string().trim().min(10).max(600),
  /** The model's suggestion that this restates an existing hypothesis; merged only if references agree. */
  duplicateOf: HypothesisRef.nullable().default(null),
})
export type ProposedHypothesis = z.infer<typeof ProposedHypothesis>

export const ProposedRelationship = z.strictObject({
  type: AiRelationType,
  fromEntityId: EntityRef,
  toEntityId: EntityRef,
  confidence: z.number().min(0).max(1),
  supportingObservationIds: z.array(ObservationRef).min(1).max(6),
  rationale: z.string().trim().min(10).max(400),
})
export type ProposedRelationship = z.infer<typeof ProposedRelationship>

/** Researcher (`security-analyze-observations`): hypotheses + optional relationship enrichment. */
export const ResearcherOutput = z.strictObject({
  hypotheses: z.array(ProposedHypothesis).max(8),
  relationships: z.array(ProposedRelationship).max(10).default([]),
  notes: z.string().max(1000).default(''),
})
export type ResearcherOutput = z.infer<typeof ResearcherOutput>

/** Verifier (`security-verify-claim`): an independent review of the researcher's accepted proposals. */
export const VerifierOutput = z.strictObject({
  reviews: z
    .array(
      z.strictObject({
        proposal: z.number().int().min(0).max(7),
        verdict: HypothesisReviewVerdict.exclude(['not-reviewed']),
        duplicateOf: HypothesisRef.nullable().default(null),
        contradictingObservationIds: z.array(ObservationRef).max(6).default([]),
        note: z.string().trim().max(400),
      }),
    )
    .max(8),
})
export type VerifierOutput = z.infer<typeof VerifierOutput>

export const ProposedAction = z.strictObject({
  hypothesisId: HypothesisRef,
  capabilityId: z.string().min(3).max(120),
  /** The capability's own input; validated against its strict schema (unknown fields rejected). */
  input: z.record(z.string(), z.unknown()),
  expectedEvidence: z.string().trim().min(5).max(300),
  reason: z.string().trim().min(5).max(400),
})
export type ProposedAction = z.infer<typeof ProposedAction>

/** Planner (`security-plan`): the next useful capability per hypothesis — never an image, command or scope. */
export const PlannerOutput = z.strictObject({
  actions: z.array(ProposedAction).max(4),
  notes: z.string().max(600).default(''),
})
export type PlannerOutput = z.infer<typeof PlannerOutput>

// ── Coverage ───────────────────────────────────────────────────────────────────────────────────────────

/** Reasoning coverage: what was investigated and what remains unknown — never an "AI security score". */
export const ReasoningCoverage = z.object({
  graph: z.object({
    entities: z.number().int(),
    relationships: z.number().int(),
    observed: z.number().int(),
    inferred: z.number().int(),
    contradicted: z.number().int(),
    stale: z.number().int(),
    /** In-scope endpoints with a known response / all in-scope endpoints. */
    endpointsInspected: z.object({ known: z.number().int(), total: z.number().int() }),
    /** Technologies reported by ≥2 sensors / all technologies. */
    technologiesCorroborated: z.object({ corroborated: z.number().int(), total: z.number().int() }),
  }),
  gaps: z.object({ open: z.number().int(), resolved: z.number().int(), byKind: z.record(z.string(), z.object({ open: z.number().int(), resolved: z.number().int() })) }),
  hypotheses: z.object({
    total: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    investigated: z.number().int(),
    blocked: z.number().int(),
    exhausted: z.number().int(),
  }),
  actions: z.object({ total: z.number().int(), byStatus: z.record(z.string(), z.number().int()) }),
  latestRun: z.object({ id: z.string(), status: ReasoningRunStatus, stopReason: ReasoningStopReason.nullable(), aiCoverage: AiCoverageState.nullable(), finishedAt: z.string().nullable() }).nullable(),
})
export type ReasoningCoverage = z.infer<typeof ReasoningCoverage>

/** A hypothesis with everything needed to answer "why is Audivra investigating this?". */
export const SecurityHypothesisDetail = z.object({
  hypothesis: SecurityHypothesis,
  entities: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), basis: z.string(), status: z.string() })),
  supporting: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), asset: z.string(), tools: z.array(z.string()), evidenceRefs: z.array(z.string()) })),
  contradicting: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), asset: z.string(), tools: z.array(z.string()), evidenceRefs: z.array(z.string()) })),
  gaps: z.array(z.object({ id: z.string(), kind: z.string(), question: z.string(), status: z.string() })),
  actions: z.array(ReasoningAction),
})
export type SecurityHypothesisDetail = z.infer<typeof SecurityHypothesisDetail>
