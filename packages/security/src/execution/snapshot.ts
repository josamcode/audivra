import {
  EXECUTION_SNAPSHOT_VERSION,
  SecurityExecutionSnapshot,
  type ExecutionLimits,
  type ExecutionRuntimeLimits,
  type PolicyDecision,
  type SecurityActor,
  type SecurityAuthorizationItem,
  type SecurityCapabilityMetadata,
} from '@audivra/contracts'
import { canonicalHash } from '../canonical.ts'
import type { SecurityExecutionContext } from '../capabilities/types.ts'
import { deepFreeze } from '../freeze.ts'
import type { CapabilityPolicyResult } from '../policy.ts'
import type { EngagementSnapshot } from '../store.ts'
import { ExecutionError } from './failures.ts'

/*
 * The trusted execution snapshot: everything an execution may rely on, captured from persisted
 * engagement data and the allowing decision at the moment the broker accepted it.
 *
 *   engagement policy → decision → snapshot (persisted, hashed, immutable) → context → runtime
 *
 * The worker never reads the engagement's current configuration to decide what an execution may do;
 * it only checks that the authority the snapshot was granted under has not been withdrawn since.
 */

/** Processes an execution may start when its capability declares that it spawns any. */
export const RUNTIME_MAX_PROCESSES = 4
/** How long a stop request may take before the runtime terminates owned resources. */
export const RUNTIME_CANCEL_GRACE_SECONDS = 5

/** Runtime limits derived from the effective limits and the registered capability metadata. */
export function runtimeLimitsFor(limits: ExecutionLimits, capability: SecurityCapabilityMetadata): ExecutionRuntimeLimits {
  return {
    timeoutSeconds: Math.min(limits.executionTimeoutSeconds, capability.timeoutProfile.maxSeconds),
    maxArtifactBytes: limits.maxArtifactMb * 1_048_576,
    maxProcesses: capability.resourceProfile.spawnsProcesses ? RUNTIME_MAX_PROCESSES : 0,
    cancelGraceSeconds: RUNTIME_CANCEL_GRACE_SECONDS,
  }
}

export interface SnapshotInput {
  executionId: string
  correlationId: string
  engagement: EngagementSnapshot
  decision: PolicyDecision
  decisionEventId: number
  capability: SecurityCapabilityMetadata
  policy: CapabilityPolicyResult
  /** Input as validated by the capability's strict schema. */
  input: unknown
  actor: SecurityActor
}

export function buildExecutionSnapshot(input: SnapshotInput): SecurityExecutionSnapshot {
  const { engagement, decision, capability, policy } = input
  if (decision.decision !== 'allow' || !engagement.environment) throw new Error('Only an allowed decision can produce an execution snapshot')
  const snapshot = SecurityExecutionSnapshot.parse({
    schemaVersion: EXECUTION_SNAPSHOT_VERSION,
    executionId: input.executionId,
    correlationId: input.correlationId,
    engagement: { id: engagement.id, configVersion: engagement.configVersion, status: engagement.status },
    environment: engagement.environment,
    authorization: {
      required: decision.authorization.required,
      state: decision.authorization.state,
      authorizationIds: [...decision.authorization.authorizationIds],
    },
    scope: { version: engagement.scopeVersion, hash: engagement.scopeHash, manifest: structuredClone(engagement.scope) },
    policy: { profileKey: engagement.policyProfileKey, profileVersion: engagement.policyProfileVersion, risk: policy.risk, mutation: policy.mutation },
    capability: {
      id: capability.id,
      version: capability.version,
      implementation: capability.implementation,
      name: capability.name,
      riskClass: capability.riskClass,
      sideEffect: capability.sideEffect,
      supportsCancellation: capability.supportsCancellation,
      evidenceTypes: [...capability.evidenceTypes],
    },
    limits: { ...policy.limits },
    runtime: runtimeLimitsFor(policy.limits, capability),
    input: structuredClone(input.input),
    allowedTargets: decision.scope!.evaluations.filter((e) => e.kind !== 'network').map((e) => e.destination.url!),
    actor: { ...input.actor },
    decision: { eventId: input.decisionEventId, rule: decision.rule, evaluatedAt: decision.evaluatedAt },
  })
  // Plain JSON only, so the hash is identical before and after the database round trip.
  return JSON.parse(JSON.stringify(snapshot)) as SecurityExecutionSnapshot
}

export function snapshotHash(snapshot: unknown): string {
  return canonicalHash(snapshot)
}

/** The persisted identity of an execution the snapshot must agree with. */
export interface StoredExecutionIdentity {
  id: string
  engagementId: string
  capabilityId: string
  capabilityVersion: number
  environment: string
  configVersion: number
  decisionEventId: number
  snapshot: unknown
  snapshotHash: string
}

