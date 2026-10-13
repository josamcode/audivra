import { z } from 'zod'
import { EvidenceType } from './enums.ts'
import { MutationClass, RiskClass, SecurityEnvironment } from './security-classes.ts'
import { ExecutionLimits, ScopeManifest } from './security-scope.ts'
import { AuthorizationDecisionState, EffectivePermission, EngagementStatus, ExecutionMode, NetworkProfile, SecurityActor } from './security.ts'

/*
 * Security executions: one durable run of one capability, accepted by the capability broker and carried
 * out by the worker. An execution is created only from an *allowed* decision and carries an immutable
 * snapshot of the trusted configuration it was approved under; the worker runs from that snapshot and
 * never from the engagement's current configuration or from anything a request or model supplies.
 *
 * Execution state is separate from engagement state: an engagement's lifecycle is a label for people,
 * an execution's status describes one run.
 */

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────────────────

export const EXECUTION_STATUSES = [
  'queued',
  'preparing',
  'running',
  'finalizing',
  'cancelling',
  'succeeded',
  'failed',
  'timed-out',
  'cancelled',
  'interrupted',
] as const
export const ExecutionStatus = z.enum(EXECUTION_STATUSES)
export type ExecutionStatus = z.infer<typeof ExecutionStatus>

/** Final states. A terminal execution never changes again (also enforced by a database trigger). */
export const TERMINAL_EXECUTION_STATUSES = ['succeeded', 'failed', 'timed-out', 'cancelled', 'interrupted'] as const satisfies readonly ExecutionStatus[]

/** States in which a worker holds the execution (and one slot of the execution concurrency limit). */
export const ACTIVE_EXECUTION_STATUSES = ['preparing', 'running', 'finalizing', 'cancelling'] as const satisfies readonly ExecutionStatus[]

/**
 * Every allowed transition. `finalizing` means the work ended (succeeded, failed or timed out) and the
 * runtime is stopping owned resources, registering artifacts and cleaning up; `cancelling` means a
 * cancellation was requested and the runtime is stopping the work.
 */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'finalizing', 'cancelling', 'failed', 'interrupted'],
  running: ['finalizing', 'cancelling', 'failed', 'interrupted'],
  finalizing: ['succeeded', 'failed', 'timed-out', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  succeeded: [],
  failed: [],
  'timed-out': [],
  cancelled: [],
  interrupted: [],
}

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return (TERMINAL_EXECUTION_STATUSES as readonly ExecutionStatus[]).includes(status)
}

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to)
}

/** States a transition to `to` may start from (used for conditional, race-safe updates). */
export function executionSourcesFor(to: ExecutionStatus): ExecutionStatus[] {
  return EXECUTION_STATUSES.filter((from) => EXECUTION_TRANSITIONS[from].includes(to))
}

/** Statuses in which a cancellation request is accepted (later ones are already stopping or final). */
export const CANCELLABLE_EXECUTION_STATUSES = ['queued', 'preparing', 'running'] as const satisfies readonly ExecutionStatus[]

// ── Failure classification ──────────────────────────────────────────────────────────────────────────

/**
 * Why an execution did not succeed. Extensible: later isolation backends add their own kinds (for
 * example sandbox or egress failures) without changing the existing ones.
 */
