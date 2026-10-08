import { readFile } from 'node:fs/promises'
import { redact, type ContainerFacts, type ContainerLimits } from '@audivra/contracts'
import { runProcess } from '@audivra/tool-runtime'
import { RUNTIME_HELPER_PREFIX, type BackendExit, type BackendRemains, type BackendSpec, type ExecutionBackend, type OwnedResource, type PreparedExecution, type RunningExecution } from './backend.ts'
import { executorProgramPath } from './executors.ts'
import { ExecutionError, failureMessage } from './failures.ts'
import { findApprovedRuntime, runtimeImageRef, runtimePullHint } from './runtimes.ts'

/*
 * The isolated container backend: runs a capability's reviewed executor program in an approved runtime,
 * inside a container that belongs to exactly one execution.
 *
 *   identity   name audivra-<execution id> (derived, never chosen) + ownership labels
 *   filesystem read-only root; only this execution's inputs/ (read-only), outputs/ and artifacts/
 *              mounted; a small private tmpfs at /tmp. No repository, home, Docker socket or host paths.
 *   privileges non-root user, every capability dropped, no-new-privileges, default seccomp, private
 *              PID/IPC namespaces, no network (`--network none`), init process for clean signals
 *   limits     memory (no swap), CPUs, PIDs and tmpfs from the snapshot; wall-clock timeout and artifact
 *              budget enforced by the runtime
 *
 * The worker alone talks to Docker, through the docker CLI as owned helper processes. Containers are only
 * ever stopped or removed by their exact name after their labels prove they belong to that execution.
 * Executor output is bounded: the program writes into the workspace, the result file is read with a size
 * limit, container output is capped and kept as a workspace file; evidence is registered on the host by
 * the capability's `collect` step through the validated registrar — never by the container.
 */

/** Ownership labels on every execution container (identifiers only — never secrets). */
export const CONTAINER_LABEL = {
  owner: 'audivra.owner',
  execution: 'audivra.execution',
  engagement: 'audivra.engagement',
  capability: 'audivra.capability',
  runtime: 'audivra.runtime',
} as const
export const CONTAINER_OWNER = 'security-execution'

/** Owner tool of the docker CLI helper processes (platform helpers, not capability processes). */
export const RUNTIME_HELPER_TOOL = `${RUNTIME_HELPER_PREFIX}docker`

const EXECUTION_ID = /^sx_[0-9a-z]{14}$/
const LOG_LIMIT_BYTES = 64 * 1024
const RESULT_LIMIT_BYTES = 64 * 1024
const CONTAINER_ROOT = '/audivra'
const PROGRAM_PATH = `${CONTAINER_ROOT}/inputs/program/main.mjs`

/** The container of an execution: derived from its id, so it is known without being stored. */
export function containerNameFor(executionId: string): string {
  if (!EXECUTION_ID.test(executionId)) throw new ExecutionError('runtime-failed', 'container.invalid-id', `Invalid execution id: ${executionId}`)
  return `audivra-${executionId.replace('_', '-')}`
}

/** Non-root user for executor containers: the worker's own uid on POSIX hosts (so files stay its own), else 1000. */
export function defaultContainerUser(): string {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) return '1000:1000'
  return uid === 0 ? '65534:65534' : `${uid}:${gid}`
}

export interface ContainerSpec {
  name: string
  labels: Record<string, string>
  /** Exact image reference (repository pinned by digest). */
  image: string
  command: readonly string[]
  limits: ContainerLimits
  user: string
  /** Host paths of the execution's areas. */
  mounts: { inputs: string; outputs: string; artifacts: string }
}

