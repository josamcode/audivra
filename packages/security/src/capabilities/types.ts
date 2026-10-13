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
  SecurityObservation,
  ObservationScopeClass,
  ObservationSourceType,
  ObservationType,
} from '@audivra/contracts'
import type { RunProcessResult } from '@audivra/tool-runtime'
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
  /** Identity-aware execution (Phase 5 Step 3): references only, never secret material. Null when anonymous. */
  identity: { identityRef: string | null; sessionRef: string | null; authMethod: string | null } | null
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

/** A normalized observation a sensor adapter records (provenance and tool version are filled by the platform). */
export interface RecordObservationInput {
  type: ObservationType
  /** The asset it is about (URL / host / file), normalized by the adapter. */
  asset: string
  /** The normalized subject (technology name, header, route, rule id, …). */
  subject: string
  title: string
  /** Scope classification for discovered destinations; null when not applicable. */
  scopeClass?: ObservationScopeClass | null
  value?: Record<string, unknown>
  sourceType?: ObservationSourceType
  confidence?: number
  /** Evidence (`EV-n`) backing it; the raw artifact is reachable through it. */
  evidenceRef?: string | null
  /** Overrides the default `type:asset:subject` dedup key. */
  dedupeKey?: string
}

/** Records normalized observations; deduplicated per engagement, provenance filled by the platform. */
export interface ObservationRecorder {
  record(input: RecordObservationInput): Promise<SecurityObservation>
}

/** Container paths and the gateway proxy a sensor's tool command is given (built by the platform). */
export interface ToolIo {
  /** Container-side paths of the execution's areas. */
  inputs: string
  outputs: string
  artifacts: string
  tmp: string
  /** The execution gateway's proxy URL for a scoped-egress sensor; null for a no-network sensor. */
  egressProxy: string | null
}

/** A process a capability starts through `handles.processes` (always owned by its execution). */
export interface CapabilityProcessOptions {
  command: string
  args?: string[]
  /** Working directory: one of the execution's workspace areas (default `tmp`). */
  cwd?: 'inputs' | 'outputs' | 'artifacts' | 'tmp'
  timeoutMs?: number
  input?: string
  maxBuffer?: number
  /** Stream stdout / stderr into files in the execution's `outputs/` area (relative paths). */
  stdoutFile?: string
  stderrFile?: string
}

export interface CapabilityProcesses {
  run(options: CapabilityProcessOptions): Promise<RunProcessResult>
}

/**
 * This execution's private directory inside the engagement workspace and its areas (absolute paths).
 * `relative()` turns a path inside the execution into the engagement-relative form evidence uses.
 */
export interface CapabilityWorkspace {
  root: string
  dir: string
  inputs: string
  outputs: string
  artifacts: string
  tmp: string
  relative(path: string): string
}

/** Everything an executor may use. There is no other sanctioned way to reach the network or disk. */
export interface CapabilityHandles {
  /** Scope-, DNS- and budget-enforcing HTTP client. */
  http: ScopedHttpClient
  /** Aborted on cancellation or timeout. */
  signal: AbortSignal
  workspace: CapabilityWorkspace
  evidence: EvidenceRecorder
  /** Records normalized observations for a sensor capability (deduplicated, with provenance). */
  observations: ObservationRecorder
  /**
   * Starts a process owned by this execution: registered by PID + creation time, confined to the
   * workspace, counted against the process limit and terminated exactly on cancellation or timeout.
   */
  processes: CapabilityProcesses
  /**
   * Ownership metadata for `runProcess` (tool-runtime): processes started with it are registered by
   * PID + creation time and terminated, exactly, when this execution is cancelled. Prefer `processes`.
   */
  processOwner: { tool: string; securityExecutionId: string }
}

export interface CapabilityResult<O> {
  output: O
  /** One-sentence, user-facing summary for the audit trail. */
  summary: string
}

/** What the isolated backend observed of a finished executor container (bounded). */
export interface ContainerRun {
  exitCode: number
  /** `outputs/result.json` written by the program, parsed (at most 64 KB); null when absent or not JSON. */
  result: unknown
  /** Bounded container output: size, a short redacted tail, and the workspace-relative log file (if any). */
  log: { bytes: number; tail: string; path: string | null }
  durationMs: number
}

/**
 * How a capability is carried out. Kept apart from its policy metadata. Exactly one shape, matching the
 * declared execution mode (checked at registration):
 *
 * - in-process — `execute` runs in the worker with the platform handles;
 * - isolated-container (executor program) — `program` is a reviewed executor shipped with Audivra
 *   (`packages/security/executors/`), run in the approved runtime with only `programInput` staged
 *   read-only; `collect` then runs on the host to validate what the program left in the workspace.
 * - isolated-container (sensor tool) — `toolArgs` builds the exact argument vector for an approved tool,
 *   run in that tool's approved image (its entrypoint); no user- or model-supplied arguments ever reach
 *   it. `collect` parses the tool's structured output into evidence and observations.
 *
 * An isolated capability has no `execute`, so it cannot run in-process at all.
 */
export interface CapabilityImplementation<I = unknown, O = unknown> {
  /** Must equal `metadata.implementation`. */
  id: string
  /** Strict schema for request input: unknown fields are rejected, never ignored. */
  input: z.ZodType<I>
  /** The destinations (absolute URLs) a request targets, derived from validated input; scope-checked before execution. */
  targets(input: I): string[]
  execute?(context: Readonly<SecurityExecutionContext>, input: I, handles: CapabilityHandles): Promise<CapabilityResult<O>>
  /** File name of the executor program in `packages/security/executors/`. */
  program?: string
  /** The minimum the program needs to run — never authorization, scope, policy or credentials. */
  programInput?(context: Readonly<SecurityExecutionContext>, input: I): Record<string, unknown>
  /** Sensor tool: stage any input files the tool reads (under the execution's read-only inputs area). */
  stage?(context: Readonly<SecurityExecutionContext>, input: I, into: { write(relative: string, content: string | Uint8Array): Promise<string> }): Promise<void>
  /** Sensor tool: the exact argument vector for the approved tool, from validated input only. */
  toolArgs?(context: Readonly<SecurityExecutionContext>, input: I, io: ToolIo): string[]
  collect?(context: Readonly<SecurityExecutionContext>, input: I, run: ContainerRun, handles: CapabilityHandles): Promise<CapabilityResult<O>>
}

export interface SecurityCapability<I = unknown, O = unknown> {
  metadata: SecurityCapabilityMetadata
  implementation: CapabilityImplementation<I, O>
}
