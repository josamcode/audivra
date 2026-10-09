import { z } from 'zod'

/*
 * The provider-independent AI platform contracts (Phase 3C). Audivra owns the reasoning task, the
 * provider selection, the validation and the persisted knowledge; a provider (Claude today, another
 * later) is interchangeable compute behind one stable interface. These types never mention a specific
 * model, session format or CLI — those live only inside a provider adapter and its configuration.
 *
 *   AI task (what reasoning is needed) → router → provider adapter → structured result → Audivra validation
 *
 * Phase 3C defines the primitives; the autonomous reasoning behaviour that uses them is a later phase.
 */

// ── Normalized outcomes ────────────────────────────────────────────────────────────────────────────

/**
 * A provider result, normalized so the rest of the product never sees raw provider errors. The crucial
 * split: `provider-refused` (the provider declined under its own policy) is distinct and is NEVER
 * auto-replayed elsewhere to evade that policy; transient outcomes may follow a bounded resilience policy.
 */
export const AI_OUTCOMES = [
  'succeeded',
  'provider-refused',
  'provider-unavailable',
  'provider-timeout',
  'rate-limited',
  'auth-failed',
  'context-limit',
  'invalid-structured-output',
  'tool-failure',
  'cancelled',
  'internal-error',
] as const
export const AiOutcome = z.enum(AI_OUTCOMES)
export type AiOutcome = z.infer<typeof AiOutcome>

/** Outcomes that are reasonably transient — eligible for bounded retry / configured fallback. */
export const TRANSIENT_AI_OUTCOMES: readonly AiOutcome[] = ['provider-unavailable', 'provider-timeout', 'rate-limited', 'tool-failure']

/** A policy refusal: terminal for this provider, and never rerouted to another to bypass the refusal. */
export const REFUSAL_AI_OUTCOME: AiOutcome = 'provider-refused'

export function isTransientOutcome(outcome: AiOutcome): boolean {
  return TRANSIENT_AI_OUTCOMES.includes(outcome)
}
export function isRefusal(outcome: AiOutcome): boolean {
  return outcome === REFUSAL_AI_OUTCOME
}

// ── Provider health ────────────────────────────────────────────────────────────────────────────────

export const PROVIDER_HEALTH_STATES = ['ready', 'unavailable', 'auth-required', 'rate-limited', 'misconfigured', 'disabled'] as const
export const ProviderHealthState = z.enum(PROVIDER_HEALTH_STATES)
export type ProviderHealthState = z.infer<typeof ProviderHealthState>

export const ProviderHealth = z.object({
  providerId: z.string(),
  state: ProviderHealthState,
  version: z.string().nullable(),
  detail: z.string().nullable(),
  checkedAt: z.string(),
})
export type ProviderHealth = z.infer<typeof ProviderHealth>

// ── Capability profiles ────────────────────────────────────────────────────────────────────────────

export const AI_EFFORT_CLASSES = ['low', 'standard', 'high'] as const
export const AiEffortClass = z.enum(AI_EFFORT_CLASSES)
export type AiEffortClass = z.infer<typeof AiEffortClass>

/** What reasoning a task needs — generalized, provider-agnostic. Phase 4 adds the behaviour behind these. */
export const AI_TASK_TYPES = [
  'security-understand',
  'security-plan',
  'security-analyze-observations',
  'security-verify-claim',
  'security-summarize',
  /** The existing Website Audit roles, as one generalized type (their orchestration is unchanged). */
  'website-audit',
] as const
export const AiTaskType = z.enum(AI_TASK_TYPES)
export type AiTaskType = z.infer<typeof AiTaskType>

/** What a provider/model declares it can do. Audivra checks this before dispatch. */
export const ProviderCapabilities = z.object({
  providerId: z.string(),
  /** Can return a schema-constrained structured result. */
  structuredOutput: z.boolean(),
  /** Can call Audivra-exposed tools/capabilities during a run. */
  toolUse: z.boolean(),
  /** Can resume a prior session (otherwise context must be rebuilt from Audivra state each run). */
  sessionResume: z.boolean(),
  /** Can drive the browser MCP tooling. */
  browserTools: z.boolean(),
  /** Context window, when known. */
  maxContextTokens: z.number().int().positive().nullable(),
  effortLevels: z.array(AiEffortClass),
  /** Task types this provider is eligible for. */
  taskTypes: z.array(AiTaskType),
})
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>

/** What a task requires of a provider; the router matches these against a provider's capabilities. */
export const ProviderRequirements = z.object({
  structuredOutput: z.boolean().default(true),
  toolUse: z.boolean().default(false),
  sessionResume: z.boolean().default(false),
  minContextTokens: z.number().int().positive().optional(),
})
export type ProviderRequirements = z.infer<typeof ProviderRequirements>

// ── Budgets (provider-independent) ─────────────────────────────────────────────────────────────────

