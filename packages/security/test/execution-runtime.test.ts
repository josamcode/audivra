import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { liveOwnedForExecution, processIdentity, runProcess } from '@audivra/tool-runtime'
import type { ExecutionStatus, ScopeManifestInput, SecurityCapabilityMetadata } from '@audivra/contracts'
import {
  CapabilityBroker,
  CapabilityRegistry,
  ExecutionRuntime,
  InProcessBackend,
  requestExecutionCancel,
  runtimeCheckCapability,
  snapshotHash,
  type ExecutionRuntimeOptions,
  type SecurityCapability,
} from '../src/index.ts'
import { MemoryStore, snapshot, verifiedLocal } from './memory-store.ts'
import { MemoryExecutionStore, MemoryQueue } from './memory-executions.ts'

/*
 * The durable execution runtime with in-memory stores and the real in-process backend: real owned
 * child processes, real files, real timers. PostgreSQL and pg-boss are covered by the integration tests.
 */

const PORT = 4998
const TARGET = `http://127.0.0.1:${PORT}/`
const workspace = mkdtempSync(path.join(os.tmpdir(), 'audivra-runtime-'))
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const okResources = async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const children: ChildProcess[] = []

afterAll(() => rmSync(workspace, { recursive: true, force: true, maxRetries: 5 }))
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>

async function until<T>(check: () => T | Promise<T>, ms = 20_000): Promise<Truthy<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as Truthy<T>
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(50)
  }
}

/** A test capability around a custom executor; metadata defaults mirror the runtime check. */
function testCapability(
  id: string,
  execute: SecurityCapability<{ target: string }>['implementation']['execute'],
  patch: Partial<SecurityCapabilityMetadata> = {},
): SecurityCapability<{ target: string }> {
  return {
    metadata: {
      id,
      version: 1,
      family: 'diagnostic',
      name: `Test ${id}`,
      description: 'Test capability for the execution runtime.',
      riskClass: 'passive',
      sideEffect: 'read-only',
      supportedEnvironments: ['production', 'staging', 'isolated-lab'],
      requiresAuthorization: true,
      requiresIdentity: false,
      requiresNetwork: false,
      requiresExternalIntegration: false,
      supportsCancellation: true,
      rateLimitClass: 'none',
      resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: true },
      timeoutProfile: { defaultSeconds: 30, maxSeconds: 900 },
      evidenceTypes: ['tool-result'],
      implementation: `test/${id}@1`,
      ...patch,
    },
    implementation: { id: patch.implementation ?? `test/${id}@1`, input: z.strictObject({ target: z.string() }), targets: (input) => [input.target], execute },
  }
}

const captured: { hosts: string[]; timeout: number }[] = []
const TEST_CAPABILITIES = [
  testCapability('test.fail', async () => {
    throw new Error('exploded while holding password=hunter2')
  }),
  testCapability('test.capture', async (context) => {
    captured.push({ hosts: context.scope.manifest.hosts.map((h) => h.host), timeout: context.limits.executionTimeoutSeconds })
    return { output: { ok: true }, summary: 'captured' }
  }),
  // Ignores the stop signal: starts an owned process outside `handles.processes` and never returns.
  testCapability('test.stubborn', async (_context, _input, handles) => {
    void runProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], owner: handles.processOwner })
    await new Promise(() => {})
    return { output: null, summary: 'unreachable' }
  }),
  testCapability('test.big-artifact', async (_context, _input, handles) => {
    const file = path.join(handles.workspace.artifacts, 'big.bin')
    await writeFile(file, Buffer.alloc(1_500_000, 1))
    await handles.evidence.record({ type: 'tool-result', title: 'Big', summary: 'Too big for the budget', artifactPath: handles.workspace.relative(file) })
    return { output: null, summary: 'unreachable' }
  }),
  testCapability('test.unregistered', async (_context, _input, handles) => {
    await writeFile(path.join(handles.workspace.outputs, 'dump.bin'), Buffer.alloc(1_500_000, 2))
    return { output: { wrote: 1_500_000 }, summary: 'wrote an unregistered file' }
  }),
  testCapability(
    'test.no-spawn',
    async (_context, _input, handles) => {
      await handles.processes.run({ command: process.execPath, args: ['-e', '0'] })
      return { output: null, summary: 'unreachable' }
    },
    { resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: false } },
  ),
  testCapability('test.escape', async (_context, _input, handles) => {
    await mkdir(path.join(handles.workspace.root, 'elsewhere'), { recursive: true })
    await writeFile(path.join(handles.workspace.root, 'elsewhere', 'x.txt'), 'outside')
    await handles.evidence.record({ type: 'tool-result', title: 'Escape', summary: 'Outside the execution', artifactPath: 'elsewhere/x.txt' })
    return { output: null, summary: 'unreachable' }
  }),
]

