import { describe, expect, it } from 'vitest'
import {
  ACTIVE_EXECUTION_STATUSES,
  canTransitionExecution,
  EXECUTION_STATUSES,
  EXECUTION_TRANSITIONS,
  executionSourcesFor,
  isTerminalExecutionStatus,
  SECURITY_EVENT_TYPES,
  SecurityExecutionSnapshot,
  TERMINAL_EXECUTION_STATUSES,
  type ExecutionStatus,
} from '../src/index.ts'

describe('security execution lifecycle', () => {
  it('allows exactly the documented transitions', () => {
    const allowed = (from: ExecutionStatus) => EXECUTION_STATUSES.filter((to) => canTransitionExecution(from, to))
    expect(allowed('queued')).toEqual(['preparing', 'failed', 'cancelled'])
    expect(allowed('preparing')).toEqual(['running', 'finalizing', 'cancelling', 'failed', 'interrupted'])
    expect(allowed('running')).toEqual(['finalizing', 'cancelling', 'failed', 'interrupted'])
    expect(allowed('finalizing')).toEqual(['succeeded', 'failed', 'timed-out', 'interrupted'])
    expect(allowed('cancelling')).toEqual(['failed', 'cancelled', 'interrupted'])
    // Nothing skips the work: a queued execution cannot succeed or time out without running.
    expect(canTransitionExecution('queued', 'succeeded')).toBe(false)
    expect(canTransitionExecution('running', 'succeeded')).toBe(false)
    expect(canTransitionExecution('queued', 'running')).toBe(false)
  })

  it('makes terminal states final and reachable from every other state', () => {
    for (const status of TERMINAL_EXECUTION_STATUSES) {
      expect(isTerminalExecutionStatus(status)).toBe(true)
      expect(EXECUTION_TRANSITIONS[status]).toEqual([])
    }
    const reachesTerminal = (from: ExecutionStatus, seen = new Set<ExecutionStatus>()): boolean =>
      isTerminalExecutionStatus(from) || EXECUTION_TRANSITIONS[from].some((to) => !seen.has(to) && reachesTerminal(to, new Set([...seen, from])))
    for (const status of EXECUTION_STATUSES) expect(reachesTerminal(status), status).toBe(true)
    for (const status of ACTIVE_EXECUTION_STATUSES) expect(isTerminalExecutionStatus(status)).toBe(false)
    expect(executionSourcesFor('cancelled')).toEqual(['queued', 'cancelling'])
    expect(executionSourcesFor('succeeded')).toEqual(['finalizing'])
  })

  it('records lifecycle events in the existing append-only vocabulary', () => {
    for (const type of ['execution.requested', 'execution.queued', 'execution.preparing', 'execution.started', 'execution.completed', 'execution.failed', 'execution.cancel-requested', 'execution.cancelled', 'execution.timed-out', 'execution.recovered', 'execution.cleanup-started', 'execution.cleanup-completed']) {
      expect(SECURITY_EVENT_TYPES).toContain(type)
    }
  })

  it('keeps the trusted snapshot strict: unknown fields are rejected, not ignored', () => {
    const parsed = SecurityExecutionSnapshot.safeParse({ schemaVersion: 1, executionId: 'sx_x', authorized: true })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('authorized')
  })
})
