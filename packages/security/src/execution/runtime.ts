import os from 'node:os'
import { engagementWorkspaceDir, getConfig, type Logger } from '@audivra/config'
import {
  ACTIVE_EXECUTION_STATUSES,
  isTerminalExecutionStatus,
  redact,
  type ExecutionExit,
  type ExecutionFailure,
  type ExecutionResult,
  type ExecutionRunner,
  type ExecutionStatus,
  type SecurityExecutionSnapshot,
} from '@audivra/contracts'
import { dockerImagePresent, killOwnedForExecution, liveOwnedForExecution, OWNER_ID, processIdentity, reapStaleProcessesForExecution } from '@audivra/tool-runtime'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import type { SecurityCapability } from '../capabilities/types.ts'
import { compact } from '../compact.ts'
import { systemResolver, type Resolver } from '../dns.ts'
import { checkExecutionResources, type ResourceCheck, type ResourceCheckInput } from '../resources.ts'
import type { SecurityStore } from '../store.ts'
import type { ArtifactRegistrar } from './artifacts.ts'
import { InProcessBackend, type ExecutionBackend, type PreparedExecution } from './backend.ts'
import { requestExecutionCancel } from './control.ts'
import { executionEvent, RUNTIME_ACTOR, type ExecutionEventType } from './events.ts'
import { classifyFailure, ExecutionError, failure, failureMessage } from './failures.ts'
import { createExecutionHandles } from './handles.ts'
import type { ExecutionProcesses } from './processes.ts'
import { contextFromSnapshot, revalidateSnapshot, verifyStoredSnapshot } from './snapshot.ts'
import type { ExecutionQueue, ExecutionRecord, ExecutionStore } from './store.ts'
import { ExecutionWorkspace } from './workspace.ts'

/*
 * The execution runtime: runs one accepted execution from its stored snapshot, in the worker.
 *
 *   claim (queued → preparing, within the concurrency limit)
 *   → verify snapshot → resolve capability → revalidate authority → resource preflight
 *   → workspace + backend.prepare → running → backend.start / observe
 *       ├─ work ends            → finalizing (result persisted)
 *       ├─ timeout (Audivra's)  → graceful stop → grace → terminate exact owned resources → finalizing
 *       └─ cancel requested     → cancelling → graceful stop → grace → terminate → …
 *   → artifact budget → cleanup (owned processes, scratch space) → final state + events
 *
 * Every state change is a guarded update naming the states it may start from and the worker that must
 * hold the execution, so cancellation, crash recovery and duplicate deliveries cannot corrupt it.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Display name from the stored snapshot (falls back to the id if the snapshot is unreadable). */
const capabilityName = (row: ExecutionRecord) => (row.snapshot as Partial<SecurityExecutionSnapshot> | null)?.capability?.name ?? row.capabilityId
const ACTIVE = new Set<string>(ACTIVE_EXECUTION_STATUSES)
const NOT_RUNNABLE_ENGAGEMENT = new Set<string>(['paused', 'completed', 'cancelled', 'invalid'])
/** How often (in watcher polls) the engagement's lifecycle is checked while an execution runs. */
const ENGAGEMENT_CHECK_EVERY = 5

type StopReason = 'cancel' | 'timeout' | 'shutdown'

export interface ExecutionRuntimeOptions {
  registry: CapabilityRegistry
  store: SecurityStore
  executions: ExecutionStore
  /** Re-queues queued executions whose job was lost (recovery). */
  queue?: ExecutionQueue
  backend?: ExecutionBackend
  resolver?: Resolver
  workspaceRoot?: (engagementId: string) => string
  checkResources?: (input: ResourceCheckInput) => Promise<ResourceCheck>
  /** Executions that may be active at once across every worker sharing the database. */
  maxActive?: number
  /** How often a running execution's record is checked for cancellation. */
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  /** Overrides the snapshot's stop grace period (tests). */
  cancelGraceMs?: number
  /** A runner on another host is considered gone after this long without a heartbeat. */
  staleAfterMs?: number
  now?: () => Date
  log?: Logger
}

export interface RecoveryReport {
  /** Queued executions whose job was lost and was sent again. */
  requeued: string[]
  /** Executions of a worker that is gone, brought to a final state. */
  reconciled: { id: string; status: ExecutionStatus }[]
  /** Executions held by a worker that is still alive (left alone). */
  skipped: string[]
}

