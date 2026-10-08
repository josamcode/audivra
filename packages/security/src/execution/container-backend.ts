import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { redact, type ContainerFacts, type ContainerLimits, type NetworkDecisions, type NetworkFacts } from '@audivra/contracts'
import { runProcess } from '@audivra/tool-runtime'
import { RUNTIME_HELPER_PREFIX, type BackendExit, type BackendRemains, type BackendSpec, type ExecutionBackend, type OwnedResource, type PreparedExecution, type RunningExecution } from './backend.ts'
import { executorProgramPath } from './executors.ts'
import { ExecutionError, failureMessage } from './failures.ts'
import { gatewayBundlePath } from './gateway-bundle.ts'
import { findApprovedRuntime, runtimeImageRef, runtimePullHint } from './runtimes.ts'

/*
 * The isolated container backend: runs a capability's reviewed executor program in an approved runtime,
 * inside a container that belongs to exactly one execution.
 *
 *   identity   name audivra-<execution id> (derived, never chosen) + ownership labels
 *   filesystem read-only root; only this execution's inputs/ (read-only), outputs/ and artifacts/
 *              mounted; a small private tmpfs at /tmp. No repository, home, Docker socket or host paths.
 *   privileges non-root user, every capability dropped, no-new-privileges, default seccomp, private
 *              PID/IPC namespaces, init process for clean signals
 *   network    `none` → no network at all (`--network none`). `scoped-egress` (Phase 2C) → the executor
 *              is attached only to an execution-private internal network whose single reachable peer is
 *              an Audivra-controlled gateway; the gateway (on that network plus a private egress bridge)
 *              runs the real scope engine and is the execution's only route out. The executor has no DNS
 *              for and no route to anything else.
 *   limits     memory (no swap), CPUs, PIDs and tmpfs from the snapshot; wall-clock timeout, artifact
 *              budget and the request/rate budget enforced by Audivra
 *
 * The worker alone talks to Docker, through the docker CLI as owned helper processes. Containers and
 * networks are only ever stopped or removed by their exact derived name after their labels prove they
 * belong to that execution. Evidence is registered on the host by the capability's `collect` step.
 */

/** Ownership labels on every execution resource (identifiers only — never secrets). */
export const CONTAINER_LABEL = {
  owner: 'audivra.owner',
  execution: 'audivra.execution',
  engagement: 'audivra.engagement',
  capability: 'audivra.capability',
  runtime: 'audivra.runtime',
  role: 'audivra.role',
} as const
export const CONTAINER_OWNER = 'security-execution'

/** Network alias of the gateway on the execution's internal network: the executor's only reachable peer. */
export const GATEWAY_ALIAS = 'egress'
export const GATEWAY_PORT = 3128

/** Owner tool of the docker CLI helper processes (platform helpers, not capability processes). */
export const RUNTIME_HELPER_TOOL = `${RUNTIME_HELPER_PREFIX}docker`

const EXECUTION_ID = /^sx_[0-9a-z]{14}$/
const LOG_LIMIT_BYTES = 64 * 1024
const RESULT_LIMIT_BYTES = 64 * 1024
const CONTAINER_ROOT = '/audivra'
const PROGRAM_PATH = `${CONTAINER_ROOT}/inputs/program/main.mjs`
const GATEWAY_READY_MS = 25_000

function dash(executionId: string): string {
  if (!EXECUTION_ID.test(executionId)) throw new ExecutionError('runtime-failed', 'container.invalid-id', `Invalid execution id: ${executionId}`)
  return executionId.replace('_', '-')
}

/** The executor container of an execution: derived from its id, so it is known without being stored. */
export function containerNameFor(executionId: string): string {
  return `audivra-${dash(executionId)}`
}
/** The execution's network gateway container. */
export function gatewayNameFor(executionId: string): string {
  return `audivra-gw-${dash(executionId)}`
}
/** The execution's internal network (executor + gateway; no external route). */
export function internalNetworkName(executionId: string): string {
  return `audivra-net-${dash(executionId)}`
}
/** The execution's private egress network (gateway only; reaches approved destinations). */
export function egressNetworkName(executionId: string): string {
  return `audivra-egr-${dash(executionId)}`
}

