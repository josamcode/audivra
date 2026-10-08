import type { ContainerFacts, ExecutionMode, SecurityExecutionSnapshot } from '@audivra/contracts'
import { killOwnedForExecution } from '@audivra/tool-runtime'
import type { CapabilityHandles, SecurityCapability, SecurityExecutionContext } from '../capabilities/types.ts'
import type { ExecutionEventType } from './events.ts'
import { ExecutionError } from './failures.ts'
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
 * The runtime picks the backend from the execution mode recorded in the trusted snapshot (never from a
 * request): `InProcessBackend` runs reviewed, lightweight platform code in the worker;
 * `IsolatedContainerBackend` runs a reviewed executor program in an approved, execution-scoped container.
 * For recovery a backend can `resume` an execution whose worker is gone without starting anything.
 */

/** Owner-tool prefix of a backend's own helper processes (e.g. the docker CLI) — not capability processes. */
export const RUNTIME_HELPER_PREFIX = 'runtime:'

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
  /** Records a concise lifecycle event of this execution (redacted at persistence). */
  events: (type: ExecutionEventType, message: string, data?: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => Promise<unknown>
}

export type BackendExit = (
  | { status: 'succeeded'; output: unknown; summary: string; code: number | null }
  | { status: 'failed'; error: unknown; code: number | null }
) & {
  /** What an isolated backend observed of the execution's container. */
  container?: ContainerFacts
}

/** What an execution left behind with a backend when its worker stopped (from `resume`). */
export interface BackendRemains {
  prepared: PreparedExecution
  /** `none`: the backend keeps nothing outside the worker. `missing`: it should, but nothing is there. */
  state: 'none' | 'created' | 'running' | 'exited' | 'missing'
  /** For `running` and `exited`: the run, observable like one this worker started. */
  running: RunningExecution | null
}

/** A resource a backend created for an execution (e.g. its container), proven by exact name and labels. */
export interface OwnedResource {
  executionId: string
  engagementId: string
  name: string
  state: string
}

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
  /** The execution mode this backend carries out. */
  readonly mode: ExecutionMode
  prepare(spec: BackendSpec): Promise<PreparedExecution>
  start(prepared: PreparedExecution): Promise<RunningExecution>
  observe(running: RunningExecution): Promise<BackendExit>
  cancel(running: RunningExecution, reason: string): Promise<void>
  /** Terminates the execution's owned resources; the runtime stops waiting for the work afterwards. */
  terminate(running: RunningExecution): Promise<{ terminated: number }>
  /** Removes what the execution owns with this backend and its scratch space. Idempotent; throws if anything remains. */
  cleanup(prepared: PreparedExecution): Promise<{ removedBytes: number; container?: ContainerFacts }>
  /** Recovery: finds what the execution left behind, without starting or changing anything. */
  resume(spec: BackendSpec): Promise<BackendRemains>
  /** Recovery: resources this backend created for executions, proven by exact name and labels. */
  ownedResources?(): Promise<OwnedResource[]>
  /** Recovery: removes one such resource of a final execution (exact; re-verified). */
  removeOwnedResource?(resource: OwnedResource): Promise<void>
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
  readonly mode = 'in-process' as const

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
    const execute = capability.implementation.execute
    // An isolated capability has no in-process implementation: this backend cannot run it, by construction.
    if (typeof execute !== 'function') throw new ExecutionError('runtime-unavailable', 'runtime.wrong-backend', `${capability.metadata.id} cannot run in-process`)
    const exit: Promise<BackendExit> = Promise.resolve()
      .then(() => execute.call(capability.implementation, context, input, handles))
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

  /** Nothing outlives the worker in-process (its owned processes are reconciled through the registry). */
  async resume(spec: BackendSpec): Promise<BackendRemains> {
    return { prepared: { spec }, state: 'none', running: null }
  }
}
