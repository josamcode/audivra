import { ACTIVE_EXECUTION_STATUSES, canTransitionExecution, isTerminalExecutionStatus, type ExecutionRunner } from '@audivra/contracts'
import type { ClaimResult, CreateSecurityExecutionInput, ExecutionGuard, ExecutionPatch } from '@audivra/database'
import type { ExecutionQueue, ExecutionRecord, ExecutionStore } from '../src/index.ts'

/**
 * In-memory ExecutionStore for unit tests. It enforces what PostgreSQL enforces for the real store —
 * guarded updates, the immutable snapshot and identity, frozen terminal rows — and additionally fails
 * on any status change the lifecycle does not allow, so runtime bugs surface as test failures.
 */
export class MemoryExecutionStore implements ExecutionStore {
  readonly rows = new Map<string, ExecutionRecord>()
  readonly jobs = new Set<string>()
  readonly transitions: { id: string; from: string; to: string }[] = []

  async create(input: CreateSecurityExecutionInput): Promise<ExecutionRecord> {
    const now = new Date()
    const row: ExecutionRecord = {
      ...input,
      status: 'queued',
      jobId: null,
      runner: null,
      heartbeatAt: null,
      cancelRequestedAt: null,
      cancelRequestedBy: null,
      result: null,
      exit: null,
      failure: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    }
    this.rows.set(row.id, structuredClone(row))
    return structuredClone(row)
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const row = this.rows.get(id)
    return row ? structuredClone(row) : null
  }

  async listForEngagement(engagementId: string): Promise<ExecutionRecord[]> {
    return [...this.rows.values()].filter((r) => r.engagementId === engagementId).map((r) => structuredClone(r))
  }

  async listUnfinished(): Promise<ExecutionRecord[]> {
    return [...this.rows.values()].filter((r) => !isTerminalExecutionStatus(r.status)).map((r) => structuredClone(r))
  }

  async claim(id: string, runner: ExecutionRunner, maxActive: number): Promise<ClaimResult> {
    const row = this.rows.get(id)
    if (!row) return { claimed: false, reason: 'missing', status: null }
    if (row.status !== 'queued') return { claimed: false, reason: 'not-queued', status: row.status }
    const active = [...this.rows.values()].filter((r) => (ACTIVE_EXECUTION_STATUSES as readonly string[]).includes(r.status)).length
    if (active >= maxActive) return { claimed: false, reason: 'capacity', status: row.status }
    const now = new Date()
    this.#transition(row, 'preparing')
    Object.assign(row, { runner, heartbeatAt: now, startedAt: now, updatedAt: now })
    return { claimed: true, row: structuredClone(row) }
  }

  async update(id: string, guard: ExecutionGuard, patch: ExecutionPatch): Promise<ExecutionRecord | null> {
    const row = this.rows.get(id)
    if (!row || !guard.from.includes(row.status)) return null
    if (guard.ownerId !== undefined && row.runner?.ownerId !== guard.ownerId) return null
    if (isTerminalExecutionStatus(row.status)) throw new Error(`execution ${id} is ${row.status} and final (UPDATE rejected)`)
    if (patch.status && patch.status !== row.status) this.#transition(row, patch.status)
    const { status: _status, ...rest } = patch
    Object.assign(row, structuredClone(rest), { updatedAt: new Date() })
    return structuredClone(row)
  }

  async heartbeat(id: string, ownerId: string): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.runner?.ownerId !== ownerId || isTerminalExecutionStatus(row.status)) return false
    row.heartbeatAt = new Date()
    return true
  }

  async setJob(id: string, jobId: string): Promise<void> {
    const row = this.rows.get(id)
    if (row && !isTerminalExecutionStatus(row.status)) row.jobId = jobId
  }

  async hasPendingJob(id: string): Promise<boolean> {
    return this.jobs.has(id)
  }

  /** Raw access for tests that simulate a crashed worker or tamper with a snapshot. */
  patchRaw(id: string, patch: Partial<ExecutionRecord>): void {
    Object.assign(this.rows.get(id)!, patch)
  }

  #transition(row: ExecutionRecord, to: ExecutionRecord['status']): void {
    if (!canTransitionExecution(row.status, to)) throw new Error(`invalid execution transition ${row.status} → ${to}`)
    this.transitions.push({ id: row.id, from: row.status, to })
    row.status = to
  }
}

export class MemoryQueue implements ExecutionQueue {
  readonly sent: string[] = []

  constructor(private readonly store: MemoryExecutionStore) {}

  async enqueue(executionId: string, jobId?: string): Promise<string | null> {
    this.sent.push(executionId)
    this.store.jobs.add(executionId)
    return jobId ?? `job-${this.sent.length}`
  }
}