interface RunState {
  row: ExecutionRecord
  ownerId: string
  snapshot: SecurityExecutionSnapshot | null
  workspace: ExecutionWorkspace | null
  prepared: PreparedExecution | null
  registrar: ArtifactRegistrar | null
  processes: ExecutionProcesses | null
  startedAtMs: number
  code: number | null
  /** Registry ids of owned processes Audivra stopped (alive when it began stopping, or at cleanup). */
  stopped: Set<string>
  reaped: number
  abandoned: boolean
}

export class ExecutionRuntime {
  readonly #registry: CapabilityRegistry
  readonly #store: SecurityStore
  readonly #executions: ExecutionStore
  readonly #queue: ExecutionQueue | undefined
  readonly #backend: ExecutionBackend
  readonly #resolver: Resolver
  readonly #workspaceRoot: (engagementId: string) => string
  readonly #checkResources: (input: ResourceCheckInput) => Promise<ResourceCheck>
  readonly #maxActive: number
  readonly #pollMs: number
  readonly #heartbeatMs: number
  readonly #graceMs: number | undefined
  readonly #staleAfterMs: number
  readonly #now: () => Date
  readonly #log: Logger | undefined
  readonly #active = new Map<string, { requestStop(reason: StopReason): void; done: Promise<void> }>()
  #runner: Promise<ExecutionRunner> | null = null
  #stopping = false