function harness(options: { scope?: ScopeManifestInput; runtime?: Partial<ExecutionRuntimeOptions>; registry?: CapabilityRegistry } = {}) {
  const scope: ScopeManifestInput = { hosts: [{ host: '127.0.0.1', ports: [PORT] }], protocols: ['http'], ...options.scope }
  const store = new MemoryStore(snapshot(PORT, { scopeInput: scope }), [verifiedLocal(PORT)])
  const executions = new MemoryExecutionStore()
  const queue = new MemoryQueue(executions)
  const registry = options.registry ?? TEST_CAPABILITIES.reduce((r, c) => r.register(c), new CapabilityRegistry().register(runtimeCheckCapability))
  const broker = new CapabilityBroker({ registry, store, checkResources: okResources, workspaceRoot: () => workspace, executions: { store: executions, queue } })
  const runtime = new ExecutionRuntime({
    registry,
    store,
    executions,
    queue,
    workspaceRoot: () => workspace,
    checkResources: okResources,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 200,
    cancelGraceMs: 1500,
    maxActive: 8,
    ...options.runtime,
  })
  const submit = async (capabilityId = 'diagnostic.runtime-check', input: Record<string, unknown> = {}) => {
    const outcome = await broker.submit({ engagementId: store.engagement.id, capabilityId, input: { target: TARGET, ...input }, actor: user })
    expect(outcome.status, outcome.decision.reason).toBe('queued')
    return outcome.executionId
  }
  const types = (id: string) => store.events.filter((e) => e.executionId === id).map((e) => e.type)
  const row = (id: string) => executions.rows.get(id)!
  /** PIDs of the owned processes an execution is running right now. */
  const ownedPids = (id: string) => until(() => liveOwnedForExecution(id).map((p) => p.pid).filter(Boolean).length && liveOwnedForExecution(id).map((p) => p.pid))
  return { store, executions, queue, registry, broker, runtime, submit, types, row, ownedPids }
}

describe('durable submission through the capability broker', () => {
  it('accepts an allowed request as a queued execution with a hashed trusted snapshot', async () => {
    const { submit, row, queue, store, types } = harness()
    const id = await submit('diagnostic.runtime-check', { holdSeconds: 0 })
    const execution = row(id)
    expect(execution).toMatchObject({ status: 'queued', capabilityId: 'diagnostic.runtime-check', capabilityVersion: 1, environment: 'staging', configVersion: 3 })
    expect(execution.snapshotHash).toBe(snapshotHash(execution.snapshot))
    expect(execution.snapshot).toMatchObject({
      executionId: id,
      engagement: { id: store.engagement.id, configVersion: 3 },
      environment: 'staging',
      authorization: { required: true, state: 'valid', authorizationIds: [verifiedLocal(PORT).id] },
      scope: { version: 1, hash: store.engagement.scopeHash },
      policy: { profileKey: 'standard', profileVersion: 1, risk: 'allowed', mutation: 'allowed' },
      capability: { id: 'diagnostic.runtime-check', implementation: 'builtin/runtime-check@1', evidenceTypes: ['tool-result'] },
      runtime: { timeoutSeconds: 900, maxProcesses: 4, cancelGraceSeconds: 5 },
      input: { target: TARGET, holdSeconds: 0 },
      allowedTargets: [TARGET],
    })
    expect(execution.snapshot.decision.eventId).toBe(store.events.find((e) => e.type === 'capability.allowed')!.id)
    expect(queue.sent).toEqual([id])
    expect(types(id)).toEqual(['capability.requested', 'capability.allowed', 'execution.requested', 'execution.queued'])
    expect(store.events.find((e) => e.type === 'execution.queued')!.data).toMatchObject({ jobId: execution.jobId })
  })

  it('creates no execution for a denied request, and requests cannot carry trusted fields', async () => {
    const { broker, store, executions, queue } = harness()
    const base = { engagementId: store.engagement.id, capabilityId: 'diagnostic.runtime-check', actor: user }
    expect((await broker.submit({ ...base, input: { target: 'http://127.0.0.1:1/' } })).decision).toMatchObject({ decision: 'deny', stage: 'scope' })
    expect((await broker.submit({ ...base, input: { target: TARGET }, environment: 'isolated-lab' })).decision.rule).toBe('request.invalid')
    expect((await broker.submit({ ...base, input: { target: TARGET, limits: { executionTimeoutSeconds: 99_999 } } })).decision.rule).toBe('input.invalid')
    expect(executions.rows.size).toBe(0)
    expect(queue.sent).toEqual([])
  })
})