/**
 * Loads a stored snapshot for execution: the hash must match the stored content, the content must
 * match the schema, and it must agree with the execution row it belongs to. Anything else refuses the
 * execution before it starts.
 */
export function verifyStoredSnapshot(row: StoredExecutionIdentity): SecurityExecutionSnapshot {
  const invalid = (reason: string) => new ExecutionError('preflight-failed', 'execution.snapshot-invalid', `The stored execution snapshot cannot be trusted: ${reason}`)
  if (snapshotHash(row.snapshot) !== row.snapshotHash) throw invalid('its content does not match its hash')
  const parsed = SecurityExecutionSnapshot.safeParse(row.snapshot)
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'schema mismatch')
  const s = parsed.data
  const mismatch =
    s.executionId !== row.id
      ? 'execution id'
      : s.engagement.id !== row.engagementId
        ? 'engagement'
        : s.capability.id !== row.capabilityId || s.capability.version !== row.capabilityVersion
          ? 'capability'
          : s.environment !== row.environment
            ? 'environment'
            : s.engagement.configVersion !== row.configVersion
              ? 'configuration version'
              : s.decision.eventId !== row.decisionEventId
                ? 'decision'
                : null
  if (mismatch) throw invalid(`its ${mismatch} differs from the execution record`)
  return s
}

/** The frozen context handed to the executor, built from the snapshot only. */
export function contextFromSnapshot(s: SecurityExecutionSnapshot): Readonly<SecurityExecutionContext> {
  return deepFreeze({
    executionId: s.executionId,
    correlationId: s.correlationId,
    engagementId: s.engagement.id,
    configVersion: s.engagement.configVersion,
    environment: s.environment,
    authorization: { required: s.authorization.required, state: s.authorization.state, authorizationIds: [...s.authorization.authorizationIds] },
    scope: { version: s.scope.version, hash: s.scope.hash, manifest: structuredClone(s.scope.manifest) },
    policy: { profileKey: s.policy.profileKey, profileVersion: s.policy.profileVersion, risk: s.policy.risk, mutation: s.policy.mutation },
    capability: { id: s.capability.id, version: s.capability.version, implementation: s.capability.implementation, riskClass: s.capability.riskClass, sideEffect: s.capability.sideEffect },
    limits: { ...s.limits },
    actor: { ...s.actor },
    allowedTargets: [...s.allowedTargets],
    requestedAt: s.decision.evaluatedAt,
  })
}

const NOT_RUNNABLE = new Set(['paused', 'completed', 'cancelled', 'invalid'])

/**
 * Start-time check that the authority an execution was approved under still stands. It never widens
 * anything and never substitutes current configuration for the snapshot — it can only refuse:
 *
 * - the engagement still exists and is not paused, closed or invalid;
 * - its configuration version is the one the decision was made against (any change to environment,
 *   policy, scope, authorization or lifecycle means the approval is stale: request again);
 * - every authorization the decision relied on is still verified and unexpired;
 * - the snapshot's testing window (if any) is open now.
 */
export function revalidateSnapshot(
  s: SecurityExecutionSnapshot,
  current: { engagement: EngagementSnapshot; authorizations: SecurityAuthorizationItem[] } | null,
  now: Date,
): ExecutionError | null {
  const refuse = (rule: string, message: string) => new ExecutionError('preflight-failed', rule, message)
  if (!current) return refuse('execution.engagement-missing', 'The engagement no longer exists')
  const { engagement, authorizations } = current
  if (NOT_RUNNABLE.has(engagement.status)) return refuse('execution.engagement-not-runnable', `The engagement is ${engagement.status}`)
  if (engagement.configVersion !== s.engagement.configVersion) {
    return refuse(
      'execution.config-changed',
      `The engagement configuration changed after this execution was approved (v${s.engagement.configVersion} → v${engagement.configVersion}); request it again`,
    )
  }
  for (const id of s.authorization.authorizationIds) {
    const authorization = authorizations.find((a) => a.id === id)
    if (!authorization || authorization.effectiveStatus !== 'verified') {
      return refuse('execution.authorization-withdrawn', `Authorization ${id} is ${authorization?.effectiveStatus ?? 'missing'}`)
    }
  }
  const window = s.scope.manifest.testingWindow
  if (window && (now.getTime() < Date.parse(window.startsAt) || now.getTime() >= Date.parse(window.endsAt))) {
    return refuse('execution.outside-window', `Outside the testing window (${window.startsAt} – ${window.endsAt})`)
  }
  return null
}