export const AiBudget = z.object({
  wallClockMs: z.number().int().positive(),
  toolCalls: z.number().int().min(0).default(0),
  turns: z.number().int().positive().optional(),
  maxContextTokens: z.number().int().positive().optional(),
  /** Optional cost ceiling where a provider reports cost; advisory for providers that do not. */
  costUsd: z.number().positive().optional(),
})
export type AiBudget = z.infer<typeof AiBudget>

// ── AI task spec (the platform primitive) ────────────────────────────────────────────────────────────

/**
 * A reasoning task: WHAT is needed, never WHICH model does it. Input/context are referenced abstractly;
 * the provider-independent context builder renders trusted vs untrusted material. Phase 4 populates the
 * task behaviour; Phase 3C only defines and routes it.
 */
export const AiTaskSpec = z.object({
  taskType: AiTaskType,
  /** Logical role name (e.g. an analyzer/verifier label), independent of any provider role concept. */
  role: z.string().min(1).max(60),
  effort: AiEffortClass.default('standard'),
  budget: AiBudget,
  requirements: ProviderRequirements.default({ structuredOutput: true, toolUse: false, sessionResume: false }),
  /** Identifier of the schema the structured output must satisfy (resolved by the domain, not the provider). */
  outputSchemaId: z.string().min(1).max(120),
  /** Audivra capability ids this task may request through the broker (never raw runtime authority). */
  allowedCapabilities: z.array(z.string()).default([]),
  /** Opaque references to trusted/untrusted inputs the context builder will resolve. */
  trustedRefs: z.array(z.string()).default([]),
  untrustedRefs: z.array(z.string()).default([]),
})
export type AiTaskSpec = z.infer<typeof AiTaskSpec>

// ── Selection, provenance and normalized task outcome ────────────────────────────────────────────────

export const ProviderConsideration = z.object({ providerId: z.string(), eligible: z.boolean(), reason: z.string() })
export type ProviderConsideration = z.infer<typeof ProviderConsideration>

/** The deterministic, auditable record of which provider was chosen and why. */
export const ProviderSelection = z.object({
  taskType: AiTaskType,
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reason: z.string(),
  considered: z.array(ProviderConsideration),
  at: z.string(),
})
export type ProviderSelection = z.infer<typeof ProviderSelection>

/**
 * What every AI task records for auditability. No hidden chain-of-thought — only structured outputs and
 * concise, auditable rationale/metadata.
 */
export const AiRunProvenance = z.object({
  taskType: AiTaskType,
  role: z.string(),
  providerId: z.string(),
  model: z.string().nullable(),
  /** Version of the provider adapter that produced this (so a change is attributable). */
  adapterVersion: z.string(),
  promptVersion: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** Provider-native termination reason, kept for diagnostics (never raw reasoning). */
  terminationReason: z.string(),
  outcome: AiOutcome,
  toolCalls: z.record(z.string(), z.number()).default({}),
  costUsd: z.number().nullable().default(null),
  tokens: z.number().int().nullable().default(null),
  outputStatus: z.enum(['valid', 'invalid', 'none']),
})
export type AiRunProvenance = z.infer<typeof AiRunProvenance>

/** The normalized result of running a task through the router. */
export const AiTaskOutcome = z.object({
  outcome: AiOutcome,
  /** The structured output when `succeeded`; null otherwise. Validation is the domain's responsibility. */
  output: z.unknown().nullable(),
  selection: ProviderSelection,
  provenance: z.array(AiRunProvenance),
  /** Provider attempts made (including a transient-fallback attempt). */
  attempts: z.number().int().min(0),
  /** True only for a policy refusal — recorded distinctly, never rerouted to evade the refusal. */
  refused: z.boolean(),
})
export type AiTaskOutcome = z.infer<typeof AiTaskOutcome>

// ── Coverage for AI reasoning stages (prepared for Phase 4) ──────────────────────────────────────────

/** How an AI reasoning stage turned out, for coverage. `provider-unavailable`/`refused` are never "secure". */
export const AI_COVERAGE_STATES = ['completed', 'partial', 'blocked', 'provider-unavailable', 'provider-refused', 'not-required'] as const
export const AiCoverageState = z.enum(AI_COVERAGE_STATES)
export type AiCoverageState = z.infer<typeof AiCoverageState>

// ── System view (read-only) ──────────────────────────────────────────────────────────────────────────

export const AiProviderStatus = z.object({ health: ProviderHealth, capabilities: ProviderCapabilities })
export type AiProviderStatus = z.infer<typeof AiProviderStatus>

/** Read-only AI provider status for the System area. Never carries credentials or secrets. */
export const AiSystemStatus = z.object({
  /** Configured preferred provider id. */
  preferred: z.string(),
  /** False when AI is turned off by configuration. */
  enabled: z.boolean(),
  providers: z.array(AiProviderStatus),
})
export type AiSystemStatus = z.infer<typeof AiSystemStatus>
