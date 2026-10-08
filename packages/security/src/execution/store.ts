import {
  claimSecurityExecution,
  createSecurityExecution,
  enqueueSecurityExecution,
  getSecurityExecutionRow,
  hasPendingSecurityExecutionJob,
  heartbeatSecurityExecution,
  listSecurityExecutionRows,
  listUnfinishedSecurityExecutions,
  setSecurityExecutionJob,
  updateSecurityExecution,
  type ClaimResult,
  type CreateSecurityExecutionInput,
  type Db,
  type ExecutionGuard,
  type ExecutionPatch,
  type PgBoss,
  type SecurityExecutionRow,
} from '@audivra/database'
import type { ExecutionRunner } from '@audivra/contracts'

/** A persisted execution (the PostgreSQL row shape; the in-memory test store uses the same shape). */
export type ExecutionRecord = SecurityExecutionRow

/** Persistence port of the execution runtime. Every state change is a guarded, conditional update. */
export interface ExecutionStore {
  create(input: CreateSecurityExecutionInput): Promise<ExecutionRecord>
  get(id: string): Promise<ExecutionRecord | null>
  listForEngagement(engagementId: string): Promise<ExecutionRecord[]>
  /** Queued executions and executions held by a worker. */
  listUnfinished(): Promise<ExecutionRecord[]>
  claim(id: string, runner: ExecutionRunner, maxActive: number): Promise<ClaimResult>
  update(id: string, guard: ExecutionGuard, patch: ExecutionPatch): Promise<ExecutionRecord | null>
  heartbeat(id: string, ownerId: string): Promise<boolean>
  setJob(id: string, jobId: string): Promise<void>
  hasPendingJob(id: string): Promise<boolean>
}

/** Hands an accepted execution to the durable queue. Returns the job id, or null when one already exists. */
export interface ExecutionQueue {
  enqueue(executionId: string, jobId?: string): Promise<string | null>
}

export function createDbExecutionStore(db: Db): ExecutionStore {
  return {
    create: (input) => createSecurityExecution(db, input),
    get: async (id) => (await getSecurityExecutionRow(db, id)) ?? null,
    listForEngagement: (engagementId) => listSecurityExecutionRows(db, engagementId),
    listUnfinished: () => listUnfinishedSecurityExecutions(db),
    claim: (id, runner, maxActive) => claimSecurityExecution(db, id, runner, maxActive),
    update: (id, guard, patch) => updateSecurityExecution(db, id, guard, patch),
    heartbeat: (id, ownerId) => heartbeatSecurityExecution(db, id, ownerId),
    setJob: (id, jobId) => setSecurityExecutionJob(db, id, jobId),
    hasPendingJob: (id) => hasPendingSecurityExecutionJob(db, id),
  }
}

export function createBossExecutionQueue(boss: PgBoss): ExecutionQueue {
  return { enqueue: (executionId, jobId) => enqueueSecurityExecution(boss, executionId, jobId) }
}
