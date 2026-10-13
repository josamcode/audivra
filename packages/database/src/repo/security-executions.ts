import { and, asc, count, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import {
  ACTIVE_EXECUTION_STATUSES,
  CANCELLABLE_EXECUTION_STATUSES,
  redact,
  TERMINAL_EXECUTION_STATUSES,
  type ExecutionExit,
  type ExecutionFailure,
  type ExecutionResult,
  type ExecutionRunner,
  type ExecutionStatus,
  type SecurityActor,
  type SecurityEnvironment,
  type SecurityExecutionDetail,
  type SecurityExecutionItem,
  type SecurityExecutionSnapshot,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { QUEUES } from '../queue.ts'
import { evidence, securityExecutions } from '../schema.ts'

/*
 * Persistence for durable security executions. The lifecycle rules live in @audivra/security; this
 * module stores rows and offers *conditional* updates only: every transition names the states it may
 * start from (and, for a running execution, the worker that must own it), so concurrent workers,
 * cancellation requests and recovery can never overwrite each other's decisions.
 */

export type SecurityExecutionRow = typeof securityExecutions.$inferSelect

export interface CreateSecurityExecutionInput {
  id: string
  engagementId: string
  capabilityId: string
  capabilityVersion: number
  environment: SecurityEnvironment
  configVersion: number
  correlationId: string
  requestedBy: SecurityActor
  decisionEventId: number
  snapshot: SecurityExecutionSnapshot
  snapshotHash: string
}

export async function createSecurityExecution(db: Db, input: CreateSecurityExecutionInput): Promise<SecurityExecutionRow> {
  const [row] = await db
    .insert(securityExecutions)
    .values({ ...input, status: 'queued' })
    .returning()
  if (!row) throw new Error('Failed to create security execution')
  return row
}

export async function getSecurityExecutionRow(db: Db, id: string): Promise<SecurityExecutionRow | undefined> {
  const [row] = await db.select().from(securityExecutions).where(eq(securityExecutions.id, id))
  return row
}

export async function listSecurityExecutionRows(db: Db, engagementId: string, limit = 200): Promise<SecurityExecutionRow[]> {
  return db
    .select()
    .from(securityExecutions)
    .where(eq(securityExecutions.engagementId, engagementId))
    .orderBy(desc(securityExecutions.createdAt), desc(securityExecutions.id))
    .limit(limit)
}

/** The execution a caller submitted under a correlation id (the reasoning loop uses its action id), if any. */
export async function findSecurityExecutionByCorrelation(db: Db, engagementId: string, correlationId: string): Promise<SecurityExecutionRow | undefined> {
  const [row] = await db
    .select()
    .from(securityExecutions)
    .where(and(eq(securityExecutions.engagementId, engagementId), eq(securityExecutions.correlationId, correlationId)))
    .limit(1)
  return row
}

/** Executions that are not final (queued or held by a worker), oldest first. */
export async function listUnfinishedSecurityExecutions(db: Db): Promise<SecurityExecutionRow[]> {
  return db
    .select()
    .from(securityExecutions)
    .where(notInArray(securityExecutions.status, [...TERMINAL_EXECUTION_STATUSES]))
    .orderBy(asc(securityExecutions.createdAt))
}

export async function countActiveSecurityExecutions(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(securityExecutions).where(inArray(securityExecutions.status, [...ACTIVE_EXECUTION_STATUSES]))
  return row?.n ?? 0
}

export interface ExecutionPatch {
  status?: ExecutionStatus
  runner?: ExecutionRunner | null
  heartbeatAt?: Date | null
  cancelRequestedAt?: Date | null
  cancelRequestedBy?: SecurityActor | null
  result?: ExecutionResult | null
  exit?: ExecutionExit | null
  failure?: ExecutionFailure | null
  startedAt?: Date | null
  finishedAt?: Date | null
  jobId?: string | null
}

export interface ExecutionGuard {
  /** The update applies only while the execution is in one of these states. */
  from: readonly ExecutionStatus[]
  /** …and, when set, only while this worker instance holds it. */
  ownerId?: string
}

/**
 * Applies a patch only when the guard still holds; returns the updated row or null when the execution
 * has moved on (another worker, a cancellation or recovery got there first).
 */
export async function updateSecurityExecution(db: Db, id: string, guard: ExecutionGuard, patch: ExecutionPatch): Promise<SecurityExecutionRow | null> {
  const values = {
    ...patch,
    ...(patch.result ? { result: redact(patch.result) } : {}),
    ...(patch.exit ? { exit: redact(patch.exit) } : {}),
    ...(patch.failure ? { failure: redact(patch.failure) } : {}),
    updatedAt: new Date(),
  }
  const [row] = await db
    .update(securityExecutions)
    .set(values)
    .where(
      and(
        eq(securityExecutions.id, id),
        inArray(securityExecutions.status, [...guard.from]),
        guard.ownerId !== undefined ? sql`${securityExecutions.runner}->>'ownerId' = ${guard.ownerId}` : undefined,
      ),
    )
    .returning()
  return row ?? null
}

export type ClaimResult =
  | { claimed: true; row: SecurityExecutionRow }
  | { claimed: false; reason: 'missing' | 'not-queued' | 'capacity'; status: ExecutionStatus | null }

/**
 * Moves a queued execution to `preparing` for one worker, provided fewer than `maxActive` executions
 * are active platform-wide. Claims are serialized by a transaction-scoped advisory lock, so the
 * concurrency limit holds across every worker that shares the database.
 */
export async function claimSecurityExecution(db: Db, id: string, runner: ExecutionRunner, maxActive: number): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audivra:security-execution-claim'))`)
    const [current] = await tx.select({ status: securityExecutions.status }).from(securityExecutions).where(eq(securityExecutions.id, id))
    if (!current) return { claimed: false, reason: 'missing', status: null }
    if (current.status !== 'queued') return { claimed: false, reason: 'not-queued', status: current.status }
    const [active] = await tx.select({ n: count() }).from(securityExecutions).where(inArray(securityExecutions.status, [...ACTIVE_EXECUTION_STATUSES]))
    if ((active?.n ?? 0) >= maxActive) return { claimed: false, reason: 'capacity', status: current.status }
    const now = new Date()
    const [row] = await tx
      .update(securityExecutions)
      .set({ status: 'preparing', runner, heartbeatAt: now, startedAt: now, updatedAt: now })
      .where(and(eq(securityExecutions.id, id), eq(securityExecutions.status, 'queued')))
      .returning()
    return row ? { claimed: true, row } : { claimed: false, reason: 'not-queued', status: current.status }
  })
}