/** Non-root user for execution containers: the worker's own uid on POSIX hosts (so files stay its own), else 1000. */
export function defaultContainerUser(): string {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) return '1000:1000'
  return uid === 0 ? '65534:65534' : `${uid}:${gid}`
}

function ownershipLabels(role: string, executionId: string, engagementId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { [CONTAINER_LABEL.owner]: CONTAINER_OWNER, [CONTAINER_LABEL.execution]: executionId, [CONTAINER_LABEL.engagement]: engagementId, [CONTAINER_LABEL.role]: role, ...extra }
}
const labelArgs = (labels: Record<string, string>) => Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`])

export interface ContainerSpec {
  name: string
  labels: Record<string, string>
  /** Exact image reference (repository pinned by digest). */
  image: string
  command: readonly string[]
  limits: ContainerLimits
  user: string
  /** Docker network: `none` (no network) or an execution-private network name. */
  network: string
  /** Host paths of the execution's areas. */
  mounts: { inputs: string; outputs: string; artifacts: string }
}

function assertMountSources(sources: string[]): void {
  for (const source of sources) {
    if (/[,"\n]/.test(source)) throw new ExecutionError('runtime-failed', 'container.mount-path', `Workspace path cannot be mounted safely: ${source}`)
  }
}
function assertNonRoot(user: string): void {
  if (/^(0|root)(:|$)/.test(user)) throw new ExecutionError('runtime-failed', 'container.root-user', 'Execution containers never run as root')
}

/** `docker create` arguments for an executor container — the complete security profile, in one place. */
export function containerCreateArgs(spec: ContainerSpec): string[] {
  assertMountSources(Object.values(spec.mounts))
  assertNonRoot(spec.user)
  const { limits, mounts } = spec
  return [
    'create',
    '--name', spec.name,
    ...labelArgs(spec.labels),
    '--init',
    '--network', spec.network,
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

export interface GatewaySpec {
  name: string
  labels: Record<string, string>
  image: string
  command: readonly string[]
  limits: ContainerLimits
  user: string
  /** The internal network; the gateway joins it with the `egress` alias. */
  network: string
  /** Host path of the execution's `.gateway` dir (bundled gateway, trusted policy, decision log). */
  gatewayDir: string
  hostGateway: string
}

/**
 * `docker create` arguments for the gateway container. Same hardening as an executor, but it is the
 * Audivra-controlled network component: it mounts only its own `.gateway` dir (never the executor's
 * inputs/outputs/artifacts, the repository, host paths or the Docker socket), joins the internal
 * network as `egress`, and is given its policy and log paths — never any Audivra credential.
 */
export function gatewayCreateArgs(spec: GatewaySpec): string[] {
  assertMountSources([spec.gatewayDir])
  assertNonRoot(spec.user)
  const { limits } = spec
  return [
    'create',
    '--name', spec.name,
    ...labelArgs(spec.labels),
    '--init',
    '--network', spec.network,
    '--network-alias', GATEWAY_ALIAS,
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
    '--hostname', 'audivra-gateway',
    '--restart', 'no',
    '--log-driver', 'json-file',
    '--log-opt', 'max-size=1m',
    '--log-opt', 'max-file=1',
    '--env', `AUDIVRA_GATEWAY_POLICY=${CONTAINER_ROOT}/gateway/policy.json`,
    '--env', `AUDIVRA_GATEWAY_LOG=${CONTAINER_ROOT}/gateway/gateway.jsonl`,
    '--env', `AUDIVRA_GATEWAY_PORT=${GATEWAY_PORT}`,
    '--env', `AUDIVRA_HOST_GATEWAY=${spec.hostGateway}`,
    '--add-host', `${spec.hostGateway}:host-gateway`,
    '--mount', `type=bind,source=${spec.gatewayDir},target=${CONTAINER_ROOT}/gateway`,
    spec.image,
    ...spec.command,
  ]
}

/** `docker network create` arguments for an execution-private network. */
export function networkCreateArgs(name: string, internal: boolean, labels: Record<string, string>): string[] {
  return ['network', 'create', '--driver', 'bridge', ...(internal ? ['--internal'] : []), ...labelArgs(labels), name]
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

interface Networking {
  internal: string
  egress: string
  gateway: string
  internalCreated: boolean
  egressCreated: boolean
  gatewayCreated: boolean
  gatewayReady: boolean
}

class ContainerPrepared implements PreparedExecution {
  stopRequested = false
  readonly facts: ContainerFacts
  /** Set for scoped-egress executions; null for `none`. */
  readonly net: Networking | null
  readonly gatewayFacts: { removed: boolean; nets: { name: string; role: string; removed: boolean }[] }

  constructor(
    readonly spec: BackendSpec,
    readonly name: string,
    scopedEgress: boolean,
  ) {
    this.facts = { name, exitCode: null, oomKilled: false, startedAt: null, finishedAt: null, removed: false }
    this.net = scopedEgress
      ? { internal: internalNetworkName(spec.executionId), egress: egressNetworkName(spec.executionId), gateway: gatewayNameFor(spec.executionId), internalCreated: false, egressCreated: false, gatewayCreated: false, gatewayReady: false }
      : null
    this.gatewayFacts = { removed: false, nets: [] }
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const firstLine = (text: string) => redact(text.trim().split(/\r?\n/)[0] ?? '').slice(0, 300)
const timestamp = (value: unknown) => (typeof value === 'string' && !value.startsWith('0001-') ? value : null)

export class IsolatedContainerBackend implements ExecutionBackend {
  readonly id = 'isolated-container'
  readonly mode = 'isolated-container' as const
  readonly #docker: DockerCli
  readonly #user: string
  readonly #hostGateway: string
  readonly #gatewayBundle: () => Promise<string>

  constructor(options: { docker?: DockerCli; user?: string; hostGateway?: string; gatewayBundle?: () => Promise<string> } = {}) {
    this.#docker = options.docker ?? dockerCli
    this.#user = options.user ?? defaultContainerUser()
    this.#hostGateway = options.hostGateway ?? 'host.docker.internal'
    this.#gatewayBundle = options.gatewayBundle ?? gatewayBundlePath
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
    const scopedEgress = isolation.network === 'scoped-egress'
    const name = containerNameFor(executionId)
    const prepared = new ContainerPrepared(spec, name, scopedEgress)
    await spec.events('execution.container-preparing', `Preparing the isolated runtime ${runtime.name} v${runtime.version}`, {
      runtime: runtime.id,
      network: isolation.network,
      limits: isolation.container,
    })

    const image = await this.#docker(['image', 'inspect', isolation.runtime.image, '--format', '{{.Id}}'], { executionId, timeoutMs: 30_000 })
    if (!image.ok) {
      throw new ExecutionError('runtime-unavailable', 'runtime.image-unavailable', `${runtime.name} is not available (Docker not reachable or image missing): ${runtimePullHint(runtime)}`)
    }

    // Inputs are staged before start and mounted read-only: the minimum the program needs, never the
    // trusted configuration, and the reviewed program itself.
    await workspace.init()
    await workspace.write('inputs', 'input.json', JSON.stringify(implementation.programInput(spec.context, spec.input)))
    await workspace.write('inputs', 'program/main.mjs', await readFile(programFile))

    const existing = await this.#inspect(name, executionId, snapshot.engagement.id)
    if (existing.kind === 'foreign') throw new ExecutionError('runtime-failed', 'container.name-conflict', `A container named ${name} exists that does not belong to this execution; it was left untouched`)
    if (existing.kind === 'error') throw new ExecutionError('runtime-unavailable', 'runtime.docker-unavailable', `Docker did not answer: ${existing.message}`)
    if (existing.kind === 'owned') await this.#docker(['rm', '--force', name], { executionId, timeoutMs: 60_000 })

    // The execution-private network and its gateway come up before the executor, so the executor's only
    // route exists from the moment it starts.
    const network = prepared.net ? await this.#setupNetwork(prepared, runtime.command, isolation.runtime.image) : 'none'

    const created = await this.#docker(
      containerCreateArgs({
        name,
        labels: ownershipLabels('executor', executionId, snapshot.engagement.id, { [CONTAINER_LABEL.capability]: snapshot.capability.id, [CONTAINER_LABEL.runtime]: `${runtime.id}@${runtime.version}` }),
        image: isolation.runtime.image,
        command: [...runtime.command, PROGRAM_PATH],
        limits: isolation.container,
        user: this.#user,
        network,
        mounts: { inputs: workspace.area('inputs'), outputs: workspace.area('outputs'), artifacts: workspace.area('artifacts') },
      }),
      { executionId, timeoutMs: 60_000 },
    )
    if (!created.ok) throw new ExecutionError('runtime-failed', 'container.create-failed', `The execution container could not be created: ${firstLine(created.stderr)}`)
    await spec.events('execution.container-created', `Container ${name} created`, { container: name, runtime: runtime.id, user: this.#user, network })
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
    // SIGTERM through the container's init: the program (and the gateway) may flush before they exit.
    await this.#docker(['kill', '--signal', 'SIGTERM', p.name], { executionId: p.spec.executionId, timeoutMs: 30_000 })
    if (p.net) await this.#docker(['kill', '--signal', 'SIGTERM', p.net.gateway], { executionId: p.spec.executionId, timeoutMs: 30_000 })
  }

  async terminate(running: RunningExecution): Promise<{ terminated: number }> {
    const p = this.#prepared(running.prepared)
    p.stopRequested = true
    let terminated = 0
    for (const target of [p.name, ...(p.net ? [p.net.gateway] : [])]) {
      const found = await this.#inspect(target, p.spec.executionId, p.spec.snapshot.engagement.id)
      if (found.kind === 'owned' && ['running', 'created', 'paused', 'restarting'].includes(found.state)) {
        const killed = await this.#docker(['kill', target], { executionId: p.spec.executionId, timeoutMs: 30_000 })
        if (killed.ok) terminated++
      }
    }
    if (terminated) await p.spec.events('execution.container-terminated', `${terminated} owned container(s) terminated by Audivra`, { container: p.name }, 'warn')
    return { terminated }
  }

  async cleanup(prepared: PreparedExecution): Promise<{ removedBytes: number; container?: ContainerFacts; network?: NetworkFacts }> {
    const p = this.#prepared(prepared)
    const errors: string[] = []
    // Read the gateway's bounded decision log before anything is torn down.
    const decisions = p.net ? await this.#readDecisions(p) : null
    // Containers first (a network cannot be removed while a container is attached): executor, then gateway.
    await this.#removeContainer(p, p.name, (f) => (p.facts.removed = f), errors)
    if (p.net) {
      await this.#removeContainer(p, p.net.gateway, (f) => (p.gatewayFacts.removed = f), errors)
      for (const [name, role] of [[p.net.internal, 'net-internal'], [p.net.egress, 'net-egress']] as const) {
        const removed = await this.#removeNetwork(p, name)
        p.gatewayFacts.nets.push({ name, role, removed })
        if (!removed) errors.push(`network ${name} could not be removed`)
      }
      if (errors.length) await p.spec.events('execution.network-cleanup-failed', `Network cleanup incomplete: ${errors.join('; ')}`, { networks: p.gatewayFacts.nets }, 'error')
    }
    const { removedBytes } = await p.spec.workspace.cleanup()
    if (errors.length) {
      // A network execution's failure is network-cleanup-failed; a plain container's is a generic cleanup failure.
      if (p.net) throw new ExecutionError('network-cleanup-failed', 'network.cleanup-failed', errors.join('; '))
      throw new Error(errors.join('; '))
    }
    return { removedBytes, container: { ...p.facts }, network: this.#networkFacts(p, decisions) ?? undefined }
  }

  async resume(spec: BackendSpec): Promise<BackendRemains> {
    const scopedEgress = spec.snapshot.isolation?.network === 'scoped-egress'
    const p = new ContainerPrepared(spec, containerNameFor(spec.executionId), scopedEgress)
    const found = await this.#inspect(p.name, spec.executionId, spec.snapshot.engagement.id)
    if (found.kind === 'error') throw new ExecutionError('runtime-unavailable', 'runtime.docker-unavailable', `Docker did not answer: ${found.message}`)
    if (found.kind !== 'owned') return { prepared: p, state: 'missing', running: null }
    this.#record(p, found)
    if (found.state === 'created') return { prepared: p, state: 'created', running: null }
    if (found.state === 'removing') return { prepared: p, state: 'missing', running: null }
    const live = ['running', 'paused', 'restarting'].includes(found.state)
    return { prepared: p, state: live ? 'running' : 'exited', running: lazyRun(p, () => (live ? this.#wait(p) : this.#finish(p))) }
  }

  async ownedResources(): Promise<OwnedResource[]> {
    const fmt = `{{.Names}}\t{{.Label "${CONTAINER_LABEL.execution}"}}\t{{.Label "${CONTAINER_LABEL.engagement}"}}\t{{.Label "${CONTAINER_LABEL.role}"}}\t{{.State}}`
    const containers = await this.#docker(['ps', '--all', '--no-trunc', '--filter', `label=${CONTAINER_LABEL.owner}=${CONTAINER_OWNER}`, '--format', fmt], { timeoutMs: 30_000 })
    if (!containers.ok) throw new ExecutionError('runtime-unavailable', 'runtime.docker-unavailable', `Docker did not answer: ${firstLine(containers.stderr)}`)
    const netFmt = `{{.Name}}\t{{.Label "${CONTAINER_LABEL.execution}"}}\t{{.Label "${CONTAINER_LABEL.engagement}"}}\t{{.Label "${CONTAINER_LABEL.role}"}}`
    const networks = await this.#docker(['network', 'ls', '--no-trunc', '--filter', `label=${CONTAINER_LABEL.owner}=${CONTAINER_OWNER}`, '--format', netFmt], { timeoutMs: 30_000 })
    if (!networks.ok) throw new ExecutionError('runtime-unavailable', 'runtime.docker-unavailable', `Docker did not answer: ${firstLine(networks.stderr)}`)
    return [...parseOwnedContainers(containers.stdout), ...parseOwnedNetworks(networks.stdout)]
  }

  async removeOwnedResource(resource: OwnedResource): Promise<void> {
    if (resource.kind === 'network') {
      const found = await this.#inspectNetwork(resource.name, resource.executionId, resource.engagementId)
      if (found.kind === 'absent') return
      if (found.kind !== 'owned') throw new Error(`${resource.name} could not be proven to belong to execution ${resource.executionId}; left untouched`)
      const removed = await this.#docker(['network', 'rm', resource.name], { executionId: resource.executionId, timeoutMs: 60_000 })
      const after = await this.#inspectNetwork(resource.name, resource.executionId, resource.engagementId)
      if (after.kind !== 'absent') throw new Error(`${resource.name} could not be removed: ${removed.ok ? 'it still exists' : firstLine(removed.stderr)}`)
      return
    }
    const found = await this.#inspect(resource.name, resource.executionId, resource.engagementId)
    if (found.kind === 'absent') return
    if (found.kind !== 'owned') throw new Error(`${resource.name} could not be proven to belong to execution ${resource.executionId}; left untouched`)
    const removed = await this.#docker(['rm', '--force', resource.name], { executionId: resource.executionId, timeoutMs: 60_000 })
    const after = await this.#inspect(resource.name, resource.executionId, resource.engagementId)
    if (after.kind !== 'absent') throw new Error(`${resource.name} could not be removed: ${removed.ok ? 'it still exists' : firstLine(removed.stderr)}`)
  }

  // ── Network setup / teardown ────────────────────────────────────────────────────────────────────────

  async #setupNetwork(p: ContainerPrepared, nodeCommand: readonly string[], image: string): Promise<string> {
    const { spec } = p
    const net = p.net!
    const { executionId } = spec
    const engagementId = spec.snapshot.engagement.id
    await spec.events('execution.network-preparing', 'Preparing the execution-private network and gateway', { internal: net.internal, egress: net.egress, gateway: net.gateway })
    const fail = (rule: string, message: string) => new ExecutionError('network-setup-failed', rule, message)

    for (const [name, internal] of [[net.internal, true], [net.egress, false]] as const) {
      const existing = await this.#inspectNetwork(name, executionId, engagementId)
      if (existing.kind === 'foreign') throw fail('network.name-conflict', `A network named ${name} exists that does not belong to this execution`)
      if (existing.kind === 'owned') await this.#docker(['network', 'rm', name], { executionId, timeoutMs: 60_000 })
      const created = await this.#docker(networkCreateArgs(name, internal, ownershipLabels(internal ? 'net-internal' : 'net-egress', executionId, engagementId)), { executionId, timeoutMs: 60_000 })
      if (!created.ok) throw fail('network.create-failed', `Could not create ${internal ? 'internal' : 'egress'} network: ${firstLine(created.stderr)}`)
      if (internal) net.internalCreated = true
      else net.egressCreated = true
    }

    // Stage the bundled gateway program and the trusted policy (from the snapshot only).
    const dir = spec.workspace.gatewayDir
    await mkdir(dir, { recursive: true })
    await copyFile(await this.#gatewayBundle(), path.join(dir, 'main.mjs'))
    await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ manifest: spec.snapshot.scope.manifest, limits: spec.snapshot.limits }), 'utf8')

    const existingGw = await this.#inspect(net.gateway, executionId, engagementId)
    if (existingGw.kind === 'foreign') throw fail('gateway.name-conflict', `A container named ${net.gateway} exists that does not belong to this execution`)
    if (existingGw.kind === 'owned') await this.#docker(['rm', '--force', net.gateway], { executionId, timeoutMs: 60_000 })
    const createdGw = await this.#docker(
      gatewayCreateArgs({
        name: net.gateway,
        labels: ownershipLabels('gateway', executionId, engagementId),
        image,
        command: [...nodeCommand, `${CONTAINER_ROOT}/gateway/main.mjs`],
        limits: spec.snapshot.isolation!.container!,
        user: this.#user,
        network: net.internal,
        gatewayDir: dir,
        hostGateway: this.#hostGateway,
      }),
      { executionId, timeoutMs: 60_000 },
    )
    if (!createdGw.ok) throw fail('gateway.create-failed', `Could not create the gateway container: ${firstLine(createdGw.stderr)}`)
    net.gatewayCreated = true
    const connected = await this.#docker(['network', 'connect', net.egress, net.gateway], { executionId, timeoutMs: 60_000 })
    if (!connected.ok) throw fail('gateway.egress-connect-failed', `Could not attach the gateway to its egress network: ${firstLine(connected.stderr)}`)
    const startedGw = await this.#docker(['start', net.gateway], { executionId, timeoutMs: 60_000 })
    if (!startedGw.ok) throw fail('gateway.start-failed', `Could not start the gateway container: ${firstLine(startedGw.stderr)}`)

    await this.#awaitGatewayReady(p)
    net.gatewayReady = true
    await spec.events('execution.gateway-started', `Gateway ${net.gateway} ready`, { gateway: net.gateway, internal: net.internal, egress: net.egress })
    await spec.events('execution.network-ready', 'Execution-private network ready; the executor can reach only the gateway', { gateway: net.gateway })
    return net.internal
  }

  async #awaitGatewayReady(p: ContainerPrepared): Promise<void> {
    const net = p.net!
    const deadline = Date.now() + GATEWAY_READY_MS
    for (;;) {
      const logs = await this.#docker(['logs', net.gateway], { executionId: p.spec.executionId, timeoutMs: 15_000, maxBuffer: 256 * 1024 })
      if (/AUDIVRA_GATEWAY_READY/.test(logs.stdout + logs.stderr)) return
      const found = await this.#inspect(net.gateway, p.spec.executionId, p.spec.snapshot.engagement.id)
      if (found.kind === 'owned' && found.state === 'exited') {
        throw new ExecutionError('gateway-unavailable', 'gateway.exited-early', `The gateway exited before it was ready: ${firstLine(logs.stderr || logs.stdout)}`)
      }
      if (Date.now() > deadline) throw new ExecutionError('gateway-unavailable', 'gateway.not-ready', `The gateway did not become ready within ${GATEWAY_READY_MS / 1000} s`)
      await sleep(300)
    }
  }

  /** Reads the gateway's bounded decision summary from its own log (never from the executor). */
  async #readDecisions(p: ContainerPrepared): Promise<NetworkDecisions | null> {
    try {
      const raw = await readFile(path.join(p.spec.workspace.gatewayDir, 'gateway.jsonl'), 'utf8')
      const lines = raw.trim().split(/\r?\n/).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]!) as { summary?: NetworkDecisions }
        if (entry.summary) return entry.summary
      }
      // No summary line (the gateway was killed hard): count the per-request decisions we have.
      const byReason: Record<string, number> = {}
      let allowed = 0
      let denied = 0
      for (const line of lines) {
        const e = JSON.parse(line) as { decision?: string; rule?: string }
        if (e.decision === 'allow') allowed++
        else if (e.decision === 'deny') {
          denied++
          byReason[String(e.rule)] = (byReason[String(e.rule)] ?? 0) + 1
        }
      }
      return lines.length ? { requested: allowed + denied, allowed, denied, byReason } : null
    } catch {
      return null
    }
  }

  #networkFacts(p: ContainerPrepared, decisions: NetworkDecisions | null): NetworkFacts | null {
    if (!p.net) return null
    return {
      profile: 'scoped-egress',
      gateway: { name: p.net.gateway, ready: p.net.gatewayReady, removed: p.gatewayFacts.removed },
      networks: p.gatewayFacts.nets.length ? p.gatewayFacts.nets : [{ name: p.net.internal, role: 'net-internal', removed: false }, { name: p.net.egress, role: 'net-egress', removed: false }],
      decisions,
    }
  }

  // ── Removal helpers ───────────────────────────────────────────────────────────────────────────────

  async #removeContainer(p: ContainerPrepared, name: string, setRemoved: (removed: boolean) => void, errors: string[]): Promise<void> {
    const found = await this.#inspect(name, p.spec.executionId, p.spec.snapshot.engagement.id)
    if (found.kind === 'error') {
      errors.push(`Docker did not answer about ${name}: ${found.message}`)
      return
    }
    if (found.kind === 'foreign') {
      errors.push(`a container named ${name} is not labelled as this execution's own and was left untouched`)
      return
    }
    if (found.kind === 'absent') {
      setRemoved(true)
      return
    }
    const removed = await this.#docker(['rm', '--force', name], { executionId: p.spec.executionId, timeoutMs: 60_000 })
    const after = await this.#inspect(name, p.spec.executionId, p.spec.snapshot.engagement.id)
    if (after.kind === 'absent') {
      setRemoved(true)
      if (name === p.name) await p.spec.events('execution.container-removed', `Container ${name} removed`, { container: name })
    } else {
      const reason = removed.ok ? 'it still exists after removal' : firstLine(removed.stderr)
      errors.push(`container ${name} could not be removed: ${reason}`)
      await p.spec.events('execution.container-cleanup-failed', `Container ${name} could not be removed: ${reason}`, { container: name }, 'error')
    }
  }

  async #removeNetwork(p: ContainerPrepared, name: string): Promise<boolean> {
    const found = await this.#inspectNetwork(name, p.spec.executionId, p.spec.snapshot.engagement.id)
    if (found.kind === 'absent') return true
    if (found.kind !== 'owned') return false
    await this.#docker(['network', 'rm', name], { executionId: p.spec.executionId, timeoutMs: 60_000 })
    return (await this.#inspectNetwork(name, p.spec.executionId, p.spec.snapshot.engagement.id)).kind === 'absent'
  }

  // ── Observation ─────────────────────────────────────────────────────────────────────────────────────

  #prepared(prepared: PreparedExecution): ContainerPrepared {
    if (!(prepared instanceof ContainerPrepared)) throw new ExecutionError('runtime-failed', 'runtime.wrong-backend', 'Not an isolated-container execution')
    return prepared
  }

  /** Waits for the executor container to exit (an owned, persisted helper process), then observes it. */
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
    if (!this.#ownedByExecution(info.Config?.Labels ?? {}, executionId, engagementId)) return { kind: 'foreign' }
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

  /** Inspects a network by exact name and proves (by labels) whose it is. */
  async #inspectNetwork(name: string, executionId: string, engagementId: string): Promise<{ kind: 'absent' | 'foreign' | 'owned' | 'error'; message?: string }> {
    const result = await this.#docker(['network', 'inspect', '--format', '{{json .Labels}}', name], { executionId, timeoutMs: 30_000 })
    if (!result.ok) return /no such network|not found/i.test(result.stderr) ? { kind: 'absent' } : { kind: 'error', message: firstLine(result.stderr || 'docker network inspect failed') }
    try {
      const labels = (JSON.parse(result.stdout) as Record<string, string> | null) ?? {}
      return this.#ownedByExecution(labels, executionId, engagementId) ? { kind: 'owned' } : { kind: 'foreign' }
    } catch (error) {
      return { kind: 'error', message: failureMessage(error) }
    }
  }

  #ownedByExecution(labels: Record<string, string>, executionId: string, engagementId: string): boolean {
    return labels[CONTAINER_LABEL.owner] === CONTAINER_OWNER && labels[CONTAINER_LABEL.execution] === executionId && labels[CONTAINER_LABEL.engagement] === engagementId
  }
}

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

