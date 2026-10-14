import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SecurityCapabilityMetadata, type ScopeManifestInput } from '@audivra/contracts'
import {
  APPROVED_RUNTIMES,
  CapabilityBroker,
  CapabilityRegistrationError,
  CapabilityRegistry,
  containerCreateArgs,
  containerNameFor,
  createDefaultRegistry,
  createRuntimeRegistry,
  defaultContainerUser,
  ExecutionRuntime,
  ExecutionWorkspace,
  InProcessBackend,
  IsolatedContainerBackend,
  isolatedCheckCapability,
  parseOwnedContainers,
  runtimeImageRef,
  snapshotHash,
  type BackendSpec,
  type DockerCli,
  type ExecutionBackend,
  type PreparedExecution,
  type RunningExecution,
  type SecurityCapability,
} from '../src/index.ts'
import { MemoryStore, snapshot, verifiedLocal } from './memory-store.ts'
import { MemoryExecutionStore, MemoryQueue } from './memory-executions.ts'

/*
 * Phase 2B without Docker: capability execution modes, deterministic backend selection with no
 * downgrade, the container security profile, and the isolated backend's decisions against a scripted
 * docker CLI. The real containers are exercised by apps/worker/test/security-isolated.integration.test.ts.
 */

const PORT = 4996
const TARGET = `http://127.0.0.1:${PORT}/`
const workspace = mkdtempSync(path.join(os.tmpdir(), 'audivra-isolation-'))
afterAll(() => rmSync(workspace, { recursive: true, force: true, maxRetries: 5 }))
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const okResources = async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} })
const RUNTIME = APPROVED_RUNTIMES[0]!

const BASE: SecurityCapabilityMetadata = {
  id: 'test.isolated',
  version: 1,
  family: 'diagnostic',
  name: 'Test isolated capability',
  description: 'Test capability for the isolated backend.',
  riskClass: 'passive',
  sideEffect: 'read-only',
  supportedEnvironments: ['production', 'staging', 'isolated-lab'],
  requiresAuthorization: true,
  requiresIdentity: false,
  requiresNetwork: false,
  requiresExternalIntegration: false,
  supportsCancellation: true,
  rateLimitClass: 'none',
  resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: false },
  timeoutProfile: { defaultSeconds: 30, maxSeconds: 900 },
  evidenceTypes: ['tool-result'],
  implementation: 'test/isolated@1',
  execution: { mode: 'isolated-container', runtime: 'node-sandbox' },
}

let collected = 0
function isolated(patch: Partial<SecurityCapabilityMetadata> = {}, implementation: Partial<SecurityCapability<{ target: string }>['implementation']> = {}): SecurityCapability<{ target: string }> {
  return {
    metadata: { ...BASE, ...patch },
    implementation: {
      id: patch.implementation ?? BASE.implementation,
      input: z.strictObject({ target: z.string() }),
      targets: (input) => [input.target],
      program: 'isolated-check.mjs',
      programInput: () => ({ hold: 0 }),
      collect: async () => {
        collected++
        return { output: { ok: true }, summary: 'collected' }
      },
      ...implementation,
    },
  }
}

/** Records what the runtime asked it to do; "runs" the capability by calling its collect step. */
class FakeBackend implements ExecutionBackend {
  readonly calls: string[] = []
  constructor(
    readonly mode: 'in-process' | 'isolated-container',
    readonly id = `fake-${mode}`,
  ) {}
  async prepare(spec: BackendSpec): Promise<PreparedExecution> {
    this.calls.push('prepare')
    await spec.workspace.init()
    return { spec }
  }
  async start(prepared: PreparedExecution): Promise<RunningExecution> {
    this.calls.push('start')
    const { spec } = prepared
    const run = { exitCode: 0, result: null, log: { bytes: 0, tail: '', path: null }, durationMs: 1 }
    const exit = spec.capability.implementation.collect!(spec.context, spec.input, run, spec.handles).then((r) => ({ status: 'succeeded' as const, output: r.output, summary: r.summary, code: 0 }))
    return { prepared, exit }
  }
  observe(running: RunningExecution) {
    return running.exit
  }
  async cancel() {
    this.calls.push('cancel')
  }
  async terminate() {
    this.calls.push('terminate')
    return { terminated: 0 }
  }
  async cleanup(prepared: PreparedExecution) {
    this.calls.push('cleanup')
    return prepared.spec.workspace.cleanup()
  }
  async resume(spec: BackendSpec) {
    return { prepared: { spec }, state: 'none' as const, running: null }
  }
}

