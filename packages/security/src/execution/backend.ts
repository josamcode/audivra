import type { SecurityExecutionSnapshot } from '@audivra/contracts'
import { killOwnedForExecution } from '@audivra/tool-runtime'
import type { CapabilityHandles, SecurityCapability, SecurityExecutionContext } from '../capabilities/types.ts'
import type { ExecutionWorkspace } from './workspace.ts'

/*
 * Execution backends: *how* an accepted execution is carried out. The runtime owns everything that
 * must not depend on the backend — the snapshot, lifecycle, timeout, cancellation, limits, evidence,
 * events and recovery — and asks the backend only to:
 *
 *   prepare   → set up the run inside the execution workspace
 *   start     → begin the work and return immediately
 *   observe   → resolve when the work ends on its own
 *   cancel    → deliver a graceful stop request
 *   terminate → force-stop exactly the resources this execution owns
 *   cleanup   → remove scratch state (idempotent)
 *
 * The first backend runs reviewed capability code in the worker process. A later isolated backend
 * (container or VM with the workspace mounted and mediated egress) implements the same six steps.
 */

export interface BackendSpec {
  executionId: string
  snapshot: SecurityExecutionSnapshot
  capability: SecurityCapability
  /** Frozen, built from the snapshot only. */
  context: Readonly<SecurityExecutionContext>
  /** Input validated against the capability schema. */
  input: unknown
  /** Platform-mediated handles (in-process backends pass them to the capability). */
  handles: CapabilityHandles
  workspace: ExecutionWorkspace
  /** Aborting it is the graceful stop request the handles observe. */
  stop: AbortController
}

export type BackendExit =
  | { status: 'succeeded'; output: unknown; summary: string; code: number | null }
  | { status: 'failed'; error: unknown; code: number | null }

export interface PreparedExecution {
  readonly spec: BackendSpec
}

export interface RunningExecution {
  readonly prepared: PreparedExecution
  readonly exit: Promise<BackendExit>
}

export interface ExecutionBackend {
  /** Recorded with the runner identity of every execution. */
  readonly id: string
  prepare(spec: BackendSpec): Promise<PreparedExecution>
  start(prepared: PreparedExecution): Promise<RunningExecution>
  observe(running: RunningExecution): Promise<BackendExit>
  cancel(running: RunningExecution, reason: string): Promise<void>
  /** Terminates the execution's owned resources; the runtime stops waiting for the work afterwards. */
  terminate(running: RunningExecution): Promise<{ terminated: number }>
  cleanup(prepared: PreparedExecution): Promise<{ removedBytes: number }>
}

/**
 * Runs the capability implementation inside the worker process. Processes it starts are owned by the
 * execution (registry entries keyed by its id), so `terminate` kills exactly those. Limitation: code
 * that ignores the stop signal cannot be pre-empted in-process; the runtime then abandons it — its
 * handles are revoked (no evidence, no new processes, no network) — and finishes the execution. Hard
 * containment is what the later isolated backend adds.
 */
export class InProcessBackend implements ExecutionBackend {
  readonly id = 'in-process'

  async prepare(spec: BackendSpec): Promise<PreparedExecution> {
    await spec.workspace.init()
    await spec.workspace.write(
      'inputs',
      'input.json',
      JSON.stringify({ executionId: spec.executionId, capability: { id: spec.snapshot.capability.id, version: spec.snapshot.capability.version }, input: spec.input }, null, 2),
    )
    return { spec }
  }

  async start(prepared: PreparedExecution): Promise<RunningExecution> {
    const { capability, context, input, handles } = prepared.spec
    const exit: Promise<BackendExit> = Promise.resolve()
      .then(() => capability.implementation.execute(context, input, handles))
      .then(
        (result) => ({ status: 'succeeded' as const, output: result.output, summary: result.summary, code: null }),
        (error: unknown) => ({ status: 'failed' as const, error, code: null }),
      )
    return { prepared, exit }
  }

  observe(running: RunningExecution): Promise<BackendExit> {
    return running.exit
  }

  async cancel(running: RunningExecution, reason: string): Promise<void> {
    const { stop } = running.prepared.spec
    if (!stop.signal.aborted) stop.abort(new Error(reason))
  }

  async terminate(running: RunningExecution): Promise<{ terminated: number }> {
    const { stop, executionId } = running.prepared.spec
    if (!stop.signal.aborted) stop.abort(new Error('Terminated'))
    return { terminated: await killOwnedForExecution(executionId) }
  }

  async cleanup(prepared: PreparedExecution): Promise<{ removedBytes: number }> {
    return prepared.spec.workspace.cleanup()
  }
}
