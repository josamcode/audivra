import os from 'node:os'
import { engagementWorkspaceDir, getConfig, type Logger } from '@audivra/config'
import {
  ACTIVE_EXECUTION_STATUSES,
  capabilityExecution,
  isTerminalExecutionStatus,
  redact,
  type ContainerFacts,
  type ExecutionExit,
  type NetworkFacts,
  type ExecutionMode,
  type ExecutionFailure,
  type ExecutionResult,
  type ExecutionRunner,
  type ExecutionStatus,
  type SecurityExecutionSnapshot,
} from '@audivra/contracts'
import { dockerImagePresent, killOwnedForExecution, liveOwnedForExecution, OWNER_ID, processIdentity, reapStaleProcessesForExecution, type OwnedProcessRecord } from '@audivra/tool-runtime'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import type { SecurityCapability } from '../capabilities/types.ts'
import { compact } from '../compact.ts'
import { systemResolver, type Resolver } from '../dns.ts'
import { AuthResolutionError, type ExecutionAuthResolver } from '../session/auth-resolver.ts'
import { checkExecutionResources, type ResourceCheck, type ResourceCheckInput } from '../resources.ts'
import type { SecurityStore } from '../store.ts'
import type { ArtifactRegistrar } from './artifacts.ts'
import { InProcessBackend, RUNTIME_HELPER_PREFIX, type BackendExit, type BackendRemains, type BackendSpec, type ExecutionBackend, type PreparedExecution, type RunningExecution } from './backend.ts'
import { requestExecutionCancel } from './control.ts'
import { executionEvent, RUNTIME_ACTOR, type ExecutionEventType } from './events.ts'
import { classifyFailure, ExecutionError, failure, failureMessage } from './failures.ts'
import { createExecutionHandles } from './handles.ts'
import type { ExecutionProcesses } from './processes.ts'
import { findApprovedRuntime, runtimeImageRef } from './runtimes.ts'
import { contextFromSnapshot, revalidateSnapshot, verifyStoredSnapshot } from './snapshot.ts'
import type { ExecutionQueue, ExecutionRecord, ExecutionStore } from './store.ts'
import { ExecutionWorkspace } from './workspace.ts'

/*
 * The execution runtime: runs one accepted execution from its stored snapshot, in the worker.
 *
 *   claim (queued → preparing, within the concurrency limit)
 *   → verify snapshot → resolve capability → revalidate authority → resource preflight
 *   → select the backend from the snapshot's execution mode (never a fallback)
 *   → workspace + backend.prepare → running → backend.start / observe
 *       ├─ work ends            → finalizing (result persisted)
 *       ├─ timeout (Audivra's)  → graceful stop → grace → terminate exact owned resources → finalizing
 *       └─ cancel requested     → cancelling → graceful stop → grace → terminate → …
 *   → artifact budget → cleanup (owned processes, containers, scratch space) → final state + events
 *
 * Every state change is a guarded update naming the states it may start from and the worker that must
 * hold the execution, so cancellation, crash recovery and duplicate deliveries cannot corrupt it.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Display name from the stored snapshot (falls back to the id if the snapshot is unreadable). */
const capabilityName = (row: ExecutionRecord) => (row.snapshot as Partial<SecurityExecutionSnapshot> | null)?.capability?.name ?? row.capabilityId
/** The execution mode recorded in a row's snapshot (a label only; the verified snapshot decides). */
const modeOf = (row: ExecutionRecord): ExecutionMode => (row.snapshot as Partial<SecurityExecutionSnapshot> | null)?.isolation?.mode ?? 'in-process'
/** Capability processes, as opposed to the backend's own helper processes (e.g. the docker CLI). */
const capabilityProcesses = (records: OwnedProcessRecord[]) => records.filter((p) => !p.tool.startsWith(RUNTIME_HELPER_PREFIX))
const ACTIVE = new Set<string>(ACTIVE_EXECUTION_STATUSES)
const NOT_RUNNABLE_ENGAGEMENT = new Set<string>(['paused', 'completed', 'cancelled', 'invalid'])
/** How often (in watcher polls) the engagement's lifecycle is checked while an execution runs. */
const ENGAGEMENT_CHECK_EVERY = 5