describe('execution runtime', () => {
  it('runs the harmless capability end to end: owned process, artifact evidence, cleanup, final state', async () => {
    const { submit, runtime, row, types, store, executions } = harness()
    const id = await submit('diagnostic.runtime-check', { holdSeconds: 1, note: 'unit' })
    expect(await runtime.run(id)).toBe('succeeded')
    const execution = row(id)
    expect(execution.failure).toBeNull()
    expect(execution.exit).toMatchObject({ outcome: 'succeeded', processes: { started: 1 }, artifacts: { registered: 1 }, abandoned: false })
    expect(execution.startedAt).toBeInstanceOf(Date)
    expect(execution.finishedAt).toBeInstanceOf(Date)
    expect(types(id)).toEqual([
      'capability.requested',
      'capability.allowed',
      'execution.requested',
      'execution.queued',
      'execution.preparing',
      'execution.started',
      'execution.cleanup-started',
      'execution.cleanup-completed',
      'execution.completed',
    ])
    expect(executions.transitions.filter((t) => t.id === id).map((t) => t.to)).toEqual(['preparing', 'running', 'finalizing', 'succeeded'])
    const [evidence] = store.evidence
    expect(evidence).toMatchObject({ type: 'tool-result', artifactPath: `executions/${id}/artifacts/runtime-check.txt`, provenance: { executionId: id, capabilityId: 'diagnostic.runtime-check', decisionEventId: execution.decisionEventId } })
    expect((evidence!.metadata.artifact as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
    const dir = path.join(workspace, 'executions', id)
    expect(readFileSync(path.join(dir, 'artifacts', 'runtime-check.txt'), 'utf8')).toContain(`execution:   ${id}`)
    expect(JSON.parse(readFileSync(path.join(dir, 'inputs', 'input.json'), 'utf8')).input).toMatchObject({ holdSeconds: 1, note: 'unit' })
    expect(existsSync(path.join(dir, 'tmp'))).toBe(false)
    expect(execution.result).toMatchObject({ outcome: 'succeeded', evidenceRefs: [evidence!.ref], processesStarted: 1 })
    // A second delivery of the same job never runs it again.
    expect(await runtime.run(id)).toBe('succeeded')
    expect(types(id).filter((t) => t === 'execution.started')).toHaveLength(1)
  }, 60_000)

  it('runs from the stored snapshot, never from the engagement as it is now', async () => {
    const { submit, runtime, store } = harness()
    const id = await submit('test.capture')
    // Change the engagement without a version bump (the snapshot must still be what runs).
    store.engagement.scope = { ...store.engagement.scope, hosts: [...store.engagement.scope.hosts, { host: 'evil.test', includeSubdomains: true }] }
    store.engagement.scope.limits = { executionTimeoutSeconds: 1 }
    captured.length = 0
    expect(await runtime.run(id)).toBe('succeeded')
    expect(captured).toEqual([{ hosts: ['127.0.0.1'], timeout: 900 }])
  })

  it('refuses to start when the configuration changed, an authorization was withdrawn, or the snapshot was tampered with', async () => {
    const env = harness()
    const changed = await env.submit('test.capture')
    env.store.engagement.configVersion += 1
    expect(await env.runtime.run(changed)).toBe('failed')
    expect(env.row(changed).failure).toMatchObject({ kind: 'preflight-failed', rule: 'execution.config-changed' })

    const env2 = harness()
    const revoked = await env2.submit('test.capture')
    env2.store.authorizations[0] = { ...env2.store.authorizations[0]!, effectiveStatus: 'expired' }
    expect(await env2.runtime.run(revoked)).toBe('failed')
    expect(env2.row(revoked).failure).toMatchObject({ kind: 'preflight-failed', rule: 'execution.authorization-withdrawn' })

    const env3 = harness()
    const tampered = await env3.submit('test.capture')
    const stored = env3.row(tampered).snapshot
    env3.executions.patchRaw(tampered, { snapshot: { ...stored, limits: { ...stored.limits, executionTimeoutSeconds: 86_400 } } })
    captured.length = 0
    expect(await env3.runtime.run(tampered)).toBe('failed')
    expect(env3.row(tampered).failure).toMatchObject({ kind: 'preflight-failed', rule: 'execution.snapshot-invalid' })
    expect(captured).toEqual([])
    for (const [h, id] of [[env, changed], [env2, revoked], [env3, tampered]] as const) {
      expect(h.types(id)).not.toContain('execution.started')
      expect(h.types(id).at(-1)).toBe('execution.failed')
    }
  })

  it('refuses to run a capability that changed after the decision', async () => {
    const { submit, store, executions } = harness()
    const id = await submit('test.capture')
    const changed = testCapability('test.capture', async () => ({ output: null, summary: 'v2' }), { version: 2 })
    const runtime = new ExecutionRuntime({ registry: new CapabilityRegistry().register(changed), store, executions, workspaceRoot: () => workspace, checkResources: okResources, pollIntervalMs: 50 })
    expect(await runtime.run(id)).toBe('failed')
    expect(executions.rows.get(id)!.failure).toMatchObject({ kind: 'preflight-failed', rule: 'execution.capability-changed' })
  })

  it('classifies an executor error and redacts its message', async () => {
    const { submit, runtime, row } = harness()
    const id = await submit('test.fail')
    expect(await runtime.run(id)).toBe('failed')
    expect(row(id).failure).toMatchObject({ kind: 'executor-failed', rule: 'executor.error' })
    expect(JSON.stringify(row(id))).not.toContain('hunter2')
  })

  it('enforces the wall-clock limit itself and stops only the execution\'s owned process', async () => {
    const { submit, runtime, row, types, ownedPids } = harness({ scope: { limits: { executionTimeoutSeconds: 1 } } })
    const id = await submit('diagnostic.runtime-check', { holdSeconds: 60 })
    const started = Date.now()
    const running = runtime.run(id)
    const [pid] = await ownedPids(id)
    expect(alive(pid!)).toBe(true)
    expect(await running).toBe('timed-out')
    expect(Date.now() - started).toBeLessThan(15_000)
    await until(() => !alive(pid!))
    expect(row(id).failure).toMatchObject({ kind: 'timeout', rule: 'runtime.timeout' })
    expect(row(id).exit).toMatchObject({ outcome: 'timeout', abandoned: false, processes: { started: 1, terminated: 1 } })
    expect(row(id).snapshot.runtime.timeoutSeconds).toBe(1)
    expect(types(id).slice(-3)).toEqual(['execution.cleanup-started', 'execution.cleanup-completed', 'execution.timed-out'])
  }, 60_000)

  it('times out code that ignores the stop request: terminates its owned process exactly and abandons it', async () => {
    const { submit, runtime, row, ownedPids } = harness({ scope: { limits: { executionTimeoutSeconds: 1 } } })
    const id = await submit('test.stubborn')
    const running = runtime.run(id)
    const [pid] = await ownedPids(id)
    expect(await running).toBe('timed-out')
    await until(() => !alive(pid!))
    expect(row(id).exit).toMatchObject({ outcome: 'timeout', abandoned: true })
    expect(row(id).exit!.processes.terminated).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('cancels a running execution idempotently, and cancelling A never affects B or unrelated processes', async () => {
    const { submit, runtime, row, types, executions, store, ownedPids } = harness()
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    children.push(unrelated)
    const a = await submit('diagnostic.runtime-check', { holdSeconds: 60 })
    const b = await submit('diagnostic.runtime-check', { holdSeconds: 60 })
    const runA = runtime.run(a)
    const runB = runtime.run(b)
    const [pidA] = await ownedPids(a)
    const [pidB] = await ownedPids(b)
    await until(() => row(a).status === 'running' && row(b).status === 'running')

    const first = await requestExecutionCancel({ store, executions }, a, user)
    expect(first).toMatchObject({ changed: true, execution: { status: 'cancelling' } })
    expect((await requestExecutionCancel({ store, executions }, a, user)).changed).toBe(false)
    expect(await runA).toBe('cancelled')
    await until(() => !alive(pidA!))
    expect(alive(pidB!)).toBe(true)
    expect(alive(unrelated.pid!)).toBe(true)
    expect(row(b).status).toBe('running')
    expect(row(a)).toMatchObject({ status: 'cancelled', failure: { kind: 'cancelled', message: 'Cancelled by the user' }, cancelRequestedBy: user, exit: { processes: { started: 1, terminated: 1 } } })
    expect(types(a).slice(-4)).toEqual(['execution.cancel-requested', 'execution.cleanup-started', 'execution.cleanup-completed', 'execution.cancelled'])
    expect((await requestExecutionCancel({ store, executions }, a, user)).changed).toBe(false)

    await requestExecutionCancel({ store, executions }, b, user)
    expect(await runB).toBe('cancelled')
    await until(() => !alive(pidB!))
    expect(alive(unrelated.pid!)).toBe(true)
  }, 90_000)

  it('cancels a queued execution at once; it never starts, and finished executions cannot be cancelled', async () => {
    const { submit, runtime, row, types, store, executions } = harness()
    const id = await submit('test.capture')
    await requestExecutionCancel({ store, executions }, id, user)
    expect(row(id)).toMatchObject({ status: 'cancelled', failure: { rule: 'execution.cancelled-before-start' } })
    expect(await runtime.run(id)).toBe('cancelled')
    expect(types(id)).not.toContain('execution.preparing')
    const done = await submit('test.capture')
    await runtime.run(done)
    await expect(requestExecutionCancel({ store, executions }, done, user)).rejects.toMatchObject({ status: 409 })
  })

  it('stops an execution when its engagement is paused', async () => {
    const { submit, runtime, row, store } = harness()
    const id = await submit('diagnostic.runtime-check', { holdSeconds: 60 })
    const running = runtime.run(id)
    await until(() => row(id).status === 'running')
    store.engagement.status = 'paused'
    expect(await running).toBe('cancelled')
    expect(row(id)).toMatchObject({ cancelRequestedBy: { kind: 'system', id: 'execution-runtime' }, failure: { message: 'Cancelled by Audivra' } })
  }, 60_000)

  it('enforces the artifact budget at registration and at finalization', async () => {
    const { submit, runtime, row, store } = harness({ scope: { limits: { maxArtifactMb: 1 } } })
    const registered = await submit('test.big-artifact')
    expect(await runtime.run(registered)).toBe('failed')
    expect(row(registered).failure).toMatchObject({ kind: 'artifact-limit', rule: 'artifact.budget-exceeded' })
    expect(store.evidence).toHaveLength(0)
    const unregistered = await submit('test.unregistered')
    expect(await runtime.run(unregistered)).toBe('failed')
    expect(row(unregistered).failure).toMatchObject({ kind: 'artifact-limit', rule: 'artifact.budget-exceeded' })
    expect(row(unregistered).result).toMatchObject({ outcome: 'succeeded' })
  })

  it('enforces the process limit and keeps evidence inside the execution workspace', async () => {
    const { submit, runtime, row } = harness()
    const spawned = await submit('test.no-spawn')
    expect(await runtime.run(spawned)).toBe('failed')
    expect(row(spawned).failure).toMatchObject({ kind: 'process-limit', rule: 'runtime.process-limit' })
    const escaped = await submit('test.escape')
    expect(await runtime.run(escaped)).toBe('failed')
    expect(row(escaped).failure).toMatchObject({ kind: 'artifact-limit', rule: 'artifact.outside-execution' })
  })

  it('reports a cleanup failure instead of claiming success', async () => {
    class BrokenCleanup extends InProcessBackend {
      override async cleanup(): Promise<{ removedBytes: number }> {
        throw new Error('scratch space is locked')
      }
    }
    const { submit, runtime, row, types } = harness({ runtime: { backend: new BrokenCleanup() } })
    const id = await submit('test.capture')
    expect(await runtime.run(id)).toBe('failed')
    expect(row(id).failure).toMatchObject({ kind: 'cleanup-failed' })
    expect(row(id).failure!.message).toContain('scratch space is locked')
    expect(types(id).slice(-2)).toEqual(['execution.cleanup-completed', 'execution.failed'])
  })

  it('holds the execution concurrency limit: a second execution waits until a slot is free', async () => {
    const { submit, runtime, row } = harness({ runtime: { maxActive: 1 } })
    const a = await submit('diagnostic.runtime-check', { holdSeconds: 2 })
    const b = await submit('diagnostic.runtime-check', { holdSeconds: 0 })
    const runA = runtime.run(a)
    await until(() => row(a).status === 'running')
    const runB = runtime.run(b)
    await sleep(500)
    expect(row(b).status).toBe('queued')
    expect(await runA).toBe('succeeded')
    expect(await runB).toBe('succeeded')
    expect(row(b).startedAt!.getTime()).toBeGreaterThanOrEqual(row(a).finishedAt!.getTime())
  }, 60_000)

  it('interrupts running executions on shutdown and terminates their owned processes', async () => {
    const { submit, runtime, row, ownedPids } = harness()
    const id = await submit('diagnostic.runtime-check', { holdSeconds: 60 })
    const running = runtime.run(id)
    const [pid] = await ownedPids(id)
    await runtime.shutdown()
    expect(await running).toBe('interrupted')
    await until(() => !alive(pid!))
    expect(row(id).failure).toMatchObject({ kind: 'worker-interrupted', rule: 'runtime.shutdown' })
    expect(await runtime.run(await submit('test.capture'))).toBeNull()
  }, 60_000)
})

describe('recovery after a worker stops', () => {
  /** A runner record of a worker process that has exited. */
  async function deadRunner() {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    const identity = await processIdentity(child.pid!)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exited
    return { ownerId: `dead-host:${child.pid}:x`, host: os.hostname(), pid: child.pid!, processStartedAt: identity?.startedAt.toISOString() ?? null, backend: 'in-process' }
  }

  it('reconciles executions of a dead worker conservatively and leaves a live worker\'s alone', async () => {
    const { submit, runtime, executions, queue, row, types } = harness()
    const dead = await deadRunner()
    const me = await runtime.runner()
    const ids = {
      running: await submit('test.capture'),
      preparing: await submit('test.capture'),
      finalizing: await submit('test.capture'),
      cancelling: await submit('test.capture'),
      live: await submit('test.capture'),
      lostJob: await submit('test.capture'),
      queued: await submit('test.capture'),
    }
    const result = { outcome: 'succeeded' as const, summary: 'done before the crash', output: { ok: true }, failure: null, evidenceRefs: [], artifactBytes: 0, processesStarted: 0, endedAt: new Date().toISOString() }
    const at = new Date()
    executions.patchRaw(ids.running, { status: 'running', runner: dead, startedAt: at })
    executions.patchRaw(ids.preparing, { status: 'preparing', runner: dead, startedAt: at })
    executions.patchRaw(ids.finalizing, { status: 'finalizing', runner: dead, startedAt: at, result })
    executions.patchRaw(ids.cancelling, { status: 'cancelling', runner: dead, startedAt: at, cancelRequestedBy: user })
    // Held by a different, live instance on this machine (this test process): never touched.
    executions.patchRaw(ids.live, { status: 'running', runner: { ...me, ownerId: 'other-live-instance' }, startedAt: at })
    executions.jobs.delete(ids.lostJob)
    const sentBefore = queue.sent.length

    const report = await runtime.recover()
    const statuses = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, row(id).status])) as Record<keyof typeof ids, ExecutionStatus>
    expect(statuses).toEqual({ running: 'interrupted', preparing: 'interrupted', finalizing: 'succeeded', cancelling: 'cancelled', live: 'running', lostJob: 'queued', queued: 'queued' })
    expect(report.skipped).toEqual([ids.live])
    expect(report.requeued).toEqual([ids.lostJob])
    expect(queue.sent.slice(sentBefore)).toEqual([ids.lostJob])
    expect(row(ids.running).failure).toMatchObject({ kind: 'worker-interrupted', rule: 'runtime.worker-interrupted' })
    expect(row(ids.finalizing)).toMatchObject({ failure: null, exit: { summary: 'done before the crash' } })
    expect(types(ids.running).slice(-4)).toEqual(['execution.recovered', 'execution.cleanup-started', 'execution.cleanup-completed', 'execution.failed'])
    expect(types(ids.live)).not.toContain('execution.recovered')

    // Idempotent: a second pass changes nothing, and a redelivered job of a recovered execution is a no-op.
    const again = await runtime.recover()
    expect(again.reconciled).toEqual([])
    expect(await runtime.run(ids.running)).toBe('interrupted')
    expect(types(ids.running).filter((t) => t === 'execution.recovered')).toHaveLength(1)
  }, 60_000)

  it('a redelivered job of an execution whose worker died reconciles it instead of running it again', async () => {
    const { submit, runtime, executions, row, types } = harness()
    const id = await submit('test.capture')
    executions.patchRaw(id, { status: 'running', runner: await deadRunner(), startedAt: new Date() })
    expect(await runtime.run(id)).toBe('interrupted')
    expect(types(id)).toContain('execution.recovered')
    expect(types(id)).not.toContain('execution.started')
    expect(row(id).failure).toMatchObject({ kind: 'worker-interrupted' })
  }, 30_000)
})
