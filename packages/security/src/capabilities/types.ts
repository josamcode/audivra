import type { z } from 'zod'
import type {
  EffectivePermission,
  EvidenceType,
  ExecutionLimits,
  MutationClass,
  RiskClass,
  ScopeManifest,
  SecurityActor,
  SecurityCapabilityMetadata,
  SecurityEnvironment,
  SecurityEvidenceItem,
} from '@audivra/contracts'
import type { ScopedHttpClient } from '../http-client.ts'

/**
 * Trusted execution context: built by the broker from persisted engagement data only, then deeply
 * frozen. Nothing from the request input, the target or a model reaches these fields, and an executor
 * cannot change them.
 */
export interface SecurityExecutionContext {
  executionId: string
  correlationId: string
  engagementId: string
  configVersion: number
  environment: SecurityEnvironment
  authorization: { required: boolean; state: string; authorizationIds: string[] }
  scope: { version: number; hash: string; manifest: ScopeManifest }
  policy: { profileKey: string; profileVersion: number; risk: EffectivePermission; mutation: EffectivePermission }
  capability: { id: string; version: number; implementation: string; riskClass: RiskClass; sideEffect: MutationClass }
  limits: ExecutionLimits
  actor: SecurityActor
  /** Destinations the decision allowed (canonical URLs). */
  allowedTargets: string[]
  requestedAt: string
}

export interface RecordEvidenceInput {
  type: EvidenceType
  title: string
  summary: string
  url?: string | null
  /** Path relative to the engagement workspace. */
  artifactPath?: string | null
  metadata?: Record<string, unknown>
  sensitivity?: 'normal' | 'sensitive'
}

/** Records evidence for the running execution; provenance is filled in by the broker, not the executor. */
export interface EvidenceRecorder {
  record(input: RecordEvidenceInput): Promise<SecurityEvidenceItem>
}

/** Everything an executor may use. There is no other sanctioned way to reach the network or disk. */
export interface CapabilityHandles {
  /** Scope-, DNS- and budget-enforcing HTTP client. */
  http: ScopedHttpClient
  /** Aborted on cancellation or timeout. */
  signal: AbortSignal
  /** This execution's private directory inside the engagement workspace. */
  workspace: { root: string; dir: string; relative(path: string): string }
  evidence: EvidenceRecorder
  /**
   * Ownership metadata for `runProcess` (tool-runtime): processes started with it are registered by
   * PID + creation time and terminated, exactly, when this execution is cancelled.
   */
  processOwner: { tool: string; securityExecutionId: string }
}

export interface CapabilityResult<O> {
  output: O
  /** One-sentence, user-facing summary for the audit trail. */
  summary: string
}

/** How a capability is carried out. Kept apart from its policy metadata. */
export interface CapabilityImplementation<I = unknown, O = unknown> {
  /** Must equal `metadata.implementation`. */
  id: string
  /** Strict schema for request input: unknown fields are rejected, never ignored. */
  input: z.ZodType<I>
  /** The destinations (absolute URLs) a request targets, derived from validated input; scope-checked before execution. */
  targets(input: I): string[]
  execute(context: Readonly<SecurityExecutionContext>, input: I, handles: CapabilityHandles): Promise<CapabilityResult<O>>
}

export interface SecurityCapability<I = unknown, O = unknown> {
  metadata: SecurityCapabilityMetadata
  implementation: CapabilityImplementation<I, O>
}