/** `docker create` arguments for an execution container — the complete security profile, in one place. */
export function containerCreateArgs(spec: ContainerSpec): string[] {
  for (const source of Object.values(spec.mounts)) {
    if (/[,"\n]/.test(source)) throw new ExecutionError('runtime-failed', 'container.mount-path', `Workspace path cannot be mounted safely: ${source}`)
  }
  if (/^(0|root)(:|$)/.test(spec.user)) throw new ExecutionError('runtime-failed', 'container.root-user', 'Executor containers never run as root')
  const { limits, mounts } = spec
  return [
    'create',
    '--name', spec.name,
    ...Object.entries(spec.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '--init',
    '--network', 'none',
    '--read-only',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsMb}m`,
    '--user', spec.user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(limits.pidsLimit),
    '--memory', `${limits.memoryMb}m`,
    '--memory-swap', `${limits.memoryMb}m`,
    '--cpus', String(limits.cpus),
    '--ipc', 'private',
    '--hostname', 'audivra-executor',
    '--restart', 'no',
    '--log-driver', 'json-file',
    '--log-opt', 'max-size=1m',
    '--log-opt', 'max-file=1',
    '--workdir', CONTAINER_ROOT,
    '--mount', `type=bind,source=${mounts.inputs},target=${CONTAINER_ROOT}/inputs,readonly`,
    '--mount', `type=bind,source=${mounts.outputs},target=${CONTAINER_ROOT}/outputs`,
    '--mount', `type=bind,source=${mounts.artifacts},target=${CONTAINER_ROOT}/artifacts`,
    spec.image,
    ...spec.command,
  ]
}

export interface DockerResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

/** Runs one docker CLI command as an owned helper process of the execution (in memory unless persisted). */
export type DockerCli = (args: string[], options: { executionId?: string; timeoutMs?: number; persist?: boolean; maxBuffer?: number }) => Promise<DockerResult>

export const dockerCli: DockerCli = async (args, options) => {
  const result = await runProcess({
    command: 'docker',
    args,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxBuffer: options.maxBuffer ?? 1_048_576,
    persist: options.persist ?? false,
    owner: { tool: RUNTIME_HELPER_TOOL, securityExecutionId: options.executionId ?? null },
  })
  return { ok: !result.failed && result.exitCode === 0, code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

type Inspected =
  | { kind: 'absent' }
  | { kind: 'foreign' }
  | { kind: 'error'; message: string }
  | { kind: 'owned'; state: string; exitCode: number | null; oomKilled: boolean; startedAt: string | null; finishedAt: string | null }

class ContainerPrepared implements PreparedExecution {
  stopRequested = false
  readonly facts: ContainerFacts

  constructor(
    readonly spec: BackendSpec,
    readonly name: string,
  ) {
    this.facts = { name, exitCode: null, oomKilled: false, startedAt: null, finishedAt: null, removed: false }
  }
}

/** A run whose exit is observed on first access (never at creation). */
function lazyRun(prepared: PreparedExecution, observe: () => Promise<BackendExit>): RunningExecution {
  let exit: Promise<BackendExit> | null = null
  return {
    prepared,
    get exit() {
      exit ??= observe()
      return exit
    },
  }
}

const firstLine = (text: string) => redact(text.trim().split(/\r?\n/)[0] ?? '').slice(0, 300)
const timestamp = (value: unknown) => (typeof value === 'string' && !value.startsWith('0001-') ? value : null)

export class IsolatedContainerBackend implements ExecutionBackend {
  readonly id = 'isolated-container'
  readonly mode = 'isolated-container' as const
  readonly #docker: DockerCli
  readonly #user: string

  constructor(options: { docker?: DockerCli; user?: string } = {}) {
    this.#docker = options.docker ?? dockerCli
    this.#user = options.user ?? defaultContainerUser()
  }

  async prepare(spec: BackendSpec): Promise<PreparedExecution> {
    const { snapshot, executionId, workspace } = spec
    const isolation = snapshot.isolation
    if (isolation?.mode !== 'isolated-container' || !isolation.runtime || !isolation.container) {
      throw new ExecutionError('runtime-failed', 'runtime.wrong-backend', `${snapshot.capability.id} is not an isolated-container execution`)
    }
    const runtime = findApprovedRuntime(isolation.runtime.id)
    if (!runtime || runtime.version !== isolation.runtime.version || runtimeImageRef(runtime) !== isolation.runtime.image) {
      throw new ExecutionError('preflight-failed', 'execution.runtime-changed', `The approved runtime ${isolation.runtime.id} changed after the decision`)
    }
    const implementation = spec.capability.implementation
    const programFile = executorProgramPath(implementation.program)
    if (!programFile || typeof implementation.programInput !== 'function') {
      throw new ExecutionError('runtime-failed', 'runtime.program-missing', `${snapshot.capability.id} has no reviewed executor program`)
    }
    const name = containerNameFor(executionId)
    const prepared = new ContainerPrepared(spec, name)
    await spec.events('execution.container-preparing', `Preparing the isolated runtime ${runtime.name} v${runtime.version}`, {
      runtime: runtime.id,
      network: isolation.network,
      limits: isolation.container,
    })

    // Docker reachable and the pinned image present — images are never pulled here.
    const image = await this.#docker(['image', 'inspect', isolation.runtime.image, '--format', '{{.Id}}'], { executionId, timeoutMs: 30_000 })
    if (!image.ok) {
      throw new ExecutionError('runtime-unavailable', 'runtime.image-unavailable', `${runtime.name} is not available (Docker not reachable or image missing): ${runtimePullHint(runtime)}`)
    }

    // Inputs are staged before start and mounted read-only: the minimum the program needs, never the
    // trusted configuration, and the reviewed program itself.
    await workspace.init()
    await workspace.write('inputs', 'input.json', JSON.stringify(implementation.programInput(spec.context, spec.input)))
    await workspace.write('inputs', 'program/main.mjs', await readFile(programFile))

    // A container already carrying this execution's name and labels can only be its own leftover.
    const existing = await this.#inspect(name, executionId, snapshot.engagement.id)
    if (existing.kind === 'foreign') throw new ExecutionError('runtime-failed', 'container.name-conflict', `A container named ${name} exists that does not belong to this execution; it was left untouched`)
    if (existing.kind === 'error') throw new ExecutionError('runtime-unavailable', 'runtime.docker-unavailable', `Docker did not answer: ${existing.message}`)
    if (existing.kind === 'owned') await this.#docker(['rm', '--force', name], { executionId, timeoutMs: 60_000 })

    const created = await this.#docker(
      containerCreateArgs({
        name,
        labels: {
          [CONTAINER_LABEL.owner]: CONTAINER_OWNER,
          [CONTAINER_LABEL.execution]: executionId,
          [CONTAINER_LABEL.engagement]: snapshot.engagement.id,
          [CONTAINER_LABEL.capability]: snapshot.capability.id,
          [CONTAINER_LABEL.runtime]: `${runtime.id}@${runtime.version}`,
        },
        image: isolation.runtime.image,
        command: [...runtime.command, PROGRAM_PATH],
        limits: isolation.container,
        user: this.#user,
        mounts: { inputs: workspace.area('inputs'), outputs: workspace.area('outputs'), artifacts: workspace.area('artifacts') },
      }),
      { executionId, timeoutMs: 60_000 },
    )
    if (!created.ok) throw new ExecutionError('runtime-failed', 'container.create-failed', `The execution container could not be created: ${firstLine(created.stderr)}`)
    await spec.events('execution.container-created', `Container ${name} created`, { container: name, runtime: runtime.id, user: this.#user })
    return prepared
  }

  async start(prepared: PreparedExecution): Promise<RunningExecution> {
    const p = this.#prepared(prepared)
    const executionId = p.spec.executionId
    const started = await this.#docker(['start', p.name], { executionId, timeoutMs: 60_000 })
    if (!started.ok) throw new ExecutionError('runtime-failed', 'container.start-failed', `The execution container could not be started: ${firstLine(started.stderr)}`)
    await p.spec.events('execution.container-started', `Container ${p.name} started`, { container: p.name })
    return { prepared: p, exit: this.#wait(p) }
  }

  observe(running: RunningExecution): Promise<BackendExit> {
    return running.exit
  }

  async cancel(running: RunningExecution, reason: string): Promise<void> {
    const p = this.#prepared(running.prepared)
    p.stopRequested = true
    await p.spec.events('execution.container-stop-requested', `Graceful stop requested for ${p.name}: ${reason}`, { container: p.name, reason }, 'warn')
    // SIGTERM through the container's init: the program may flush partial output before it exits.
    await this.#docker(['kill', '--signal', 'SIGTERM', p.name], { executionId: p.spec.executionId, timeoutMs: 30_000 })
  }

  async terminate(running: RunningExecution): Promise<{ terminated: number }> {
    const p = this.#prepared(running.prepared)
    p.stopRequested = true
    const found = await this.#inspect(p.name, p.spec.executionId, p.spec.snapshot.engagement.id)
    if (found.kind !== 'owned' || !['running', 'created', 'paused', 'restarting'].includes(found.state)) return { terminated: 0 }
    const killed = await this.#docker(['kill', p.name], { executionId: p.spec.executionId, timeoutMs: 30_000 })
    await p.spec.events('execution.container-terminated', `Container ${p.name} terminated by Audivra`, { container: p.name, ok: killed.ok }, 'warn')
    return { terminated: killed.ok ? 1 : 0 }
  }

  async cleanup(prepared: PreparedExecution): Promise<{ removedBytes: number; container?: ContainerFacts }> {
    const p = this.#prepared(prepared)
    const errors: string[] = []
    const found = await this.#inspect(p.name, p.spec.executionId, p.spec.snapshot.engagement.id)
    if (found.kind === 'error') errors.push(`Docker did not answer: ${found.message}`)
    else if (found.kind === 'foreign') errors.push(`a container named ${p.name} is not labelled as this execution's own and was left untouched`)
    else if (found.kind === 'owned') {
      const removed = await this.#docker(['rm', '--force', p.name], { executionId: p.spec.executionId, timeoutMs: 60_000 })
      const after = await this.#inspect(p.name, p.spec.executionId, p.spec.snapshot.engagement.id)
      if (after.kind === 'absent') {
        p.facts.removed = true
        await p.spec.events('execution.container-removed', `Container ${p.name} removed`, { container: p.name })
      } else {
        const reason = removed.ok ? 'it still exists after removal' : firstLine(removed.stderr)
        errors.push(`container ${p.name} could not be removed: ${reason}`)
        await p.spec.events('execution.container-cleanup-failed', `Container ${p.name} could not be removed: ${reason}`, { container: p.name }, 'error')
      }
    } else p.facts.removed = true
    const { removedBytes } = await p.spec.workspace.cleanup()
    if (errors.length) throw new Error(errors.join('; '))
    return { removedBytes, container: { ...p.facts } }
  }

  async resume(spec: BackendSpec): Promise<BackendRemains> {
    const p = new ContainerPrepared(spec, containerNameFor(spec.executionId))
    const found = await this.#inspect(p.name, spec.executionId, spec.snapshot.engagement.id)
    if (found.kind === 'error') throw new ExecutionError('runtime-unavailable', 'runtime.docker-unavailable', `Docker did not answer: ${found.message}`)
    if (found.kind !== 'owned') return { prepared: p, state: 'missing', running: null }
    this.#record(p, found)
    if (found.state === 'created') return { prepared: p, state: 'created', running: null }
    if (found.state === 'removing') return { prepared: p, state: 'missing', running: null }
    // Observed only when the runtime asks: resuming itself waits for, reads and records nothing.
    const live = ['running', 'paused', 'restarting'].includes(found.state)
    return { prepared: p, state: live ? 'running' : 'exited', running: lazyRun(p, () => (live ? this.#wait(p) : this.#finish(p))) }
  }

  async ownedResources(): Promise<OwnedResource[]> {
    const listed = await this.#docker(
      ['ps', '--all', '--no-trunc', '--filter', `label=${CONTAINER_LABEL.owner}=${CONTAINER_OWNER}`, '--format', `{{.Names}}\t{{.Label "${CONTAINER_LABEL.execution}"}}\t{{.Label "${CONTAINER_LABEL.engagement}"}}\t{{.State}}`],
      { timeoutMs: 30_000 },
    )
    if (!listed.ok) throw new ExecutionError('runtime-unavailable', 'runtime.docker-unavailable', `Docker did not answer: ${firstLine(listed.stderr)}`)
    return parseOwnedContainers(listed.stdout)
  }

  async removeOwnedResource(resource: OwnedResource): Promise<void> {
    const found = await this.#inspect(resource.name, resource.executionId, resource.engagementId)
    if (found.kind === 'absent') return
    if (found.kind !== 'owned') throw new Error(`${resource.name} could not be proven to belong to execution ${resource.executionId}; left untouched`)
    const removed = await this.#docker(['rm', '--force', resource.name], { executionId: resource.executionId, timeoutMs: 60_000 })
    const after = await this.#inspect(resource.name, resource.executionId, resource.engagementId)
    if (after.kind !== 'absent') throw new Error(`${resource.name} could not be removed: ${removed.ok ? 'it still exists' : firstLine(removed.stderr)}`)
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  #prepared(prepared: PreparedExecution): ContainerPrepared {
    if (!(prepared instanceof ContainerPrepared)) throw new ExecutionError('runtime-failed', 'runtime.wrong-backend', 'Not an isolated-container execution')
    return prepared
  }

  /** Waits for the container to exit (an owned, persisted helper process), then observes it. */
  async #wait(p: ContainerPrepared): Promise<BackendExit> {
    await this.#docker(['wait', p.name], { executionId: p.spec.executionId, timeoutMs: 0, persist: true })
    return this.#finish(p)
  }

  /** Collects a finished container: state, bounded output, and — unless Audivra stopped it — the result. */
  async #finish(p: ContainerPrepared): Promise<BackendExit> {
    const { spec } = p
    const found = await this.#inspect(p.name, spec.executionId, spec.snapshot.engagement.id)
    if (found.kind === 'owned') this.#record(p, found)
    if (found.kind !== 'owned' || ['running', 'created', 'paused', 'restarting'].includes(found.state)) {
      return { status: 'failed', error: new ExecutionError('runtime-failed', 'container.observe-failed', `The execution container could not be observed (${found.kind === 'owned' ? found.state : found.kind})`), code: null, container: { ...p.facts } }
    }
    const code = found.exitCode
    const logs = await this.#docker(['logs', '--tail', '400', p.name], { executionId: spec.executionId, timeoutMs: 30_000, maxBuffer: 4 * LOG_LIMIT_BYTES })
    const text = [logs.stdout, logs.stderr].filter(Boolean).join('\n')
    const bounded = text.length > LOG_LIMIT_BYTES ? text.slice(-LOG_LIMIT_BYTES) : text
    const logPath = bounded.trim() ? spec.workspace.relative(await spec.workspace.write('outputs', 'container.log', bounded)) : null
    const durationMs = p.facts.startedAt && p.facts.finishedAt ? Math.max(0, Date.parse(p.facts.finishedAt) - Date.parse(p.facts.startedAt)) : 0
    await spec.events(
      'execution.container-exited',
      `Container ${p.name} exited with code ${code ?? 'unknown'}${found.oomKilled ? ' (memory limit reached)' : ''}`,
      { container: p.name, exitCode: code, oomKilled: found.oomKilled, durationMs },
      code === 0 ? 'info' : 'warn',
    )
    const exit = (status: 'failed', error: unknown): BackendExit => ({ status, error, code, container: { ...p.facts } })
    if (p.stopRequested) return exit('failed', new ExecutionError('cancelled', 'container.stopped', 'The container was stopped by Audivra'))
    const limits = spec.snapshot.isolation?.container
    if (found.oomKilled) return exit('failed', new ExecutionError('resource-limit', 'container.memory-limit', `The executor exceeded its ${limits?.memoryMb ?? '?'} MB memory limit`))
    if (code !== 0) return exit('failed', new ExecutionError('executor-failed', 'container.exit-code', `The executor exited with code ${code ?? 'unknown'}: ${firstLine(bounded.split(/\r?\n/).filter(Boolean).at(-1) ?? '')}`))
    let result: unknown
    try {
      const raw = await spec.workspace.readBounded('outputs', 'result.json', RESULT_LIMIT_BYTES)
      result = raw === null ? null : JSON.parse(raw)
    } catch {
      result = null
    }
    const collect = spec.capability.implementation.collect
    if (typeof collect !== 'function') return exit('failed', new ExecutionError('runtime-failed', 'runtime.program-missing', 'No collect step'))
    try {
      const collected = await collect.call(spec.capability.implementation, spec.context, spec.input, { exitCode: 0, result, log: { bytes: Buffer.byteLength(bounded), tail: redact(bounded.slice(-1000)), path: logPath }, durationMs }, spec.handles)
      return { status: 'succeeded', output: collected.output, summary: collected.summary, code, container: { ...p.facts } }
    } catch (error) {
      return exit('failed', error)
    }
  }

  #record(p: ContainerPrepared, found: Extract<Inspected, { kind: 'owned' }>): void {
    p.facts.exitCode = found.exitCode
    p.facts.oomKilled = found.oomKilled
    p.facts.startedAt = found.startedAt
    p.facts.finishedAt = found.finishedAt
  }

  /** Inspects a container by exact name and proves (by labels) whose it is. */
  async #inspect(name: string, executionId: string, engagementId: string): Promise<Inspected> {
    const result = await this.#docker(['inspect', '--type', 'container', '--format', '{{json .}}', name], { executionId, timeoutMs: 30_000 })
    if (!result.ok) return /no such (container|object)/i.test(result.stderr) ? { kind: 'absent' } : { kind: 'error', message: firstLine(result.stderr || 'docker inspect failed') }
    let info: { State?: Record<string, unknown>; Config?: { Labels?: Record<string, string> | null } }
    try {
      info = JSON.parse(result.stdout) as typeof info
    } catch (error) {
      return { kind: 'error', message: failureMessage(error) }
    }
    const labels = info.Config?.Labels ?? {}
    if (labels[CONTAINER_LABEL.owner] !== CONTAINER_OWNER || labels[CONTAINER_LABEL.execution] !== executionId || labels[CONTAINER_LABEL.engagement] !== engagementId) {
      return { kind: 'foreign' }
    }
    const state = info.State ?? {}
    return {
      kind: 'owned',
      state: String(state.Status ?? 'unknown'),
      exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
      oomKilled: state.OOMKilled === true,
      startedAt: timestamp(state.StartedAt),
      finishedAt: timestamp(state.FinishedAt),
    }
  }
}

/** Only containers whose name is exactly the one derived from their execution label are considered owned. */
export function parseOwnedContainers(listing: string): OwnedResource[] {
  const owned: OwnedResource[] = []
  for (const line of listing.split(/\r?\n/)) {
    const [name, executionId, engagementId, state] = line.trim().split('\t')
    if (!name || !executionId || !engagementId || !EXECUTION_ID.test(executionId) || !/^[0-9a-z]{6,32}$/.test(engagementId)) continue
    if (name !== containerNameFor(executionId)) continue
    owned.push({ executionId, engagementId, name, state: state ?? 'unknown' })
  }
  return owned
}