  constructor(options: ExecutionRuntimeOptions) {
    this.#registry = options.registry
    this.#store = options.store
    this.#executions = options.executions
    this.#queue = options.queue
    this.#backend = options.backend ?? new InProcessBackend()
    this.#resolver = options.resolver ?? systemResolver
    this.#workspaceRoot = options.workspaceRoot ?? engagementWorkspaceDir
    this.#checkResources = options.checkResources ?? checkExecutionResources
    this.#maxActive = options.maxActive ?? 2
    this.#pollMs = options.pollIntervalMs ?? 1000
    this.#heartbeatMs = options.heartbeatIntervalMs ?? 5000
    this.#graceMs = options.cancelGraceMs
    this.#staleAfterMs = options.staleAfterMs ?? 120_000
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  get backendId(): string {
    return this.#backend.id
  }

  /** Executions this runtime is carrying out right now. */
  activeExecutions(): string[] {
    return [...this.#active.keys()]
  }

  /** Identity of this worker process, recorded on every execution it holds. */
  runner(): Promise<ExecutionRunner> {
    this.#runner ??= processIdentity(process.pid).then((identity) => ({
      ownerId: OWNER_ID,
      host: os.hostname(),
      pid: process.pid,
      processStartedAt: identity?.startedAt.toISOString() ?? null,
      backend: this.#backend.id,
    }))
    return this.#runner
  }

  /**
   * Job handler: runs a queued execution to a final state. A delivery for an execution that is not
   * queued never starts it again — an execution held by a worker that has died is reconciled instead.
   */
  async run(executionId: string): Promise<ExecutionStatus | null> {
    if (this.#active.has(executionId) || this.#stopping) return null
    const runner = await this.runner()
    for (;;) {
      const claim = await this.#executions.claim(executionId, runner, this.#maxActive)
      if (claim.claimed) return this.#execute(claim.row, runner)
      if (claim.reason === 'capacity') {
        if (this.#stopping) return null
        await sleep(this.#pollMs)
        continue
      }
      if (claim.reason === 'not-queued') {
        const row = await this.#executions.get(executionId)
        if (row && ACTIVE.has(row.status) && !this.#active.has(row.id) && !(await this.#runnerAlive(row))) return (await this.#reconcile(row)) ?? row.status
        return row?.status ?? null
      }
      return claim.status
    }
  }

  /**
   * Start-up reconciliation (and safe to call at any time): re-queues queued executions whose job was
   * lost, and brings executions held by a worker that is gone to an honest final state. Executions of
   * live workers — on this machine identified by PID *and* process start time — are never touched.
   */
  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { requeued: [], reconciled: [], skipped: [] }
    for (const row of await this.#executions.listUnfinished()) {
      if (this.#active.has(row.id)) continue
      if (row.status === 'queued') {
        if (!this.#queue || (await this.#executions.hasPendingJob(row.id))) continue
        const jobId = await this.#queue.enqueue(row.id)
        if (jobId) await this.#executions.setJob(row.id, jobId)
        await this.#event(row, 'execution.recovered', 'Re-queued: the execution was waiting but its job was lost', { action: 'requeued', jobId })
        report.requeued.push(row.id)
        continue
      }
      if (await this.#runnerAlive(row)) {
        report.skipped.push(row.id)
        continue
      }
      const status = await this.#reconcile(row)
      if (status) report.reconciled.push({ id: row.id, status })
    }
    return report
  }

  /** Stops accepting work and interrupts what is running (owned resources are terminated, nothing is left running). */
  async shutdown(timeoutMs = 20_000): Promise<void> {
    this.#stopping = true
    const active = [...this.#active.values()]
    for (const entry of active) entry.requestStop('shutdown')
    await Promise.race([Promise.all(active.map((entry) => entry.done)), sleep(timeoutMs)])
  }

  // ── One execution ─────────────────────────────────────────────────────────────────────────────────

  async #execute(row: ExecutionRecord, runner: ExecutionRunner): Promise<ExecutionStatus> {
    const id = row.id
    let stopReason: StopReason | null = null
    let onStop!: (reason: StopReason) => void
    const stopped = new Promise<StopReason>((resolve) => (onStop = resolve))
    const requestStop = (reason: StopReason) => {
      if (stopReason) return
      stopReason = reason
      onStop(reason)
    }
    let markDone!: () => void
    this.#active.set(id, { requestStop, done: new Promise<void>((resolve) => (markDone = resolve)) })

    const state: RunState = {
      row,
      ownerId: runner.ownerId,
      snapshot: null,
      workspace: null,
      prepared: null,
      registrar: null,
      processes: null,
      startedAtMs: Date.now(),
      code: null,
      stopped: new Set(),
      reaped: 0,
      abandoned: false,
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    let polls = 0
    timers.push(setInterval(() => void this.#executions.heartbeat(id, runner.ownerId).catch(() => undefined), this.#heartbeatMs))
    timers.push(
      setInterval(() => {
        void this.#watch(row, ++polls, requestStop).catch((error: unknown) => this.#log?.warn({ err: error, executionId: id }, 'execution watcher failed'))
      }, this.#pollMs),
    )
    const stop = new AbortController()
    const log = this.#log?.child({ executionId: id, capabilityId: row.capabilityId, engagementId: row.engagementId })

    try {
      await this.#event(row, 'execution.preparing', `Preparing ${capabilityName(row)}`, { backend: this.#backend.id, runner: { host: runner.host, pid: runner.pid } })
      log?.info('security execution preparing')
      let result: ExecutionResult | undefined
      let prepared: PreparedExecution | null = null
      try {
        prepared = await this.#prepare(state, stop, (ms) => timers.push(setTimeout(() => requestStop('timeout'), ms)))
      } catch (error) {
        result = this.#result(state, 'failed', error instanceof ExecutionError ? classifyFailure(error) : failure('preflight-failed', 'preflight.error', failureMessage(error)))
      }
      if (prepared) {
        if (stopReason) result = this.#stopResult(state, stopReason)
        else if (!(await this.#executions.update(id, { from: ['preparing'], ownerId: runner.ownerId }, { status: 'running' }))) {
          // Cancelled (or adopted) while preparing.
          result = this.#stopResult(state, 'cancel')
        } else {
          const s = state.snapshot!
          await this.#event(row, 'execution.started', `${s.capability.name} started`, {
            backend: this.#backend.id,
            timeoutSeconds: s.runtime.timeoutSeconds,
            maxProcesses: s.runtime.maxProcesses,
            maxArtifactBytes: s.runtime.maxArtifactBytes,
            targets: s.allowedTargets,
          })
          result = await this.#work(state, prepared, stopped)
        }
      }
      const status = await this.#settle(state, result ?? this.#result(state, 'failed', failure('internal', 'runtime.no-result', 'The execution ended without a result')))
      log?.info({ status }, 'security execution finished')
      return status
    } catch (error) {
      // A platform failure (e.g. the database went away): close the execution honestly if possible.
      log?.error({ err: error }, 'security execution crashed')
      return this.#settle(state, this.#result(state, 'failed', failure('internal', 'runtime.internal-error', failureMessage(error)))).catch(() => row.status)
    } finally {
      for (const timer of timers) clearInterval(timer)
      this.#active.delete(id)
      markDone()
    }
  }

  async #prepare(state: RunState, stop: AbortController, armTimeout: (ms: number) => void): Promise<PreparedExecution> {
    const { row } = state
    const snapshot = verifyStoredSnapshot(row)
    state.snapshot = snapshot
    // The wall-clock limit is Audivra's, counted from the moment the worker took the execution.
    armTimeout(Math.max(0, snapshot.runtime.timeoutSeconds * 1000 - (Date.now() - state.startedAtMs)))
    const capability = this.#capability(snapshot)
    const input = capability.implementation.input.safeParse(snapshot.input)
    if (!input.success) throw new ExecutionError('preflight-failed', 'execution.input-invalid', `The stored input no longer matches ${capability.metadata.id}: ${input.error.issues[0]?.message ?? 'invalid'}`)
    const refusal = revalidateSnapshot(snapshot, await this.#store.loadEngagement(row.engagementId), this.#now())
    if (refusal) throw refusal
    const workspace = new ExecutionWorkspace(this.#workspaceRoot(row.engagementId), row.id)
    state.workspace = workspace
    const resources = await this.#checkResources({
      capability: capability.metadata,
      workspaceRoot: workspace.root,
      minFreeBytes: getConfig().SECURITY_MIN_FREE_DISK_MB * 1_048_576,
      maxArtifactBytes: snapshot.limits.maxArtifactMb * 1_048_576,
      imagePresent: dockerImagePresent,
    })
    if (!resources.ok) throw new ExecutionError('preflight-failed', resources.rule, resources.reason)
    const { handles, registrar, processes } = createExecutionHandles(snapshot, { workspace, signal: stop.signal, resolver: this.#resolver, store: this.#store })
    state.registrar = registrar
    state.processes = processes
    const prepared = await this.#backend.prepare({
      executionId: row.id,
      snapshot,
      capability,
      context: contextFromSnapshot(snapshot),
      input: input.data,
      handles,
      workspace,
      stop,
    })
    state.prepared = prepared
    return prepared
  }

  /** The registered capability, which must still be exactly the one the decision was made for. */
  #capability(snapshot: SecurityExecutionSnapshot): SecurityCapability {
    const capability = this.#registry.get(snapshot.capability.id)
    if (!capability) throw new ExecutionError('preflight-failed', 'execution.capability-unavailable', `${snapshot.capability.id} is not registered with this worker`)
    const { version, implementation } = capability.metadata
    if (version !== snapshot.capability.version || implementation !== snapshot.capability.implementation) {
      throw new ExecutionError(
        'preflight-failed',
        'execution.capability-changed',
        `${snapshot.capability.id} changed after the decision (${snapshot.capability.implementation} v${snapshot.capability.version} → ${implementation} v${version})`,
      )
    }
    return capability
  }

  async #work(state: RunState, prepared: PreparedExecution, stopped: Promise<StopReason>): Promise<ExecutionResult> {
    const running = await this.#backend.start(prepared)
    const raced = await Promise.race([this.#backend.observe(running).then((exit) => ({ exit })), stopped.then((reason) => ({ reason }))])
    if ('exit' in raced) {
      state.registrar?.close()
      state.code = raced.exit.code
      return raced.exit.status === 'succeeded'
        ? this.#result(state, 'succeeded', null, raced.exit.summary, raced.exit.output)
        : this.#result(state, 'failed', classifyFailure(raced.exit.error))
    }
    // Audivra stops the work: graceful request first, then exact termination of owned resources.
    const reason = raced.reason
    for (const process of liveOwnedForExecution(state.row.id)) state.stopped.add(process.id)
    await this.#backend.cancel(running, reason === 'timeout' ? 'Timed out' : reason === 'shutdown' ? 'The worker is shutting down' : 'Cancelled')
    const grace = this.#graceMs ?? state.snapshot!.runtime.cancelGraceSeconds * 1000
    const settled = await Promise.race([this.#backend.observe(running).then(() => true), sleep(grace).then(() => false)])
    state.registrar?.close()
    await this.#backend.terminate(running)
    // Code that ignored the stop request is abandoned (its handles are revoked); never wait on it.
    state.abandoned = !settled && !(await Promise.race([this.#backend.observe(running).then(() => true), sleep(1000).then(() => false)]))
    return this.#stopResult(state, reason)
  }

  #stopResult(state: RunState, reason: StopReason): ExecutionResult {
    if (reason === 'timeout') {
      return this.#result(state, 'timeout', failure('timeout', 'runtime.timeout', `Stopped by Audivra after the ${state.snapshot?.runtime.timeoutSeconds ?? '?'} s execution limit`))
    }
    if (reason === 'shutdown') return this.#result(state, 'cancelled', failure('worker-interrupted', 'runtime.shutdown', 'The worker shut down while the execution was in progress'))
    return this.#result(state, 'cancelled', failure('cancelled', 'execution.cancelled', 'Cancelled on request'))
  }

  #result(state: RunState, outcome: ExecutionResult['outcome'], fail: ExecutionFailure | null, summary: string | null = null, output: unknown = null): ExecutionResult {
    return {
      outcome,
      summary: summary === null ? null : redact(summary).slice(0, 500),
      output: compact(output),
      failure: fail,
      evidenceRefs: state.registrar?.registered.map((e) => e.ref) ?? [],
      artifactBytes: state.registrar?.bytes ?? 0,
      processesStarted: state.processes?.started ?? 0,
      endedAt: this.#now().toISOString(),
    }
  }

  /**
   * Finishes an execution whose work is over (also used by recovery): persists the result, checks the
   * artifact budget, cleans up, and records the final state. Gives up silently when another worker or
   * a recovery has taken the execution over.
   */
  async #settle(state: RunState, result: ExecutionResult): Promise<ExecutionStatus> {
    const { row, ownerId } = state
    const id = row.id
    state.registrar?.close()
    const reread = await this.#executions.get(id)
    if (!reread) return row.status
    let current = reread.status
    if (isTerminalExecutionStatus(current) || reread.runner?.ownerId !== ownerId) return current
    const kind = result.failure?.kind
    if ((current === 'preparing' || current === 'running') && kind !== 'worker-interrupted' && kind !== 'preflight-failed' && kind !== 'internal') {
      // Record what happened first, so a restarted worker can complete the execution from here.
      const moved = await this.#executions.update(id, { from: [current], ownerId }, { status: 'finalizing', result })
      current = moved ? 'finalizing' : ((await this.#executions.get(id))?.status ?? current)
      if (isTerminalExecutionStatus(current)) return current
    } else if (current === 'cancelling') {
      await this.#executions.update(id, { from: ['cancelling'], ownerId }, { result })
    }

    let finalFailure = result.failure
    if (result.outcome === 'succeeded' && state.workspace && state.snapshot) {
      const bytes = await state.workspace.artifactBytes()
      if (bytes > state.snapshot.runtime.maxArtifactBytes) {
        finalFailure = failure('artifact-limit', 'artifact.budget-exceeded', `The execution's files use ${bytes} bytes; its artifact budget is ${state.snapshot.runtime.maxArtifactBytes} bytes`)
      }
    }
    const cleanup = await this.#cleanup(state)
    const status = finalStatus(current, result, finalFailure, cleanup.error)
    const fail: ExecutionFailure | null =
      status === 'succeeded'
        ? null
        : cleanup.error
          ? failure('cleanup-failed', 'cleanup.failed', `${cleanup.error} (the work ended: ${result.outcome})`)
          : current === 'cancelling' && finalFailure?.kind !== 'worker-interrupted'
            ? failure('cancelled', 'execution.cancelled', await this.#cancelMessage(id))
            : (finalFailure ?? failure('internal', 'runtime.unknown', 'The execution did not succeed'))
    const exit: ExecutionExit = {
      outcome: status === 'timed-out' ? 'timeout' : status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'interrupted' ? status : 'failed',
      code: state.code,
      summary: result.summary,
      durationMs: Math.max(0, Date.now() - state.startedAtMs),
      processes: { started: result.processesStarted, terminated: state.stopped.size, reaped: state.reaped },
      artifacts: { registered: result.evidenceRefs.length, bytes: result.artifactBytes },
      abandoned: state.abandoned,
    }
    const now = this.#now()
    const done = await this.#executions.update(id, { from: [current], ownerId }, { status, finishedAt: now, heartbeatAt: now, exit, failure: fail })
    if (!done) return (await this.#executions.get(id))?.status ?? current
    await this.#terminalEvent(row, status, fail, exit, result)
    return status
  }

  async #cancelMessage(id: string): Promise<string> {
    const actor = (await this.#executions.get(id))?.cancelRequestedBy
    return actor?.kind === 'system' ? 'Cancelled by Audivra' : actor?.kind === 'agent' ? `Cancelled by agent run ${actor.agentRunId ?? ''}`.trim() : 'Cancelled by the user'
  }

  /** Terminates whatever the execution still owns (exact registry entries) and removes scratch space. */
  async #cleanup(state: RunState): Promise<{ error: string | null }> {
    const { row } = state
    await this.#event(row, 'execution.cleanup-started', 'Cleaning up owned processes and scratch space')
    const leftovers = liveOwnedForExecution(row.id)
    for (const process of leftovers) state.stopped.add(process.id)
    const terminated = leftovers.length
    let removedBytes = 0
    let error: string | null = null
    try {
      await killOwnedForExecution(row.id)
      const deadline = Date.now() + 10_000
      while (liveOwnedForExecution(row.id).length && Date.now() < deadline) await sleep(100)
      const remaining = liveOwnedForExecution(row.id)
      if (remaining.length) throw new Error(`${remaining.length} owned process(es) did not exit (PID ${remaining.map((p) => p.pid).join(', ')})`)
      if (state.prepared) removedBytes = (await this.#backend.cleanup(state.prepared)).removedBytes
      else if (state.workspace) removedBytes = (await state.workspace.cleanup()).removedBytes
    } catch (cause) {
      error = failureMessage(cause)
    }
    await this.#event(
      row,
      'execution.cleanup-completed',
      error ? `Cleanup failed: ${error}` : `Cleanup completed${terminated ? `; ${terminated} owned process${terminated === 1 ? '' : 'es'} terminated` : ''}`,
      { terminatedProcesses: terminated, removedBytes, error },
      error ? 'error' : 'info',
    )
    return { error }
  }

  async #terminalEvent(row: ExecutionRecord, status: ExecutionStatus, fail: ExecutionFailure | null, exit: ExecutionExit, result: ExecutionResult): Promise<void> {
    const name = capabilityName(row)
    const data = { status, failure: fail, exit, evidence: result.evidenceRefs }
    if (status === 'succeeded') await this.#event(row, 'execution.completed', `${name} succeeded${result.summary ? `: ${result.summary}` : ''}`, data)
    else if (status === 'timed-out') await this.#event(row, 'execution.timed-out', `${name} timed out: ${fail?.message ?? ''}`, data, 'warn')
    else if (status === 'cancelled') await this.#event(row, 'execution.cancelled', `${name} cancelled${fail ? `: ${fail.message}` : ''}`, data, 'warn')
    else if (status === 'interrupted') await this.#event(row, 'execution.failed', `${name} interrupted: ${fail?.message ?? ''}`, data, 'warn')
    else await this.#event(row, 'execution.failed', `${name} failed (${fail?.kind ?? 'unknown'}): ${fail?.message ?? ''}`, data, 'error')
  }

  /** Watches the execution record for a cancellation and the engagement for a pause or closure. */
  async #watch(row: ExecutionRecord, polls: number, requestStop: (reason: StopReason) => void): Promise<void> {
    const current = await this.#executions.get(row.id)
    if (!current || isTerminalExecutionStatus(current.status)) return
    if (current.status === 'cancelling') return requestStop('cancel')
    if (polls % ENGAGEMENT_CHECK_EVERY !== 0 || current.status === 'finalizing') return
    const loaded = await this.#store.loadEngagement(row.engagementId)
    const status = loaded?.engagement.status
    if (loaded && status && !NOT_RUNNABLE_ENGAGEMENT.has(status)) return
    await requestExecutionCancel({ store: this.#store, executions: this.#executions }, row.id, RUNTIME_ACTOR, loaded ? `the engagement is ${status}` : 'the engagement no longer exists').then(
      () => requestStop('cancel'),
      () => undefined,
    )
  }

  // ── Recovery ──────────────────────────────────────────────────────────────────────────────────────

  /** Whether the worker recorded on an execution is still alive (PID + process start time on this host). */
  async #runnerAlive(row: ExecutionRecord): Promise<boolean> {
    const runner = row.runner
    if (!runner) return false
    if (runner.ownerId === OWNER_ID) return this.#active.has(row.id)
    const fresh = row.heartbeatAt !== null && this.#now().getTime() - row.heartbeatAt.getTime() < this.#staleAfterMs
    if (runner.host !== os.hostname()) return fresh
    const identity = await processIdentity(runner.pid)
    if (!identity) return false
    if (runner.processStartedAt) return Math.abs(identity.startedAt.getTime() - Date.parse(runner.processStartedAt)) <= 5_000
    return fresh
  }

  /**
   * Brings an execution whose worker is gone to a final state, conservatively and exactly once:
   * the execution is adopted with a guarded update (a second recovering worker loses the race), its
   * recorded processes are reconciled — still-running ones verified by PID + creation time and
   * terminated, dead ones closed — and then:
   *   finalizing with a stored result → completed work awaiting finalization: finished from the result;
   *   cancelling                       → the requested cancellation is completed;
   *   preparing / running              → interrupted. Never re-run (the work may have had effects).
   */
  async #reconcile(row: ExecutionRecord): Promise<ExecutionStatus | null> {
    const me = await this.runner()
    const adopted = await this.#executions.update(row.id, { from: [row.status], ...(row.runner ? { ownerId: row.runner.ownerId } : {}) }, { runner: me, heartbeatAt: this.#now() })
    if (!adopted) return null
    const processes = await reapStaleProcessesForExecution(row.id)
    const action = row.status === 'finalizing' && row.result ? 'finalized' : row.status === 'cancelling' ? 'cancelled' : 'interrupted'
    let snapshot: SecurityExecutionSnapshot | null = null
    let workspace: ExecutionWorkspace | null = null
    try {
      snapshot = verifyStoredSnapshot(row)
      workspace = new ExecutionWorkspace(this.#workspaceRoot(row.engagementId), row.id)
    } catch {
      // Finished without snapshot-dependent checks; the final state still records what happened.
    }
    const found = [
      processes.reaped ? `${processes.reaped} orphaned owned process${processes.reaped === 1 ? '' : 'es'} terminated` : null,
      processes.gone ? `${processes.gone} owned process${processes.gone === 1 ? '' : 'es'} already gone` : null,
    ].filter(Boolean)
    const what =
      action === 'finalized'
        ? 'its work had completed; finishing it'
        : action === 'cancelled'
          ? 'completing the requested cancellation'
          : `it was ${row.status} and is marked interrupted (never re-run)`
    await this.#event(
      row,
      'execution.recovered',
      `Recovered after its worker stopped: ${what}${found.length ? ` (${found.join(', ')})` : ''}`,
      {
        action,
        previousStatus: row.status,
        previousRunner: row.runner ? { host: row.runner.host, pid: row.runner.pid } : null,
        processes: { orphanedTerminated: processes.reaped, alreadyGone: processes.gone, heldByLiveInstance: processes.skipped },
      },
      'warn',
    )
    const state: RunState = {
      row: adopted,
      ownerId: me.ownerId,
      snapshot,
      workspace,
      prepared: null,
      registrar: null,
      processes: null,
      startedAtMs: row.startedAt?.getTime() ?? Date.now(),
      code: null,
      stopped: new Set(),
      reaped: processes.reaped,
      abandoned: false,
    }
    const empty = (fail: ExecutionFailure): ExecutionResult => ({
      outcome: 'cancelled',
      summary: null,
      output: null,
      failure: fail,
      evidenceRefs: row.result?.evidenceRefs ?? [],
      artifactBytes: row.result?.artifactBytes ?? 0,
      processesStarted: row.result?.processesStarted ?? processes.reaped + processes.gone,
      endedAt: this.#now().toISOString(),
    })
    const result =
      action === 'finalized'
        ? row.result!
        : action === 'cancelled'
          ? (row.result ?? empty(failure('cancelled', 'execution.cancelled', 'Cancelled on request')))
          : empty(failure('worker-interrupted', 'runtime.worker-interrupted', `The worker holding this execution stopped while it was ${row.status}`))
    return this.#settle(state, result)
  }

  #event(row: ExecutionRecord, type: ExecutionEventType, message: string, data: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') {
    return executionEvent(this.#store, row, type, message, data, level)
  }
}

/** The final state for a finished piece of work, given the state the execution is in now. */
export function finalStatus(current: ExecutionStatus, result: ExecutionResult, fail: ExecutionFailure | null, cleanupError: string | null): ExecutionStatus {
  if (cleanupError) return 'failed'
  if (current === 'cancelling') return fail?.kind === 'worker-interrupted' ? 'interrupted' : 'cancelled'
  if (fail?.kind === 'worker-interrupted') return 'interrupted'
  if (result.outcome === 'timeout') return 'timed-out'
  if (result.outcome === 'succeeded' && !fail) return 'succeeded'
  return 'failed'
}
