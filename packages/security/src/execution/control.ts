import { isTerminalExecutionStatus, type ExecutionExit, type SecurityActor } from '@audivra/contracts'
import { SecurityRequestError } from '../service.ts'
import type { SecurityStore } from '../store.ts'
import { executionEvent } from './events.ts'
import type { ExecutionRecord, ExecutionStore } from './store.ts'

const actorLabel = (actor: SecurityActor) => (actor.kind === 'agent' ? `Agent run ${actor.agentRunId ?? '(unknown)'}` : actor.kind === 'system' ? 'Audivra' : 'User')

export const NOT_STARTED_EXIT: ExecutionExit = {
  outcome: 'cancelled',
  code: null,
  summary: null,
  durationMs: null,
  processes: { started: 0, terminated: 0, reaped: 0 },
  artifacts: { registered: 0, bytes: 0 },
  abandoned: false,
}

/**
 * Requests cancellation. Idempotent: cancelling a cancelling or cancelled execution changes nothing.
 *
 * - queued → cancelled at once (nothing ran, nothing to clean up);
 * - preparing / running → cancelling: the worker holding it sees the request within a second, sends
 *   the graceful stop, terminates exactly the execution's owned resources after the grace period,
 *   flushes and cleans up, and marks it cancelled;
 * - finalizing or final → refused (the work is over).
 *
 * Only the execution named is touched; other executions and processes are never affected.
 */
export async function requestExecutionCancel(
  deps: { store: Pick<SecurityStore, 'recordEvent'>; executions: ExecutionStore },
  id: string,
  actor: SecurityActor,
  reason = 'Cancellation requested',
): Promise<{ execution: ExecutionRecord; changed: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await deps.executions.get(id)
    if (!row) throw new SecurityRequestError(404, 'Execution not found')
    if (row.status === 'cancelling' || row.status === 'cancelled') return { execution: row, changed: false }
    if (isTerminalExecutionStatus(row.status)) throw new SecurityRequestError(409, `The execution is already ${row.status}`)
    if (row.status === 'finalizing') throw new SecurityRequestError(409, 'The execution has finished its work and is finalizing; it can no longer be cancelled')
    const now = new Date()
    if (row.status === 'queued') {
      const updated = await deps.executions.update(
        id,
        { from: ['queued'] },
        {
          status: 'cancelled',
          cancelRequestedAt: now,
          cancelRequestedBy: actor,
          finishedAt: now,
          failure: { kind: 'cancelled', rule: 'execution.cancelled-before-start', message: reason },
          exit: NOT_STARTED_EXIT,
        },
      )
      if (!updated) continue
      await executionEvent(deps.store, row, 'execution.cancel-requested', `${actorLabel(actor)} requested cancellation: ${reason}`, { previousStatus: 'queued' }, 'warn', actor)
      await executionEvent(deps.store, row, 'execution.cancelled', 'Cancelled before it started; nothing ran', { status: 'cancelled' }, 'warn')
      return { execution: updated, changed: true }
    }
    const updated = await deps.executions.update(id, { from: ['preparing', 'running'] }, { status: 'cancelling', cancelRequestedAt: now, cancelRequestedBy: actor })
    if (!updated) continue
    await executionEvent(deps.store, row, 'execution.cancel-requested', `${actorLabel(actor)} requested cancellation: ${reason}`, { previousStatus: row.status }, 'warn', actor)
    return { execution: updated, changed: true }
  }
  throw new SecurityRequestError(409, 'The execution changed state while it was being cancelled; try again')
}
