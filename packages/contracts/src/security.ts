import { z } from 'zod'
import { EvidenceSource, EvidenceType } from './enums.ts'
import { ObservationType } from './security-observation.ts'
import { MutationClass, RiskClass, SecurityEnvironment } from './security-classes.ts'
import { PolicyProfileKey, POLICY_PERMISSIONS } from './security-policy.ts'
import { ExecutionLimits, Port, ScopeEvaluation, ScopeHost, ScopeManifest } from './security-scope.ts'
import { normalizeTargetUrl } from './url.ts'

/*
 * Security engagements: an authorized security assessment of a target. What may execute inside one is
 * decided by deterministic code from four trusted inputs — authorization records, the scope manifest,
 * the environment and the pinned policy profile. None of them can be set by model output or by anything
 * observed on the target.
 */

// ── Capability metadata (what a capability is; how it is implemented lives in @audivra/security) ─────

/** `diagnostic` capabilities prove the platform itself (e.g. the execution runtime) and never contact a target. */
export const CAPABILITY_FAMILIES = ['discovery', 'browser', 'traffic', 'web', 'api', 'authorization', 'source', 'dependency', 'network', 'oast', 'diagnostic'] as const
export const CapabilityFamily = z.enum(CAPABILITY_FAMILIES)
export type CapabilityFamily = z.infer<typeof CapabilityFamily>

export const RATE_LIMIT_CLASSES = ['none', 'light', 'standard', 'heavy'] as const

/**
 * How a capability is carried out. `in-process`: reviewed, lightweight platform code in the worker (the
 * Phase 2A backend). `isolated-container`: an approved, execution-scoped container. Declared by the
 * capability and recorded in the trusted snapshot; Audivra chooses the backend from it — a request, a
 * caller or a model never can.
 */
export const EXECUTION_MODES = ['in-process', 'isolated-container'] as const
export const ExecutionMode = z.enum(EXECUTION_MODES)
export type ExecutionMode = z.infer<typeof ExecutionMode>

/**
 * Network a capability needs. `none`: no network at all. `scoped-egress`: outbound HTTP through an
 * Audivra-controlled, execution-private gateway that enforces the trusted scope — the executor has no
 * other route. Declared by the capability; Audivra chooses how it is implemented.
 */
export const NETWORK_PROFILES = ['none', 'scoped-egress'] as const
export const NetworkProfile = z.enum(NETWORK_PROFILES)
export type NetworkProfile = z.infer<typeof NetworkProfile>

export const CapabilityExecution = z
  .strictObject({
    mode: ExecutionMode,
    /** Stable id of an Audivra-approved runtime (isolated-container only) — never an image, path or option. */
    runtime: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,40}$/)
      .nullable(),
    /** Network profile (omitted = none). `scoped-egress` is only available to isolated-container capabilities. */
    network: NetworkProfile.optional(),
  })
  .refine((e) => (e.mode === 'isolated-container') === (e.runtime !== null), 'An isolated-container capability names an approved runtime; an in-process one names none')
  .refine((e) => e.network !== 'scoped-egress' || e.mode === 'isolated-container', 'scoped-egress is only available to isolated-container capabilities')
export type CapabilityExecution = z.infer<typeof CapabilityExecution>

/** The execution a capability declares; omitted means in-process (trusted platform code). */
export function capabilityExecution(meta: { execution?: CapabilityExecution | undefined }): { mode: ExecutionMode; runtime: string | null; network: NetworkProfile } {
  const e = meta.execution ?? { mode: 'in-process' as const, runtime: null }
  return { mode: e.mode, runtime: e.runtime, network: e.network ?? 'none' }
}