/** Liveness signal of the worker holding an execution. */
export async function heartbeatSecurityExecution(db: Db, id: string, ownerId: string): Promise<boolean> {
  const rows = await db
    .update(securityExecutions)
    .set({ heartbeatAt: new Date() })
    .where(
      and(
        eq(securityExecutions.id, id),
        inArray(securityExecutions.status, [...ACTIVE_EXECUTION_STATUSES]),
        sql`${securityExecutions.runner}->>'ownerId' = ${ownerId}`,
      ),
    )
    .returning({ id: securityExecutions.id })
  return rows.length > 0
}

/** Records the pg-boss job of a (still unfinished) execution. */
export async function setSecurityExecutionJob(db: Db, id: string, jobId: string): Promise<void> {
  await db
    .update(securityExecutions)
    .set({ jobId })
    .where(and(eq(securityExecutions.id, id), notInArray(securityExecutions.status, [...TERMINAL_EXECUTION_STATUSES])))
}

/** Whether a pg-boss job for the execution is queued, waiting to retry or active. */
export async function hasPendingSecurityExecutionJob(db: Db, executionId: string): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 from pgboss.job where name = ${QUEUES.securityExecution} and singleton_key = ${executionId} and state in ('created', 'retry', 'active') limit 1`,
  )
  return result.rows.length > 0
}

/** Evidence an execution already registered for one artifact (keeps artifact registration idempotent). */
export async function findExecutionArtifactEvidence(db: Db, executionId: string, artifactPath: string): Promise<string | null> {
  const [row] = await db
    .select({ ref: evidence.ref })
    .from(evidence)
    .where(and(eq(evidence.securityExecutionId, executionId), eq(evidence.artifactPath, artifactPath)))
    .limit(1)
  return row?.ref ?? null
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────────

const ACTIVE = new Set<string>(ACTIVE_EXECUTION_STATUSES)
const CANCELLABLE = new Set<string>(CANCELLABLE_EXECUTION_STATUSES)

export function toSecurityExecutionItem(row: SecurityExecutionRow, now = new Date()): SecurityExecutionItem {
  const end = row.finishedAt ?? (ACTIVE.has(row.status) ? now : null)
  return {
    id: row.id,
    engagementId: row.engagementId,
    capabilityId: row.capabilityId,
    capabilityVersion: row.capabilityVersion,
    capabilityName: row.snapshot.capability.name,
    status: row.status,
    environment: row.environment,
    configVersion: row.configVersion,
    correlationId: row.correlationId,
    requestedBy: row.requestedBy,
    failure: row.failure ?? null,
    exit: row.exit ?? null,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    durationMs: row.startedAt && end ? Math.max(0, end.getTime() - row.startedAt.getTime()) : null,
  }
}

export function toSecurityExecutionDetail(row: SecurityExecutionRow, now = new Date()): SecurityExecutionDetail {
  const { snapshot } = row
  return {
    ...toSecurityExecutionItem(row, now),
    snapshotHash: row.snapshotHash,
    trusted: {
      decisionEventId: row.decisionEventId,
      scopeVersion: snapshot.scope.version,
      scopeHash: snapshot.scope.hash,
      policyProfile: { key: snapshot.policy.profileKey, version: snapshot.policy.profileVersion },
      authorizationIds: snapshot.authorization.authorizationIds,
      allowedTargets: snapshot.allowedTargets,
      limits: snapshot.limits,
      runtime: snapshot.runtime,
      isolation: {
        mode: snapshot.isolation?.mode ?? 'in-process',
        runtimeId: snapshot.isolation?.runtime?.id ?? null,
        runtimeVersion: snapshot.isolation?.runtime?.version ?? null,
        network: snapshot.isolation?.network ?? 'scoped-client',
        container: snapshot.isolation?.container ?? null,
      },
    },
    runner: row.runner ?? null,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    result: row.result ? { summary: row.result.summary, output: row.result.output } : null,
    workspacePath: `executions/${row.id}`,
    cancellable: CANCELLABLE.has(row.status),
  }
}