type StopReason = 'cancel' | 'timeout' | 'shutdown' | 'budget'
const STOP_MESSAGES: Record<StopReason, string> = {
  cancel: 'Cancelled',
  timeout: 'Timed out',
  shutdown: 'The worker is shutting down',
  budget: 'The artifact budget was exceeded',
}

export interface ExecutionRuntimeOptions {
  registry: CapabilityRegistry
  store: SecurityStore
  executions: ExecutionStore
  /** Re-queues queued executions whose job was lost (recovery). */
  queue?: ExecutionQueue
  /** The in-process backend (default: `InProcessBackend`). */
  backend?: ExecutionBackend
  /** Backends by execution mode. A mode without a backend is never run any other way. */
  backends?: Partial<Record<ExecutionMode, ExecutionBackend>>
  resolver?: Resolver
  workspaceRoot?: (engagementId: string) => string
  checkResources?: (input: ResourceCheckInput) => Promise<ResourceCheck>
  /** Resolves identity-aware session material at the trusted boundary (Phase 5 Step 3). */
  authResolver?: ExecutionAuthResolver
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
  /** Containers of final executions removed by name after their labels proved whose they were. */
  containersRemoved: string[]
  /** Labelled containers that could not be proven to belong to an execution of this database (left alone). */
  containersUntouched: string[]
}

interface RunState {
  row: ExecutionRecord
  ownerId: string
  snapshot: SecurityExecutionSnapshot | null
  workspace: ExecutionWorkspace | null
  prepared: PreparedExecution | null
  /** The backend chosen from the snapshot's execution mode. */
  backend: ExecutionBackend | null
  mode: ExecutionMode
  /** What the isolated backend observed of the execution's container. */
  container: ContainerFacts | null
  /** What the isolated backend observed of the execution's private network and gateway. */
  network: NetworkFacts | null
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
  readonly #backends: Partial<Record<ExecutionMode, ExecutionBackend>>
  readonly #resolver: Resolver
  readonly #authResolver: ExecutionAuthResolver | undefined
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
    this.#backends = { 'in-process': options.backend ?? new InProcessBackend(), ...options.backends }
    this.#resolver = options.resolver ?? systemResolver
    this.#authResolver = options.authResolver
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