/** Containers whose exact name is the one derived from their execution label (executor or gateway). */
export function parseOwnedContainers(listing: string): OwnedResource[] {
  const owned: OwnedResource[] = []
  for (const line of listing.split(/\r?\n/)) {
    const [name, executionId, engagementId, role, state] = line.trim().split('\t')
    if (!name || !executionId || !engagementId || !EXECUTION_ID.test(executionId) || !ENGAGEMENT_ID.test(engagementId)) continue
    if (name !== containerNameFor(executionId) && name !== gatewayNameFor(executionId)) continue
    owned.push({ executionId, engagementId, name, kind: 'container', role: role || (name === gatewayNameFor(executionId) ? 'gateway' : 'executor'), state: state ?? 'unknown' })
  }
  return owned
}

/** Networks whose exact name is one of the two derived from their execution label. */
export function parseOwnedNetworks(listing: string): OwnedResource[] {
  const owned: OwnedResource[] = []
  for (const line of listing.split(/\r?\n/)) {
    const [name, executionId, engagementId, role] = line.trim().split('\t')
    if (!name || !executionId || !engagementId || !EXECUTION_ID.test(executionId) || !ENGAGEMENT_ID.test(engagementId)) continue
    if (name !== internalNetworkName(executionId) && name !== egressNetworkName(executionId)) continue
    owned.push({ executionId, engagementId, name, kind: 'network', role: role || 'network', state: 'present' })
  }
  return owned
}