function harness(options: { registry?: CapabilityRegistry; backends?: Record<string, ExecutionBackend>; scope?: ScopeManifestInput } = {}) {
  const store = new MemoryStore(snapshot(PORT, { scopeInput: { hosts: [{ host: '127.0.0.1', ports: [PORT] }], protocols: ['http'], ...options.scope } }), [verifiedLocal(PORT)])
  const executions = new MemoryExecutionStore()
  const queue = new MemoryQueue(executions)
  const registry = options.registry ?? new CapabilityRegistry().register(isolated())
  const broker = new CapabilityBroker({ registry, store, checkResources: okResources, workspaceRoot: () => workspace, executions: { store: executions, queue } })
  const inProcess = new FakeBackend('in-process')
  const runtime = (backends: Record<string, ExecutionBackend> = options.backends ?? {}, r = registry) =>
    new ExecutionRuntime({ registry: r, store, executions, workspaceRoot: () => workspace, checkResources: okResources, pollIntervalMs: 50, backend: inProcess, backends })
  const submit = async (capabilityId = 'test.isolated', extra: Record<string, unknown> = {}) => {
    const outcome = await broker.submit({ engagementId: store.engagement.id, capabilityId, input: { target: TARGET }, actor: user, ...extra })
    return outcome
  }
  return { store, executions, broker, runtime, submit, inProcess }
}

describe('capability execution modes', () => {
  const register = (capability: SecurityCapability<{ target: string }>) => () => new CapabilityRegistry().register(capability)

  it('registers the shipped capabilities and diagnostics with exactly the shape their mode requires', () => {
    expect(createDefaultRegistry().list().map((c) => c.id)).toEqual(['api.contract-test', 'discovery.crawl', 'discovery.http-inspect', 'discovery.http-observe', 'discovery.identity-http', 'source.static-analysis', 'web.signal-scan'])
    const runtime = createRuntimeRegistry()
    expect(runtime.list().map((c) => [c.id, c.execution?.mode ?? 'in-process', c.execution?.network ?? 'none'])).toEqual([
      ['access.identity-action', 'in-process', 'none'],
      ['access.identity-read', 'in-process', 'none'],
      ['api.contract-test', 'isolated-container', 'scoped-egress'],
      ['diagnostic.egress-check', 'isolated-container', 'scoped-egress'],
      ['diagnostic.isolated-check', 'isolated-container', 'none'],
      ['diagnostic.runtime-check', 'in-process', 'none'],
      ['discovery.crawl', 'isolated-container', 'scoped-egress'],
      ['discovery.http-inspect', 'isolated-container', 'scoped-egress'],
      ['discovery.http-observe', 'in-process', 'none'],
      ['discovery.identity-http', 'in-process', 'none'],
      ['source.static-analysis', 'isolated-container', 'none'],
      ['specialist.strix-research', 'in-process', 'none'],
      ['web.signal-scan', 'isolated-container', 'scoped-egress'],
    ])
    expect(runtime.get('diagnostic.isolated-check')!.implementation.execute).toBeUndefined()
    expect(isolatedCheckCapability.metadata.execution).toEqual({ mode: 'isolated-container', runtime: 'node-sandbox' })
    // What agents are told never includes runtimes, images or mounts.
    expect(JSON.stringify(runtime.describeForAgents())).not.toMatch(/node-sandbox|sha256|docker|mount/i)
  })

  it('refuses an isolated capability that could run in-process, or that names anything but an approved runtime and a shipped program', () => {
    const inProcessToo = async () => ({ output: null, summary: 'in-process' })
    expect(register(isolated({}, { execute: inProcessToo }))).toThrow(/must not provide an in-process execute/)
    expect(register(isolated({}, { collect: undefined }))).toThrow(/must provide program, programInput and collect/)
    expect(register(isolated({ execution: { mode: 'isolated-container', runtime: 'ubuntu-latest' } }))).toThrow(/not an approved runtime/)
    expect(register(isolated({ requiresNetwork: true }))).toThrow(/must declare the scoped-egress network profile/)
    expect(register(isolated({ execution: { mode: 'isolated-container', runtime: 'node-sandbox', network: 'scoped-egress' } }))).toThrow(/must declare requiresNetwork/)
    expect(register(isolated({ execution: { mode: 'in-process', runtime: null, network: 'scoped-egress' } }))).toThrow()
    expect(register(isolated({ resourceProfile: { disk: 'small', containerImage: 'alpine:latest', spawnsProcesses: false } }))).toThrow(/never an image/)
    expect(register(isolated({ resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: true } }))).toThrow(/starts no host processes/)
    for (const program of ['../../package.json', 'missing.mjs', '/etc/passwd', 'isolated-check.MJS']) {
      expect(register(isolated({}, { program })), program).toThrow(/not a reviewed executor/)
    }
    expect(register(isolated({ execution: { mode: 'isolated-container', runtime: null } }))).toThrow(CapabilityRegistrationError)
    expect(register(isolated({ execution: { mode: 'in-process', runtime: 'node-sandbox' } }))).toThrow(CapabilityRegistrationError)
    // An in-process capability provides execute and no program.
    expect(register(isolated({ execution: undefined }))).toThrow(/in-process capability must provide execute/)
    expect(register(isolated({ execution: undefined }, { execute: inProcessToo }))).toThrow(/has no executor program/)
    expect(register(isolated())).not.toThrow()
  })
})