export const EXECUTION_FAILURE_KINDS = [
  /** Refused before anything ran: snapshot, capability, revalidation or resource checks. */
  'preflight-failed',
  /** The capability implementation reported an error. */
  'executor-failed',
  /** The wall-clock limit was reached; Audivra stopped the work. */
  'timeout',
  /** Cancelled by a person or by Audivra (e.g. the engagement was paused). */
  'cancelled',
  /** The execution exceeded its artifact budget or produced an invalid artifact. */
  'artifact-limit',
  /** The execution tried to start more processes than its limit allows. */
  'process-limit',
  /** The worker stopped while the execution was in progress. */
  'worker-interrupted',
  /** Owned resources could not be stopped or the workspace could not be cleaned. */
  'cleanup-failed',
  /** An unexpected platform error. */
  'internal',
  /** The backend the execution requires is not available (no container runtime, approved image missing). */
  'runtime-unavailable',
  /** The isolated runtime could not prepare, start or observe the execution's container. */
  'runtime-failed',
  /** The executor exceeded a resource limit enforced at its boundary (e.g. the container's memory). */
  'resource-limit',
  /** The execution-private network or its gateway could not be set up. */
  'network-setup-failed',
  /** The execution's network gateway did not become ready. */
  'gateway-unavailable',
  /** Execution-owned network resources could not be removed. */
  'network-cleanup-failed',
] as const
export const ExecutionFailureKind = z.enum(EXECUTION_FAILURE_KINDS)
export type ExecutionFailureKind = z.infer<typeof ExecutionFailureKind>

export const ExecutionFailure = z.object({
  kind: ExecutionFailureKind,
  /** Stable rule id, e.g. `execution.config-changed`, `runtime.timeout`, `artifact.budget-exceeded`. */
  rule: z.string(),
  message: z.string(),
})
export type ExecutionFailure = z.infer<typeof ExecutionFailure>

/** The failure kind every non-successful terminal status implies (`failed` carries its own). */
export const FAILURE_KIND_FOR_STATUS: Partial<Record<ExecutionStatus, ExecutionFailureKind>> = {
  'timed-out': 'timeout',
  cancelled: 'cancelled',
  interrupted: 'worker-interrupted',
}

// ── Trusted snapshot ────────────────────────────────────────────────────────────────────────────────

export const EXECUTION_SNAPSHOT_VERSION = 1

/**
 * Runtime limits derived from the effective limits and the capability's declared resource profile at
 * decision time. Not a second limits model: every value comes from `limits` or registered metadata.
 */
export const ExecutionRuntimeLimits = z.strictObject({
  /** Wall-clock limit enforced by the runtime (`limits.executionTimeoutSeconds`). */
  timeoutSeconds: z.number().int().positive(),
  /** Bytes the execution's artifacts may occupy (`limits.maxArtifactMb`). */
  maxArtifactBytes: z.number().int().positive(),
  /** Processes the execution may start (0 when the capability declares it spawns none). */
  maxProcesses: z.number().int().min(0),
  /** How long a stop request may take before owned resources are terminated. */
  cancelGraceSeconds: z.number().int().positive(),
})
export type ExecutionRuntimeLimits = z.infer<typeof ExecutionRuntimeLimits>

/** Limits applied at the container boundary (from the approved runtime's versioned profile). */
export const ContainerLimits = z.strictObject({
  memoryMb: z.number().int().positive(),
  cpus: z.number().positive(),
  pidsLimit: z.number().int().positive(),
  tmpfsMb: z.number().int().positive(),
})
export type ContainerLimits = z.infer<typeof ContainerLimits>

/**
 * How an execution is isolated, fixed at decision time from the capability's declared execution mode and
 * Audivra's approved runtime registry. The worker picks the backend from this and never falls back.
 */
export const ExecutionIsolation = z.strictObject({
  mode: ExecutionMode,
  /** The approved runtime and the exact image (pinned by digest) the decision approved; null in-process. */
  runtime: z.strictObject({ id: z.string(), version: z.number().int(), image: z.string() }).nullable(),
  /**
   * How the execution reaches the network. `none`: no network. `scoped-client`: in-process code via the
   * scoped HTTP client. `scoped-egress`: an isolated container whose only route is an Audivra-controlled,
   * execution-private gateway enforcing the trusted scope.
   */
  network: z.enum(['scoped-client', 'none', 'scoped-egress']),
  container: ContainerLimits.nullable(),
})
export type ExecutionIsolation = z.infer<typeof ExecutionIsolation>