export const SecurityCapabilityMetadata = z.strictObject({
  /** Stable identifier `<family>.<name>`, e.g. `discovery.http-observe`. */
  id: z.string().regex(/^[a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Capability ids look like "family.name"'),
  version: z.number().int().positive(),
  family: CapabilityFamily,
  name: z.string().min(3).max(80),
  description: z.string().min(10).max(500),
  riskClass: RiskClass,
  sideEffect: MutationClass,
  supportedEnvironments: z.array(SecurityEnvironment).min(1),
  requiresAuthorization: z.boolean(),
  /** Needs a test identity from the (future) credential vault. */
  requiresIdentity: z.boolean(),
  requiresNetwork: z.boolean(),
  /** Calls a service outside the engagement (e.g. a callback host). */
  requiresExternalIntegration: z.boolean(),
  supportsCancellation: z.boolean(),
  rateLimitClass: z.enum(RATE_LIMIT_CLASSES),
  resourceProfile: z.strictObject({
    disk: z.enum(['none', 'small', 'large']),
    /** Container image the implementation needs. Never pulled implicitly: a missing image denies execution. */
    containerImage: z.string().nullable(),
    spawnsProcesses: z.boolean(),
  }),
  timeoutProfile: z
    .strictObject({ defaultSeconds: z.number().int().positive(), maxSeconds: z.number().int().positive() })
    .refine((t) => t.defaultSeconds <= t.maxSeconds, 'defaultSeconds cannot exceed maxSeconds'),
  evidenceTypes: z.array(EvidenceType),
  /** Identifier of the implementation, e.g. `builtin/http-observe@1`. */
  implementation: z.string().min(3).max(120),
  /**
   * Present when the capability is a sensor (an approved external tool): the tool, what it observes, and
   * planning metadata a future execution planner can read (what it needs, what it costs) without running
   * it. The deterministic policy — not this metadata — remains authoritative for what may run where.
   */
  sensor: z
    .strictObject({
      tool: z.string().min(1).max(40),
      observationTypes: z.array(ObservationType).min(1),
      /** Inputs the sensor requires beyond a target (e.g. `schema`, `source`); empty for a plain URL sensor. */
      requiredInputs: z.array(z.enum(['url', 'schema', 'source', 'templates'])).default([]),
      /** Rough runtime cost class, for planning/scheduling. */
      costClass: z.enum(['low', 'medium', 'high']).default('medium'),
      /** Typical wall-clock seconds for a bounded run, for planning (not a limit). */
      typicalDurationSeconds: z.number().int().positive().max(3600).default(60),
    })
    .optional(),
  /** How it must be carried out (omitted: in-process). */
  execution: CapabilityExecution.optional(),
  /**
   * Identity awareness (Phase 5 Step 3). Omitted means anonymous-only — the default that keeps every
   * existing capability working unchanged. A capability that reads an identity/session reference declares
   * it here; the runtime, never the capability or a model, resolves the secret material behind it.
   */
  identity: z
    .strictObject({
      supportsIdentity: z.boolean().default(false),
      requiresIdentity: z.boolean().default(false),
      supportsAnonymous: z.boolean().default(true),
      requiresSession: z.boolean().default(false),
    })
    .optional(),
})
export type SecurityCapabilityMetadata = z.infer<typeof SecurityCapabilityMetadata>

/** The effective identity profile of a capability (omitted metadata means anonymous-only). */
export function capabilityIdentity(meta: { identity?: { supportsIdentity: boolean; requiresIdentity: boolean; supportsAnonymous: boolean; requiresSession: boolean } }): {
  supportsIdentity: boolean
  requiresIdentity: boolean
  supportsAnonymous: boolean
  requiresSession: boolean
} {
  const i = meta.identity
  if (!i) return { supportsIdentity: false, requiresIdentity: false, supportsAnonymous: true, requiresSession: false }
  return { supportsIdentity: i.supportsIdentity || i.requiresIdentity || i.requiresSession, requiresIdentity: i.requiresIdentity || i.requiresSession, supportsAnonymous: i.supportsAnonymous && !i.requiresIdentity && !i.requiresSession, requiresSession: i.requiresSession }
}

// ── Authorization ───────────────────────────────────────────────────────────────────────────────────

/**
 * How ownership of a target is established. Only `local-development` is implemented in this version;
 * the others are modelled so they can be added without schema changes and are reported as unavailable.
 */
export const AUTHORIZATION_METHODS = ['local-development', 'dns-txt', 'well-known-file', 'repository', 'deployment', 'manual-approval'] as const
export const AuthorizationMethod = z.enum(AUTHORIZATION_METHODS)
export type AuthorizationMethod = z.infer<typeof AuthorizationMethod>

/** Stored state. `expired` is derived from `expiresAt` when read, never stored. */
export const AUTHORIZATION_STATUSES = ['pending', 'verified', 'failed', 'revoked'] as const
export const AuthorizationStatus = z.enum(AUTHORIZATION_STATUSES)
export type AuthorizationStatus = z.infer<typeof AuthorizationStatus>

export const EffectiveAuthorizationStatus = z.enum([...AUTHORIZATION_STATUSES, 'expired'])
export type EffectiveAuthorizationStatus = z.infer<typeof EffectiveAuthorizationStatus>

/** What an authorization covers: one host, optionally one port, optionally its subdomains. */
export const AuthorizationSubject = z.strictObject({
  host: ScopeHost,
  /** null: any port of the host. */
  port: Port.nullable().default(null),
  includeSubdomains: z.boolean().default(false),
})
export type AuthorizationSubject = z.infer<typeof AuthorizationSubject>

export const AuthorizationMethodInfo = z.object({
  method: AuthorizationMethod,
  label: z.string(),
  description: z.string(),
  available: z.boolean(),
  /** Why the method cannot be used in this version or for this engagement. */
  unavailableReason: z.string().nullable(),
})
export type AuthorizationMethodInfo = z.infer<typeof AuthorizationMethodInfo>

export const SecurityAuthorizationItem = z.object({
  id: z.string(),
  engagementId: z.string(),
  method: AuthorizationMethod,
  status: AuthorizationStatus,
  effectiveStatus: EffectiveAuthorizationStatus,
  subject: AuthorizationSubject,
  reason: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  /** External reference (approval ticket, deployment id) when the method has one. */
  reference: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityAuthorizationItem = z.infer<typeof SecurityAuthorizationItem>

// ── Engagement lifecycle ────────────────────────────────────────────────────────────────────────────

/**
 * draft / authorization-pending / ready are recomputed from requirements after every change; active,
 * paused, completed and cancelled are explicit lifecycle actions. Status is a label only: the broker
 * re-evaluates readiness for every request and never trusts it.
 */
export const ENGAGEMENT_STATUSES = ['draft', 'authorization-pending', 'ready', 'active', 'paused', 'completed', 'cancelled', 'invalid'] as const
export const EngagementStatus = z.enum(ENGAGEMENT_STATUSES)
export type EngagementStatus = z.infer<typeof EngagementStatus>

export const LIFECYCLE_ACTIONS = ['activate', 'pause', 'resume', 'complete', 'cancel'] as const
export const LifecycleAction = z.enum(LIFECYCLE_ACTIONS)
export type LifecycleAction = z.infer<typeof LifecycleAction>

// ── Readiness ───────────────────────────────────────────────────────────────────────────────────────

export const READINESS_STATES = ['ready', 'scope-incomplete', 'policy-incomplete', 'not-authorized', 'outside-window', 'paused', 'closed', 'invalid'] as const
export const ReadinessState = z.enum(READINESS_STATES)
export type ReadinessState = z.infer<typeof ReadinessState>

export const READINESS_CHECK_KEYS = ['lifecycle', 'environment', 'scope', 'policy', 'authorization', 'testing-window'] as const

export const ReadinessCheck = z.object({
  key: z.enum(READINESS_CHECK_KEYS),
  label: z.string(),
  ok: z.boolean(),
  reason: z.string(),
})
export type ReadinessCheck = z.infer<typeof ReadinessCheck>

export const EngagementReadiness = z.object({
  ready: z.boolean(),
  state: ReadinessState,
  label: z.string(),
  checks: z.array(ReadinessCheck),
  blockingReasons: z.array(z.string()),
  evaluatedAt: z.string(),
})
export type EngagementReadiness = z.infer<typeof EngagementReadiness>

// ── Effective policy ────────────────────────────────────────────────────────────────────────────────

export const EffectivePermission = z.enum(['allowed', 'bounded', 'denied'])
export type EffectivePermission = z.infer<typeof EffectivePermission>

export const EffectivePolicy = z.object({
  environment: SecurityEnvironment.nullable(),
  /** Environment the policy was evaluated for (production while none is chosen: the most restrictive). */
  evaluatedEnvironment: SecurityEnvironment,
  profile: z.object({ key: z.string(), version: z.number(), name: z.string(), description: z.string(), known: z.boolean() }),
  risk: z.array(
    z.object({ value: RiskClass, profile: z.enum(POLICY_PERMISSIONS), selected: z.boolean(), effective: EffectivePermission, reason: z.string() }),
  ),
  mutation: z.array(
    z.object({ value: MutationClass, profile: z.enum(POLICY_PERMISSIONS), selected: z.boolean(), effective: EffectivePermission, reason: z.string() }),
  ),
  externalIntegrations: z.object({ profile: z.enum(['opt-in', 'deny']), selected: z.enum(['deny', 'allow']), effective: EffectivePermission }),
  limits: z.object({ effective: ExecutionLimits, ceilings: ExecutionLimits, bounded: ExecutionLimits, clamped: z.array(z.string()) }),
  /** Problems that make the policy unusable (blocking readiness). */
  issues: z.array(z.string()),
})
export type EffectivePolicy = z.infer<typeof EffectivePolicy>

// ── Actors, decisions and the audit trail ───────────────────────────────────────────────────────────

/**
 * Who asked. Only `user` (a person through the API) and `system` may change engagement configuration;
 * `agent` may only *request* capabilities, which the broker evaluates like any other request.
 */
export const SecurityActor = z.strictObject({
  kind: z.enum(['user', 'system', 'agent']),
  id: z.string().max(120).nullable().default(null),
  agentRunId: z.string().max(120).nullable().default(null),
})
export type SecurityActor = z.infer<typeof SecurityActor>

export const DECISION_STAGES = ['capability', 'input', 'engagement', 'readiness', 'authorization', 'identity', 'scope', 'policy', 'resources'] as const
export const DecisionStage = z.enum(DECISION_STAGES)
export type DecisionStage = z.infer<typeof DecisionStage>

export const DecisionCheck = z.object({
  stage: DecisionStage,
  outcome: z.enum(['pass', 'fail', 'skipped']),
  rule: z.string(),
  reason: z.string(),
})
export type DecisionCheck = z.infer<typeof DecisionCheck>

export const AuthorizationDecisionState = z.enum(['valid', 'missing', 'pending', 'failed', 'expired', 'revoked', 'not-required', 'not-evaluated'])

/** A complete, self-contained explanation of why a capability request was allowed or denied. */
export const PolicyDecision = z.object({
  decision: z.enum(['allow', 'deny']),
  stage: DecisionStage,
  rule: z.string(),
  reason: z.string(),
  executionId: z.string(),
  correlationId: z.string(),
  engagementId: z.string(),
  engagementStatus: EngagementStatus.nullable(),
  configVersion: z.number().nullable(),
  capability: z
    .object({ id: z.string(), version: z.number(), implementation: z.string(), riskClass: RiskClass, sideEffect: MutationClass })
    .nullable(),
  environment: SecurityEnvironment.nullable(),
  authorization: z.object({
    required: z.boolean(),
    state: AuthorizationDecisionState,
    authorizationIds: z.array(z.string()),
    reason: z.string(),
  }),
  scope: z.object({ version: z.number(), hash: z.string(), evaluations: z.array(ScopeEvaluation) }).nullable(),
  policy: z
    .object({
      profileKey: z.string(),
      profileVersion: z.number(),
      risk: EffectivePermission,
      mutation: EffectivePermission,
      limits: ExecutionLimits.nullable(),
    })
    .nullable(),
  checks: z.array(DecisionCheck),
  actor: SecurityActor,
  evaluatedAt: z.string(),
})
export type PolicyDecision = z.infer<typeof PolicyDecision>

export const SECURITY_EVENT_TYPES = [
  'engagement.created',
  'engagement.updated',
  'environment.changed',
  'scope.changed',
  'policy.changed',
  'authorization.requested',
  'authorization.changed',
  'lifecycle.changed',
  'capability.requested',
  'capability.allowed',
  'capability.denied',
  'capability.started',
  'capability.completed',
  'capability.failed',
  'capability.cancelled',
  // Durable executions (packages/security/src/execution): one run of an allowed capability request.
  'execution.requested',
  'execution.queued',
  'execution.preparing',
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.cancel-requested',
  'execution.cancelled',
  'execution.timed-out',
  'execution.recovered',
  'execution.cleanup-started',
  'execution.cleanup-completed',
  // Isolated container backend (Phase 2B).
  'execution.container-preparing',
  'execution.container-created',
  'execution.container-started',
  'execution.container-exited',
  'execution.container-stop-requested',
  'execution.container-terminated',
  'execution.container-removed',
  'execution.container-cleanup-failed',
  // Controlled network egress (Phase 2C): the execution-private gateway and its scope decisions.
  'execution.network-preparing',
  'execution.gateway-started',
  'execution.network-ready',
  'execution.network-summary',
  'execution.network-cleanup-failed',
  // Security Graph and hypothesis reasoning (Phase 4). One concise event per projection/decision.
  'graph.entity-discovered',
  'graph.relationship-added',
  'graph.contradiction-detected',
  'hypothesis.proposed',
  'hypothesis.updated',
  'hypothesis.disproved',
  'reasoning.started',
  'reasoning.action-proposed',
  'reasoning.action-executed',
  'reasoning.blocked',
  'reasoning.completed',
  // Credential/session secret boundary (Phase 5 Step 2). These reference ids only, never secret material.
  'credential.created',
  'credential.replaced',
  'credential.revoked',
  'credential.deleted',
  'session.created',
  'session.revoked',
  'session.expired',
  'session.establishment-started',
  'session.established',
  'session.validation-failed',
  'session.refreshed',
  // Differential authorization / business-logic comparison (Phase 5 Step 4).
  'comparison.planned',
  'comparison.started',
  'comparison.completed',
  'comparison.inconclusive',
  'comparison.blocked',
  'comparison.cleanup',
  'invariant.supported',
  'invariant.contradicted',
] as const
export const SecurityEventType = z.enum(SECURITY_EVENT_TYPES)
export type SecurityEventType = z.infer<typeof SecurityEventType>

export const SecurityEventItem = z.object({
  id: z.number(),
  engagementId: z.string(),
  type: SecurityEventType,
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  actor: SecurityActor,
  executionId: z.string().nullable(),
  capabilityId: z.string().nullable(),
  configVersion: z.number(),
  decision: PolicyDecision.nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
})
export type SecurityEventItem = z.infer<typeof SecurityEventItem>

// ── Evidence provenance ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a piece of security evidence came from. Evidence is only ever recorded by an *allowed*
 * execution; a denial is a security event, never evidence about the target.
 */
export const SecurityEvidenceProvenance = z.object({
  engagementId: z.string(),
  executionId: z.string(),
  correlationId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.number(),
  implementation: z.string(),
  /** Id of the `capability.allowed` event that authorized the execution. */
  decisionEventId: z.number().nullable(),
  environment: SecurityEnvironment,
  scopeVersion: z.number(),
  scopeHash: z.string(),
  configVersion: z.number(),
  policyProfile: z.object({ key: z.string(), version: z.number() }),
  authorizationIds: z.array(z.string()),
  sensitivity: z.enum(['normal', 'sensitive']),
  /** Identity/session the evidence was captured under (Phase 5 Step 3); null for anonymous evidence. */
  identityRef: z.string().nullable().default(null),
  sessionRef: z.string().nullable().default(null),
  /** Values replaced by redaction before the evidence was stored. */
  redactions: z.number(),
  recordedAt: z.string(),
})
export type SecurityEvidenceProvenance = z.infer<typeof SecurityEvidenceProvenance>

export const SecurityEvidenceItem = z.object({
  id: z.string(),
  ref: z.string(),
  engagementId: z.string(),
  source: EvidenceSource,
  type: EvidenceType,
  title: z.string(),
  summary: z.string(),
  url: z.string().nullable(),
  artifactPath: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  provenance: SecurityEvidenceProvenance,
  createdAt: z.string(),
})
export type SecurityEvidenceItem = z.infer<typeof SecurityEvidenceItem>

// ── Engagement views ────────────────────────────────────────────────────────────────────────────────

export const SecurityEngagementSummary = z.object({
  id: z.string(),
  name: z.string(),
  targetUrl: z.string(),
  /** Same site identity as Website Audits (host without "www.", plus non-default port). */
  siteKey: z.string(),
  environment: SecurityEnvironment.nullable(),
  status: EngagementStatus,
  policyProfile: z.object({ key: z.string(), version: z.number(), name: z.string() }),
  readiness: z.object({ ready: z.boolean(), state: ReadinessState, label: z.string() }),
  configVersion: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityEngagementSummary = z.infer<typeof SecurityEngagementSummary>

export const SecurityEngagementDetail = SecurityEngagementSummary.extend({
  description: z.string().nullable(),
  createdBy: z.string(),
  scope: ScopeManifest,
  scopeVersion: z.number(),
  scopeHash: z.string(),
  authorizations: z.array(SecurityAuthorizationItem),
  authorizationMethods: z.array(AuthorizationMethodInfo),
  readiness: EngagementReadiness,
  policy: EffectivePolicy,
  /** Website Audits of the same site. */
  siteAudits: z.object({ count: z.number(), latestAuditId: z.string().nullable() }),
})
export type SecurityEngagementDetail = z.infer<typeof SecurityEngagementDetail>

// ── API input ───────────────────────────────────────────────────────────────────────────────────────

export const CreateEngagementInput = z.strictObject({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  targetUrl: z
    .string()
    .trim()
    .min(1, 'Enter the target URL')
    .refine((value) => normalizeTargetUrl(value).ok, { message: 'Enter a valid http(s) URL' }),
  environment: SecurityEnvironment.optional(),
  policyProfile: PolicyProfileKey.optional(),
  description: z.string().trim().max(2000).optional(),
})
export type CreateEngagementInput = z.infer<typeof CreateEngagementInput>

export const UpdateEngagementInput = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  environment: SecurityEnvironment.optional(),
  policyProfile: PolicyProfileKey.optional(),
})
export type UpdateEngagementInput = z.infer<typeof UpdateEngagementInput>

export const UpdateScopeInput = z.strictObject({
  manifest: z.unknown(),
  /** Optimistic concurrency: rejected when the stored scope has moved on. */
  expectedScopeVersion: z.number().int().positive().optional(),
})

export const ValidateScopeInput = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  /** Evaluate an unsaved manifest instead of the stored one. */
  manifest: z.unknown().optional(),
  resolveDns: z.boolean().default(true),
})

export const ScopeValidationResult = z.object({
  evaluation: ScopeEvaluation,
  /** DNS-aware check of the resolved addresses (null when not resolved or already denied by name). */
  network: ScopeEvaluation.nullable(),
})
export type ScopeValidationResult = z.infer<typeof ScopeValidationResult>

export const RequestAuthorizationInput = z.strictObject({
  method: AuthorizationMethod,
  /** Defaults to the engagement target's host and port. */
  subject: z.unknown().optional(),
})

export const LifecycleInput = z.strictObject({ action: LifecycleAction })