describe('backend selection: deterministic, from trusted metadata, never downgraded', () => {
  it('the in-process path refuses a capability that must run isolated, before anything runs', async () => {
    const { broker, store } = harness()
    const before = collected
    const outcome = await broker.execute({ engagementId: store.engagement.id, capabilityId: 'test.isolated', input: { target: TARGET }, actor: user })
    expect(outcome).toMatchObject({ status: 'denied', decision: { stage: 'resources', rule: 'runtime.isolation-required' } })
    expect(collected).toBe(before)
    expect(store.evidence).toHaveLength(0)
  })

  it('a request or its input cannot choose or downgrade the backend', async () => {
    const { submit, executions } = harness()
    expect((await submit('test.isolated', { executionMode: 'in-process' })).decision.rule).toBe('request.invalid')
    expect((await submit('test.isolated', { backend: 'in-process' })).decision.rule).toBe('request.invalid')
    const { broker, store } = harness()
    const withInput = await broker.submit({ engagementId: store.engagement.id, capabilityId: 'test.isolated', input: { target: TARGET, backend: 'in-process' }, actor: user })
    expect(withInput.decision.rule).toBe('input.invalid')
    expect(executions.rows.size).toBe(0)
  })

  it('records the isolation in the trusted snapshot: mode, pinned image and container limits', async () => {
    const { submit, executions } = harness()
    const outcome = await submit()
    expect(outcome.status).toBe('queued')
    const row = executions.rows.get(outcome.executionId)!
    expect(row.snapshot.isolation).toEqual({
      mode: 'isolated-container',
      runtime: { id: 'node-sandbox', version: 1, image: runtimeImageRef(RUNTIME) },
      network: 'none',
      container: RUNTIME.limits,
    })
    expect(row.snapshot.runtime.maxProcesses).toBe(0)
  })

  it('runs an isolated execution only on the isolated backend', async () => {
    const isolatedBackend = new FakeBackend('isolated-container')
    const { submit, runtime, inProcess, executions } = harness()
    const { executionId } = await submit()
    expect(await runtime({ 'isolated-container': isolatedBackend }).run(executionId)).toBe('succeeded')
    expect(isolatedBackend.calls).toEqual(['prepare', 'start', 'cleanup'])
    expect(inProcess.calls).toEqual([])
    expect(executions.rows.get(executionId)!.exit).toMatchObject({ runtime: { backend: 'isolated-container' } })
    expect(executions.rows.get(executionId)!.runner).toMatchObject({ backend: 'fake-isolated-container' })
  })

  it('fails — never falls back to in-process — when this worker has no isolated backend', async () => {
    const { submit, runtime, inProcess, executions } = harness()
    const { executionId } = await submit()
    expect(await runtime({}).run(executionId)).toBe('failed')
    expect(executions.rows.get(executionId)!.failure).toMatchObject({ kind: 'runtime-unavailable', rule: 'runtime.backend-unavailable' })
    expect(inProcess.calls).toEqual([])
    // A backend registered under the wrong mode is not accepted either.
    const second = await harness().submit()
    void second
  })

  it('refuses when the capability changed its mode, or the approved runtime changed, after the decision', async () => {
    const env = harness()
    const { executionId } = await env.submit()
    const nowInProcess = new CapabilityRegistry().register({
      metadata: { ...BASE, execution: undefined },
      implementation: { id: BASE.implementation, input: z.strictObject({ target: z.string() }), targets: (i) => [i.target], execute: async () => ({ output: null, summary: 'downgraded' }) },
    })
    expect(await env.runtime({}, nowInProcess).run(executionId)).toBe('failed')
    expect(env.executions.rows.get(executionId)!.failure).toMatchObject({ kind: 'preflight-failed', rule: 'execution.capability-changed' })
    expect(env.inProcess.calls).toEqual([])

    const env2 = harness()
    const second = await env2.submit()
    const stored = env2.executions.rows.get(second.executionId)!.snapshot
    // As if decided under another runtime registry: consistent hash, different image.
    const other = { ...stored, isolation: { ...stored.isolation!, runtime: { ...stored.isolation!.runtime!, image: 'node@sha256:0000' } } }
    env2.executions.patchRaw(second.executionId, { snapshot: other, snapshotHash: snapshotHash(other) })
    const isolatedBackend = new FakeBackend('isolated-container')
    expect(await env2.runtime({ 'isolated-container': isolatedBackend }).run(second.executionId)).toBe('failed')
    expect(env2.executions.rows.get(second.executionId)!.failure).toMatchObject({ rule: 'execution.runtime-changed' })
    expect(isolatedBackend.calls).toEqual([])
  })

  it('the in-process backend cannot run an isolated capability by construction', async () => {
    const backend = new InProcessBackend()
    const capability = new CapabilityRegistry().register(isolated()).get('test.isolated')!
    const prepared = { spec: { capability } as unknown as BackendSpec }
    await expect(backend.start(prepared)).rejects.toMatchObject({ kind: 'runtime-unavailable', rule: 'runtime.wrong-backend' })
  })
})