/** Concise, policy-level record of what the execution's network gateway decided (never packet capture). */
export const NetworkDecisions = z.object({
  requested: z.number().int(),
  allowed: z.number().int(),
  denied: z.number().int(),
  /** Count of denials by the rule that denied them (bounded). */
  byReason: z.record(z.string(), z.number().int()),
})
export type NetworkDecisions = z.infer<typeof NetworkDecisions>

/** What the runtime observed of an execution's private network and gateway. */
export const NetworkFacts = z.object({
  profile: NetworkProfile,
  gateway: z.object({ name: z.string(), ready: z.boolean(), removed: z.boolean() }).nullable(),
  /** Execution-private networks by role (internal / egress). */
  networks: z.array(z.object({ name: z.string(), role: z.string(), removed: z.boolean() })),
  decisions: NetworkDecisions.nullable(),
})
export type NetworkFacts = z.infer<typeof NetworkFacts>

/**
 * The trusted configuration an execution was accepted under, persisted once and never changed. The
 * worker builds the execution context from this snapshot only; its hash is stored next to it and
 * verified before every run.
 */
export const SecurityExecutionSnapshot = z.strictObject({
  schemaVersion: z.literal(EXECUTION_SNAPSHOT_VERSION),
  executionId: z.string(),
  correlationId: z.string(),
  engagement: z.strictObject({ id: z.string(), configVersion: z.number().int(), status: EngagementStatus }),
  environment: SecurityEnvironment,
  authorization: z.strictObject({ required: z.boolean(), state: AuthorizationDecisionState, authorizationIds: z.array(z.string()) }),
  scope: z.strictObject({ version: z.number().int(), hash: z.string(), manifest: ScopeManifest }),
  policy: z.strictObject({ profileKey: z.string(), profileVersion: z.number().int(), risk: EffectivePermission, mutation: EffectivePermission }),
  capability: z.strictObject({
    id: z.string(),
    version: z.number().int(),
    implementation: z.string(),
    name: z.string(),
    riskClass: RiskClass,
    sideEffect: MutationClass,
    supportsCancellation: z.boolean(),
    evidenceTypes: z.array(EvidenceType),
  }),
  limits: ExecutionLimits,
  runtime: ExecutionRuntimeLimits,
  /** Execution mode and isolation (absent in snapshots written before Phase 2B: in-process). */
  isolation: ExecutionIsolation.optional(),
  /**
   * Identity-aware execution (Phase 5 Step 3): references only — the runtime resolves the secret material
   * behind them at the trusted boundary. NEVER decrypted credential/session material. Absent = anonymous.
   */
  identity: z.strictObject({ identityRef: z.string().nullable(), sessionRef: z.string().nullable(), authMethod: z.string().nullable() }).optional(),
  /** Capability input exactly as validated by the capability's strict schema at decision time. */
  input: z.unknown(),
  /** Destinations the decision allowed (canonical URLs). */
  allowedTargets: z.array(z.string()),
  actor: SecurityActor,
  /** The persisted `capability.allowed` event that authorized this execution. */
  decision: z.strictObject({ eventId: z.number().int(), rule: z.string(), evaluatedAt: z.string() }),
})
export type SecurityExecutionSnapshot = z.infer<typeof SecurityExecutionSnapshot>

// ── Runner identity, results and exit information ───────────────────────────────────────────────────

/** The worker process that holds an execution (used to tell a live owner from a crashed one). */
export const ExecutionRunner = z.object({
  ownerId: z.string(),
  host: z.string(),
  pid: z.number().int(),
  /** OS creation time of the worker process (defeats PID reuse when checking liveness). */
  processStartedAt: z.string().nullable(),
  backend: z.string(),
})
export type ExecutionRunner = z.infer<typeof ExecutionRunner>

export const ExecutionOutcome = z.enum(['succeeded', 'failed', 'timeout', 'cancelled'])
export type ExecutionOutcome = z.infer<typeof ExecutionOutcome>