  /** The execution modes this runtime can carry out. */
  get modes(): ExecutionMode[] {
    return Object.keys(this.#backends) as ExecutionMode[]
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
      backend: this.#backends['in-process']?.id ?? 'in-process',
    }))
    return this.#runner
  }

  /**
   * Job handler: runs a queued execution to a final state. A delivery for an execution that is not
   * queued never starts it again — an execution held by a worker that has died is reconciled instead.
   */
  async run(executionId: string): Promise<ExecutionStatus | null> {
    if (this.#active.has(executionId) || this.#stopping) return null
    const pending = await this.#executions.get(executionId)
    const identity = await this.runner()
    const runner = { ...identity, backend: pending ? (this.#backends[modeOf(pending)]?.id ?? modeOf(pending)) : identity.backend }
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
    const report: RecoveryReport = { requeued: [], reconciled: [], skipped: [], containersRemoved: [], containersUntouched: [] }
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
    await this.#reconcileOwnedResources(report)
    return report
  }

  /**
   * Resources (containers) a backend created for executions that are now final — e.g. left behind by a
   * crash between the final state and removal, or by a failed cleanup — are removed by exact name once
   * their labels and this database prove whose they are. Anything else is left alone.
   */
  async #reconcileOwnedResources(report: RecoveryReport): Promise<void> {
    for (const backend of new Set(Object.values(this.#backends))) {
      if (!backend?.ownedResources || !backend.removeOwnedResource) continue
      let resources
      try {
        resources = await backend.ownedResources()
      } catch (error) {
        this.#log?.warn({ err: error, backend: backend.id }, 'could not list execution containers; reconciliation deferred')
        continue
      }
      for (const resource of resources) {
        if (this.#active.has(resource.executionId)) continue
        const row = await this.#executions.get(resource.executionId)
        if (!row || row.engagementId !== resource.engagementId) {
          report.containersUntouched.push(resource.name)
          continue
        }
        if (!isTerminalExecutionStatus(row.status)) continue
        try {
          await backend.removeOwnedResource(resource)
          report.containersRemoved.push(resource.name)
          await this.#event(row, 'execution.recovered', `Removed container ${resource.name}, left behind after the execution ended`, { action: 'container-removed', container: resource.name, previousState: resource.state }, 'warn')
        } catch (error) {
          this.#log?.warn({ err: error, container: resource.name }, 'could not remove an execution container')
        }
      }
    }
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
      backend: null,
      mode: modeOf(row),
      container: null,
      network: null,
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
        void this.#watch(state, ++polls, requestStop).catch((error: unknown) => this.#log?.warn({ err: error, executionId: id }, 'execution watcher failed'))
      }, this.#pollMs),
    )
    const stop = new AbortController()
    const log = this.#log?.child({ executionId: id, capabilityId: row.capabilityId, engagementId: row.engagementId })

    try {
      await this.#event(row, 'execution.preparing', `Preparing ${capabilityName(row)}`, { backend: runner.backend, runner: { host: runner.host, pid: runner.pid } })
      log?.info('security execution preparing')
      let result: ExecutionResult | undefined
      let prepared: PreparedExecution | null = null
      try {
        prepared = await this.#prepare(state, stop, (ms) => timers.push(setTimeout(() => requestStop('timeout'), ms)))
      } catch (error) {
        result = this.#result(state, 'failed', error instanceof ExecutionError ? classifyFailure(error) : failure(state.backend?.mode === 'isolated-container' ? 'runtime-failed' : 'preflight-failed', 'preflight.error', failureMessage(error)))
      }
      if (prepared) {
        if (stopReason) result = this.#stopResult(state, stopReason)
        else if (!(await this.#executions.update(id, { from: ['preparing'], ownerId: runner.ownerId }, { status: 'running' }))) {
          // Cancelled (or adopted) while preparing.
          result = this.#stopResult(state, 'cancel')
        } else {
          const s = state.snapshot!
          await this.#event(row, 'execution.started', `${s.capability.name} started`, {
            backend: state.backend!.id,
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
    const backend = this.#select(snapshot, capability)
    state.backend = backend
    state.mode = backend.mode
    const input = capability.implementation.input.safeParse(snapshot.input)
    if (!input.success) throw new ExecutionError('preflight-failed', 'execution.input-invalid', `The stored input no longer matches ${capability.metadata.id}: ${input.error.issues[0]?.message ?? 'invalid'}`)
    const refusal = revalidateSnapshot(snapshot, await this.#store.loadEngagement(row.engagementId), this.#now())
    if (refusal) throw refusal
    const workspace = new ExecutionWorkspace(this.#workspaceRoot(row.engagementId), row.id)
    state.workspace = workspace
    const runtime = snapshot.isolation?.runtime ? findApprovedRuntime(snapshot.isolation.runtime.id) : null
    const resources = await this.#checkResources({
      capability: capability.metadata,
      workspaceRoot: workspace.root,
      minFreeBytes: getConfig().SECURITY_MIN_FREE_DISK_MB * 1_048_576,
      maxArtifactBytes: snapshot.limits.maxArtifactMb * 1_048_576,
      imagePresent: dockerImagePresent,
      runtime,
    })
    if (!resources.ok) throw new ExecutionError(resources.rule === 'resources.runtime-unavailable' ? 'runtime-unavailable' : 'preflight-failed', resources.rule, resources.reason)
    // Identity-aware execution (Phase 5 Step 3): resolve the session's auth material at the trusted boundary.
    let auth: { headers: Record<string, string>; origin: string } | null = null
    if (snapshot.identity?.sessionRef) {
      try {
        auth = this.#authResolver ? await this.#authResolver.resolve(snapshot) : null
      } catch (error) {
        const kind = error instanceof AuthResolutionError ? error.kind : 'session-invalid'
        throw new ExecutionError('preflight-failed', `execution.${kind}`, error instanceof Error ? error.message : String(error))
      }
    }
    const spec = this.#spec(state, snapshot, capability, input.data, workspace, stop, auth)
    const prepared = await backend.prepare(spec)
    state.prepared = prepared
    return prepared
  }

  /** Everything a backend gets for one execution, built from the verified snapshot only. */
  #spec(state: RunState, snapshot: SecurityExecutionSnapshot, capability: SecurityCapability, input: unknown, workspace: ExecutionWorkspace, stop: AbortController, auth: { headers: Record<string, string>; origin: string } | null = null): BackendSpec {
    const sensor = capability.metadata.sensor ? { tool: capability.metadata.sensor.tool, toolVersion: snapshot.isolation?.runtime?.image ?? `${snapshot.capability.id}@${snapshot.capability.version}` } : null
    const { handles, registrar, processes } = createExecutionHandles(snapshot, { workspace, signal: stop.signal, resolver: this.#resolver, store: this.#store, sensor, auth })
    state.registrar = registrar
    state.processes = processes
    return {
      executionId: state.row.id,
      snapshot,
      capability,
      context: contextFromSnapshot(snapshot),
      input,
      handles,
      workspace,
      stop,
      events: (type, message, data, level) => this.#event(state.row, type, message, data, level),
    }
  }

  /**
   * The backend for an execution comes from its trusted snapshot, which must agree with the registered
   * capability and the approved runtime registry. There is no fallback: a mode this worker cannot carry
   * out fails the execution instead of running it any other way.
   */
  #select(snapshot: SecurityExecutionSnapshot, capability: SecurityCapability): ExecutionBackend {
    const declared = capabilityExecution(capability.metadata)
    const recorded = snapshot.isolation ?? { mode: 'in-process' as const, runtime: null }
    if (declared.mode !== recorded.mode || declared.runtime !== (recorded.runtime?.id ?? null)) {
      throw new ExecutionError('preflight-failed', 'execution.capability-changed', `${capability.metadata.id} changed its execution mode after the decision (${recorded.mode} → ${declared.mode})`)
    }
    if (recorded.runtime) {
      const runtime = findApprovedRuntime(recorded.runtime.id)
      if (!runtime || runtime.version !== recorded.runtime.version || runtimeImageRef(runtime) !== recorded.runtime.image) {
        throw new ExecutionError('preflight-failed', 'execution.runtime-changed', `The approved runtime ${recorded.runtime.id} changed after the decision; request the execution again`)
      }
    }
    const backend = this.#backends[recorded.mode]
    if (!backend || backend.mode !== recorded.mode) {
      throw new ExecutionError('runtime-unavailable', 'runtime.backend-unavailable', `This worker cannot run ${recorded.mode} executions; the execution is never run any other way`)
    }
    return backend
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
    const backend = state.backend!
    const running = await backend.start(prepared)
    const raced = await Promise.race([backend.observe(running).then((exit) => ({ exit })), stopped.then((reason) => ({ reason }))])
    if ('exit' in raced) {
      state.registrar?.close()
      state.code = raced.exit.code
      if (raced.exit.container) state.container = raced.exit.container
      if (raced.exit.network) state.network = raced.exit.network
      return raced.exit.status === 'succeeded'
        ? this.#result(state, 'succeeded', null, raced.exit.summary, raced.exit.output)
        : this.#result(state, 'failed', classifyFailure(raced.exit.error))
    }
    // Audivra stops the work: graceful request first, then exact termination of owned resources.
    const reason = raced.reason
    const settled = await this.#stop(state, backend, running, STOP_MESSAGES[reason])
    // Code that ignored the stop request is abandoned (its handles are revoked); never wait on it.
    state.abandoned = !settled
    return this.#stopResult(state, reason)
  }

  /** Graceful stop, the grace period, then exact termination. Resolves whether the work settled. */
  async #stop(state: RunState, backend: ExecutionBackend, running: RunningExecution, message: string): Promise<boolean> {
    for (const process of capabilityProcesses(liveOwnedForExecution(state.row.id))) state.stopped.add(process.id)
    const observed = (exit: BackendExit) => {
      if (exit.container) state.container = exit.container
      if (exit.network) state.network = exit.network
      return true
    }
    await backend.cancel(running, message)
    const grace = this.#graceMs ?? (state.snapshot?.runtime.cancelGraceSeconds ?? 5) * 1000
    const settled = await Promise.race([backend.observe(running).then(observed), sleep(grace).then(() => false)])
    state.registrar?.close()
    await backend.terminate(running)
    return settled || (await Promise.race([backend.observe(running).then(observed), sleep(5000).then(() => false)]))
  }

  #stopResult(state: RunState, reason: StopReason): ExecutionResult {
    if (reason === 'timeout') {
      return this.#result(state, 'timeout', failure('timeout', 'runtime.timeout', `Stopped by Audivra after the ${state.snapshot?.runtime.timeoutSeconds ?? '?'} s execution limit`))
    }
    if (reason === 'shutdown') return this.#result(state, 'cancelled', failure('worker-interrupted', 'runtime.shutdown', 'The worker shut down while the execution was in progress'))
    if (reason === 'budget') {
      return this.#result(state, 'failed', failure('artifact-limit', 'artifact.budget-exceeded', `Stopped by Audivra: the execution's files exceeded its ${state.snapshot?.runtime.maxArtifactBytes ?? '?'} byte artifact budget`))
    }
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
      runtime: { backend: state.mode, container: state.container, network: state.network },
    }
    const now = this.#now()
    const done = await this.#executions.update(id, { from: [current], ownerId }, { status, finishedAt: now, heartbeatAt: now, exit, failure: fail })
    if (!done) return (await this.#executions.get(id))?.status ?? current
    if (state.network) {
      const d = state.network.decisions
      await this.#event(
        row,
        'execution.network-summary',
        d ? `Network: ${d.allowed} allowed, ${d.denied} denied of ${d.requested} request${d.requested === 1 ? '' : 's'}` : 'Network: the gateway recorded no decisions',
        { gateway: state.network.gateway, networks: state.network.networks, decisions: d },
        d && d.denied > 0 ? 'warn' : 'info',
      )
    }
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
    await this.#event(row, 'execution.cleanup-started', `Cleaning up owned processes${state.mode === 'isolated-container' ? ', the execution container' : ''} and scratch space`)
    const leftovers = capabilityProcesses(liveOwnedForExecution(row.id))
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
      if (state.prepared && state.backend) {
        const cleaned = await state.backend.cleanup(state.prepared)
        removedBytes = cleaned.removedBytes
        if (cleaned.container) state.container = cleaned.container
        if (cleaned.network) state.network = cleaned.network
      } else if (state.workspace) removedBytes = (await state.workspace.cleanup()).removedBytes
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

  /**
   * Watches the execution record for a cancellation, its workspace for the artifact budget (no backend can
   * quota a bind-mounted directory, so Audivra measures it) and the engagement for a pause or closure.
   */
  async #watch(state: RunState, polls: number, requestStop: (reason: StopReason) => void): Promise<void> {
    const { row } = state
    const current = await this.#executions.get(row.id)
    if (!current || isTerminalExecutionStatus(current.status)) return
    if (current.status === 'cancelling') return requestStop('cancel')
    if (polls % ENGAGEMENT_CHECK_EVERY !== 0 || current.status === 'finalizing') return
    if (current.status === 'running' && state.workspace && state.snapshot && (await state.workspace.artifactBytes()) > state.snapshot.runtime.maxArtifactBytes) {
      return requestStop('budget')
    }
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
   * terminated, dead ones closed — what its backend still holds (an isolated execution's container) is
   * found without changing anything, and then:
   *   finalizing with a stored result     → completed work awaiting finalization: finished from the result;
   *   cancelling                          → the requested cancellation is completed;
   *   container exited, never finalized   → its output is collected through the validated pipeline;
   *   container still running             → stopped exactly and marked interrupted;
   *   preparing / running otherwise       → interrupted. Never re-run (the work may have had effects).
   */
  async #reconcile(row: ExecutionRecord): Promise<ExecutionStatus | null> {
    const me = await this.runner()
    const adopted = await this.#executions.update(
      row.id,
      { from: [row.status], ...(row.runner ? { ownerId: row.runner.ownerId } : {}) },
      { runner: { ...me, backend: row.runner?.backend ?? me.backend }, heartbeatAt: this.#now() },
    )
    if (!adopted) return null
    const processes = await reapStaleProcessesForExecution(row.id)
    const state: RunState = {
      row: adopted,
      ownerId: me.ownerId,
      snapshot: null,
      workspace: null,
      prepared: null,
      backend: null,
      mode: modeOf(row),
      container: null,
      network: null,
      registrar: null,
      processes: null,
      startedAtMs: row.startedAt?.getTime() ?? Date.now(),
      code: null,
      stopped: new Set(),
      reaped: processes.reaped,
      abandoned: false,
    }
    try {
      state.snapshot = verifyStoredSnapshot(row)
      state.workspace = new ExecutionWorkspace(this.#workspaceRoot(row.engagementId), row.id)
    } catch {
      // Finished without snapshot-dependent checks; the final state still records what happened.
    }

    // What an isolated backend still holds for the execution — found, not changed.
    let remains: BackendRemains | null = null
    let collectable = false
    const backend = this.#backends[state.mode]
    if (state.snapshot && state.workspace && backend && backend.mode !== 'in-process') {
      let capability = this.#registry.get(state.snapshot.capability.id)
      let input: unknown = state.snapshot.input
      try {
        capability = this.#capability(state.snapshot)
        const parsed = capability.implementation.input.safeParse(state.snapshot.input)
        collectable = parsed.success
        if (parsed.success) input = parsed.data
      } catch {
        // A capability that changed since the decision is never used to collect output; its container is still stopped and removed.
      }
      if (capability) {
        try {
          state.backend = backend
          remains = await backend.resume(this.#spec(state, state.snapshot, capability, input, state.workspace, new AbortController()))
          state.prepared = remains.prepared
        } catch (error) {
          if (error instanceof ExecutionError && error.kind === 'runtime-unavailable') {
            // Docker cannot be asked right now: leave the execution for the next reconciliation.
            this.#log?.warn({ err: error, executionId: row.id }, 'execution reconciliation deferred: its runtime is not reachable')
            return null
          }
          this.#log?.warn({ err: error, executionId: row.id }, 'could not inspect what the execution left behind')
        }
      }
    }

    const container = remains && remains.state !== 'none' ? remains.state : null
    const action =
      row.status === 'finalizing' && row.result
        ? 'finalized'
        : row.status === 'cancelling'
          ? 'cancelled'
          : container === 'exited' && collectable
            ? 'collected'
            : 'interrupted'
    const found = [
      processes.reaped ? `${processes.reaped} orphaned owned process${processes.reaped === 1 ? '' : 'es'} terminated` : null,
      processes.gone ? `${processes.gone} owned process${processes.gone === 1 ? '' : 'es'} already gone` : null,
      container === 'running' ? 'its container was still running and is stopped' : null,
      container === 'created' ? 'its container was created but never started' : null,
      container === 'missing' ? 'its container no longer exists' : null,
    ].filter(Boolean)
    const what =
      action === 'finalized'
        ? 'its work had completed; finishing it'
        : action === 'cancelled'
          ? 'completing the requested cancellation'
          : action === 'collected'
            ? 'its container had finished; collecting its output'
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
        container,
      },
      'warn',
    )

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
    if (container === 'running' && remains?.running && state.backend) {
      await this.#stop(state, state.backend, remains.running, 'The worker holding this execution stopped')
    }
    let result: ExecutionResult
    if (action === 'finalized') result = row.result!
    else if (action === 'cancelled') result = row.result ?? empty(failure('cancelled', 'execution.cancelled', 'Cancelled on request'))
    else if (action === 'collected' && remains?.running && state.backend) {
      const exit = await state.backend.observe(remains.running)
      state.registrar?.close()
      state.code = exit.code
      if (exit.container) state.container = exit.container
      if (exit.network) state.network = exit.network
      result = exit.status === 'succeeded' ? this.#result(state, 'succeeded', null, exit.summary, exit.output) : this.#result(state, 'failed', classifyFailure(exit.error))
    } else {
      result = empty(failure('worker-interrupted', 'runtime.worker-interrupted', `The worker holding this execution stopped while it was ${row.status}${container === 'missing' ? ' and its container no longer exists' : ''}`))
    }
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