describe('container security profile', () => {
  const spec = {
    name: containerNameFor('sx_0123456789abcd'),
    labels: { 'audivra.owner': 'security-execution', 'audivra.execution': 'sx_0123456789abcd' },
    image: runtimeImageRef(RUNTIME),
    command: ['node', '/audivra/inputs/program/main.mjs'],
    limits: RUNTIME.limits,
    user: '1000:1000',
    network: 'none',
    mounts: { inputs: 'D:\\w\\executions\\sx_0123456789abcd\\inputs', outputs: 'D:\\w\\executions\\sx_0123456789abcd\\outputs', artifacts: 'D:\\w\\executions\\sx_0123456789abcd\\artifacts' },
  }

  it('creates a non-root, read-only, network-less, capability-free container limited to its own workspace', () => {
    const args = containerCreateArgs(spec)
    const pairs = (flag: string) => args.flatMap((value, i) => (value === flag ? [args[i + 1]] : []))
    expect(args[0]).toBe('create')
    expect(pairs('--name')).toEqual(['audivra-sx-0123456789abcd'])
    expect(pairs('--network')).toEqual(['none'])
    expect(pairs('--user')).toEqual(['1000:1000'])
    expect(pairs('--cap-drop')).toEqual(['ALL'])
    expect(pairs('--security-opt')).toEqual(['no-new-privileges'])
    expect(pairs('--pids-limit')).toEqual(['64'])
    expect(pairs('--memory')).toEqual(['256m'])
    expect(pairs('--memory-swap')).toEqual(['256m'])
    expect(pairs('--cpus')).toEqual(['0.5'])
    expect(pairs('--ipc')).toEqual(['private'])
    expect(pairs('--tmpfs')).toEqual(['/tmp:rw,noexec,nosuid,nodev,size=16m'])
    expect(args).toContain('--read-only')
    expect(args).toContain('--init')
    expect(pairs('--mount')).toEqual([
      `type=bind,source=${spec.mounts.inputs},target=/audivra/inputs,readonly`,
      `type=bind,source=${spec.mounts.outputs},target=/audivra/outputs`,
      `type=bind,source=${spec.mounts.artifacts},target=/audivra/artifacts`,
    ])
    expect(args.slice(-3)).toEqual([spec.image, ...spec.command])
    for (const forbidden of ['--privileged', '--cap-add', '-v', '--volume', '--pid', '--userns', '--device', '--add-host', '-p', '--publish', '-e', '--env', '--env-file']) {
      expect(args, forbidden).not.toContain(forbidden)
    }
    expect(args.join(' ')).not.toMatch(/docker\.sock|docker_engine|--(pid|ipc|network|uts|userns)[ =]host(\s|$)/i)
  })

  it('refuses root users and mount paths that could change the mount syntax', () => {
    expect(() => containerCreateArgs({ ...spec, user: '0:0' })).toThrow(/never run as root/)
    expect(() => containerCreateArgs({ ...spec, user: 'root' })).toThrow(/never run as root/)
    expect(() => containerCreateArgs({ ...spec, mounts: { ...spec.mounts, outputs: 'D:\\w,target=/,x' } })).toThrow(/cannot be mounted safely/)
    expect(defaultContainerUser()).not.toMatch(/^(0|root)(:|$)/)
  })

  it('derives the container identity from the execution id and accepts only containers named that way', () => {
    expect(containerNameFor('sx_abcdefghijk123')).toBe('audivra-sx-abcdefghijk123')
    expect(() => containerNameFor('sx_../../etc')).toThrow()
    expect(() => containerNameFor('abc')).toThrow()
    const listing = [
      'audivra-sx-abcdefghijk123\tsx_abcdefghijk123\tengage0001\texecutor\trunning',
      'audivra-gw-sx-abcdefghijk123\tsx_abcdefghijk123\tengage0001\tgateway\trunning',
      'audivra-impostor\tsx_abcdefghijk124\tengage0001\texecutor\trunning',
      'audivra-sx-abcdefghijk125\tsx_abcdefghijk126\tengage0001\texecutor\texited',
      'audivra-sx-abcdefghijk127\tnot-an-id\tengage0001\texecutor\texited',
      '',
    ].join('\n')
    expect(parseOwnedContainers(listing)).toEqual([
      { executionId: 'sx_abcdefghijk123', engagementId: 'engage0001', name: 'audivra-sx-abcdefghijk123', kind: 'container', role: 'executor', state: 'running' },
      { executionId: 'sx_abcdefghijk123', engagementId: 'engage0001', name: 'audivra-gw-sx-abcdefghijk123', kind: 'container', role: 'gateway', state: 'running' },
    ])
  })
})