/**
 * What the backend reported when the work ended, persisted on entering `finalizing`/`cancelling` so a
 * restarted worker can finish an execution whose work had already completed.
 */
export const ExecutionResult = z.object({
  outcome: ExecutionOutcome,
  summary: z.string().nullable(),
  /** Compact capability output (large outputs are replaced by their size). */
  output: z.unknown(),
  failure: ExecutionFailure.nullable(),
  /** Evidence the execution registered while it ran. */
  evidenceRefs: z.array(z.string()),
  artifactBytes: z.number().int(),
  processesStarted: z.number().int(),
  endedAt: z.string(),
})
export type ExecutionResult = z.infer<typeof ExecutionResult>

/** What the isolated backend observed of the execution's container. */
export const ContainerFacts = z.object({
  name: z.string(),
  exitCode: z.number().int().nullable(),
  oomKilled: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** The container was removed by Audivra's cleanup. */
  removed: z.boolean(),
})
export type ContainerFacts = z.infer<typeof ContainerFacts>

export const ExecutionExit = z.object({
  outcome: z.enum(['succeeded', 'failed', 'timeout', 'cancelled', 'interrupted']),
  /** Exit code for process-based backends; null for the in-process backend. */
  code: z.number().int().nullable(),
  summary: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  processes: z.object({ started: z.number().int(), terminated: z.number().int(), reaped: z.number().int() }),
  artifacts: z.object({ registered: z.number().int(), bytes: z.number().int() }),
  /** True when the runtime stopped waiting for code that ignored the stop request (in-process backend). */
  abandoned: z.boolean(),
  /** The backend that carried the execution out and, for an isolated one, its container and network. */
  runtime: z.object({ backend: ExecutionMode, container: ContainerFacts.nullable(), network: NetworkFacts.nullable() }).optional(),
})
export type ExecutionExit = z.infer<typeof ExecutionExit>

// ── API views ───────────────────────────────────────────────────────────────────────────────────────

export const SecurityExecutionItem = z.object({
  id: z.string(),
  engagementId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.number(),
  capabilityName: z.string(),
  status: ExecutionStatus,
  environment: SecurityEnvironment,
  configVersion: z.number(),
  correlationId: z.string(),
  requestedBy: SecurityActor,
  failure: ExecutionFailure.nullable(),
  exit: ExecutionExit.nullable(),
  cancelRequestedAt: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
  /** Wall-clock duration from start to finish (or to now while active), in milliseconds. */
  durationMs: z.number().nullable(),
})
export type SecurityExecutionItem = z.infer<typeof SecurityExecutionItem>

export const SecurityExecutionDetail = SecurityExecutionItem.extend({
  snapshotHash: z.string(),
  /** The trusted configuration without the capability input (inputs may contain target data). */
  trusted: z.object({
    decisionEventId: z.number(),
    scopeVersion: z.number(),
    scopeHash: z.string(),
    policyProfile: z.object({ key: z.string(), version: z.number() }),
    authorizationIds: z.array(z.string()),
    allowedTargets: z.array(z.string()),
    limits: ExecutionLimits,
    runtime: ExecutionRuntimeLimits,
    isolation: z.object({
      mode: ExecutionMode,
      runtimeId: z.string().nullable(),
      runtimeVersion: z.number().nullable(),
      network: z.enum(['scoped-client', 'none', 'scoped-egress']),
      container: ContainerLimits.nullable(),
    }),
  }),
  runner: ExecutionRunner.nullable(),
  heartbeatAt: z.string().nullable(),
  result: z.object({ summary: z.string().nullable(), output: z.unknown() }).nullable(),
  /** Workspace of the execution, relative to the engagement workspace. */
  workspacePath: z.string(),
  cancellable: z.boolean(),
})
export type SecurityExecutionDetail = z.infer<typeof SecurityExecutionDetail>