describe('isolated backend decisions (scripted docker CLI)', () => {
  const executionId = 'sx_isolatedunit0a'
  const name = containerNameFor(executionId)

  type Reply = { ok: boolean; stdout?: string; stderr?: string }
  function scripted(responses: Record<string, (args: string[]) => Reply>) {
    const calls: string[][] = []
    const docker: DockerCli = async (args) => {
      calls.push(args)
      const respond = responses[args[0]!] ?? ((): Reply => ({ ok: true }))
      const r = respond(args)
      return { ok: r.ok, code: r.ok ? 0 : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }
    return { docker, calls, verbs: () => calls.map((c) => c[0]) }
  }

  const inspectJson = (labels: Record<string, string>, status = 'exited') => JSON.stringify({ State: { Status: status, ExitCode: 0, OOMKilled: false, StartedAt: '2026-10-08T10:00:00Z', FinishedAt: '2026-10-08T10:00:01Z' }, Config: { Labels: labels } })
  const ownLabels = { 'audivra.owner': 'security-execution', 'audivra.execution': executionId, 'audivra.engagement': 'eng0000001' }

  async function spec(): Promise<{ spec: BackendSpec; events: string[] }> {
    const env = harness()
    const { executionId: id } = await env.submit()
    const row = env.executions.rows.get(id)!
    const events: string[] = []
    const ws = new ExecutionWorkspace(workspace, executionId)
    return {
      events,
      spec: {
        executionId,
        snapshot: { ...row.snapshot, executionId },
        capability: new CapabilityRegistry().register(isolated()).get('test.isolated')!,
        context: {} as BackendSpec['context'],
        input: { target: TARGET },
        handles: {} as BackendSpec['handles'],
        workspace: ws,
        stop: new AbortController(),
        events: async (type) => {
          events.push(type)
        },
      },
    }
  }

  it('refuses to prepare when the pinned image is not present, and never pulls or creates anything', async () => {
    const { docker, verbs } = scripted({ image: () => ({ ok: false, stderr: 'No such image' }) })
    const { spec: s } = await spec()
    await expect(new IsolatedContainerBackend({ docker }).prepare(s)).rejects.toMatchObject({ kind: 'runtime-unavailable', rule: 'runtime.image-unavailable' })
    expect(verbs()).toEqual(['image'])
    expect(verbs()).not.toContain('pull')
  })

  it('never touches a container at its name that is not labelled as this execution\'s', async () => {
    const { docker, verbs } = scripted({ inspect: () => ({ ok: true, stdout: inspectJson({ 'audivra.owner': 'someone-else' }) }) })
    const { spec: s } = await spec()
    await expect(new IsolatedContainerBackend({ docker }).prepare(s)).rejects.toMatchObject({ rule: 'container.name-conflict' })
    expect(verbs()).not.toContain('rm')
    expect(verbs()).not.toContain('create')
    const backend = new IsolatedContainerBackend({ docker })
    await expect(backend.removeOwnedResource({ executionId, engagementId: 'eng0000001', name, kind: 'container', role: 'executor', state: 'exited' })).rejects.toThrow(/could not be proven/)
    expect(verbs()).not.toContain('rm')
  })

  it('cleans up idempotently, removing only the exact owned container, and reports a failed removal', async () => {
    const { spec: s, events } = await spec()
    let present = true
    const ok = scripted({
      inspect: () => (present ? { ok: true, stdout: inspectJson(ownLabels) } : { ok: false, stderr: 'Error: No such container: x' }),
      rm: (args) => {
        expect(args).toEqual(['rm', '--force', name])
        present = false
        return { ok: true }
      },
    })
    const backend = new IsolatedContainerBackend({ docker: ok.docker })
    const prepared = (await backend.resume(s)).prepared
    expect((await backend.cleanup(prepared)).container).toMatchObject({ name, removed: true })
    expect((await backend.cleanup(prepared)).container).toMatchObject({ removed: true })
    expect(ok.calls.filter((c) => c[0] === 'rm')).toHaveLength(1)
    expect(events).toEqual(['execution.container-removed'])

    const stuck = scripted({ inspect: () => ({ ok: true, stdout: inspectJson(ownLabels) }), rm: () => ({ ok: false, stderr: 'device busy' }) })
    const stuckBackend = new IsolatedContainerBackend({ docker: stuck.docker })
    const { spec: s2, events: events2 } = await spec()
    await expect(stuckBackend.cleanup((await stuckBackend.resume(s2)).prepared)).rejects.toThrow(/could not be removed: device busy/)
    expect(events2).toEqual(['execution.container-cleanup-failed'])
  })

  it('reports what an execution left behind without changing anything', async () => {
    const { spec: s } = await spec()
    for (const [status, state] of [['running', 'running'], ['exited', 'exited'], ['created', 'created']] as const) {
      const fake = scripted({ inspect: () => ({ ok: true, stdout: inspectJson(ownLabels, status) }), wait: () => ({ ok: true, stdout: '0' }), logs: () => ({ ok: true }) })
      const remains = await new IsolatedContainerBackend({ docker: fake.docker }).resume(s)
      expect(remains.state).toBe(state)
      expect(fake.verbs().filter((v) => v === 'rm' || v === 'kill' || v === 'stop' || v === 'start' || v === 'create')).toEqual([])
    }
    const gone = scripted({ inspect: () => ({ ok: false, stderr: 'Error: No such container' }) })
    expect((await new IsolatedContainerBackend({ docker: gone.docker }).resume(s)).state).toBe('missing')
    const down = scripted({ inspect: () => ({ ok: false, stderr: 'error during connect: daemon not running' }) })
    await expect(new IsolatedContainerBackend({ docker: down.docker }).resume(s)).rejects.toMatchObject({ kind: 'runtime-unavailable' })
  })
})

describe('artifact budget watchdog', () => {
  it('stops an execution whose files outgrow its budget while it is still running', async () => {
    const growing = new CapabilityRegistry().register({
      metadata: { ...BASE, id: 'test.growing', implementation: 'test/growing@1', execution: undefined, resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: false } },
      implementation: {
        id: 'test/growing@1',
        input: z.strictObject({ target: z.string() }),
        targets: (i) => [i.target],
        async execute(_context, _input, handles) {
          await writeFile(path.join(handles.workspace.outputs, 'growing.bin'), Buffer.alloc(1_500_000, 1))
          await new Promise((resolve) => handles.signal.addEventListener('abort', resolve, { once: true }))
          throw new Error('stopped')
        },
      },
    })
    const env = harness({ registry: growing, scope: { limits: { maxArtifactMb: 1 } } })
    const outcome = await env.broker.submit({ engagementId: env.store.engagement.id, capabilityId: 'test.growing', input: { target: TARGET }, actor: user })
    const runtime = new ExecutionRuntime({ registry: growing, store: env.store, executions: env.executions, workspaceRoot: () => workspace, checkResources: okResources, pollIntervalMs: 50, cancelGraceMs: 500 })
    const started = Date.now()
    expect(await runtime.run(outcome.executionId)).toBe('failed')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(env.executions.rows.get(outcome.executionId)!.failure).toMatchObject({ kind: 'artifact-limit', rule: 'artifact.budget-exceeded' })
  }, 30_000)
})
