import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { engagementWorkspaceDir, getLogger, REPO_ROOT } from '@audivra/config'
import type { ExecutionStatus, ScopeManifest, SecurityEngagementDetail } from '@audivra/contracts'
import { createBoss, ensureQueues, processStore, QUEUES, type PgBoss, type SecurityExecutionRow } from '@audivra/database'
import {
  APPROVED_RUNTIMES,
  containerNameFor,
  createDbExecutionStore,
  createDurableBroker,
  createDbSecurityStore,
  createRuntimeRegistry,
  ExecutionRuntime,
  ExecutionService,
  IsolatedContainerBackend,
  runtimeImageRef,
  SecurityService,
  type CapabilityBroker,
  type PreparedExecution,
  type Resolver,
} from '@audivra/security'
import { setProcessStore } from '@audivra/tool-runtime'
import { createSecurityExecutionWorker, type SecurityExecutionWorker } from '../src/security-executions.ts'
import { resetDb, startScopeFixture, testDb, type ScopeFixture } from '../../../test/helpers.ts'

/*
 * The isolated container backend on the real stack: PostgreSQL, pg-boss, the worker and Docker. Every
 * container these tests create has a unique name and is removed by that exact name; nothing is pruned.
 * Skipped (not failed) when Docker or the approved runtime image is not available on this machine.
 */

const run = promisify(execFile)
const IMAGE = runtimeImageRef(APPROVED_RUNTIMES[0]!)

async function docker(...args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('docker', args, { windowsHide: true, timeout: 60_000 })
    return { ok: true, stdout: stdout.trim(), stderr }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, stdout: (e.stdout ?? '').trim(), stderr: e.stderr ?? String(error) }
  }
}

const dockerReady = (await docker('image', 'inspect', IMAGE, '--format', '{{.Id}}')).ok

const handle = testDb()
const { db, pool } = handle
const log = getLogger()
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const resolver: Resolver = async (host) => {
  if (host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver })
const executions = new ExecutionService({ db })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const children: ChildProcess[] = []
/** Every container name a test created or that an execution may leave: removed exactly in afterAll. */
const createdContainers = new Set<string>()

let boss: PgBoss
let worker: SecurityExecutionWorker
let broker: CapabilityBroker
let fixture: ScopeFixture

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>
async function until<T>(check: () => T | Promise<T>, ms = 60_000, what = 'condition'): Promise<Truthy<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as Truthy<T>
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`)
    await sleep(150)
  }
}

const row = async (id: string): Promise<SecurityExecutionRow> => (await createDbExecutionStore(db).get(id))!
const settled = (id: string, ...statuses: ExecutionStatus[]) =>
  until(async () => {
    const current = await row(id)
    return statuses.includes(current.status) && current
  }, 90_000, `${id} reaching ${statuses.join('/')}`)
const containerState = async (name: string) => {
  const result = await docker('inspect', '--type', 'container', '--format', '{{.State.Status}}', name)
  return result.ok ? result.stdout : 'absent'
}
const containerRunning = (name: string) => until(async () => (await containerState(name)) === 'running', 60_000, `${name} running`)

async function readyEngagement(limits: ScopeManifest['limits'] = {}): Promise<SecurityEngagementDetail> {
  const created = await service.createEngagement({ name: 'Isolated runtime fixture', targetUrl: fixture.url, environment: 'staging' })
  if (Object.keys(limits).length) await service.updateScope(created.id, { manifest: { ...created.scope, limits } })
  return (await service.requestAuthorization(created.id, { method: 'local-development' })).engagement
}

async function submit(engagement: SecurityEngagementDetail, holdSeconds: number): Promise<string> {
  const outcome = await broker.submit({ engagementId: engagement.id, capabilityId: 'diagnostic.isolated-check', input: { target: fixture.url, holdSeconds }, actor: user })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  createdContainers.add(containerNameFor(outcome.executionId))
  return outcome.executionId
}

/** A container that is not Audivra's (no ownership labels) and must never be touched. */
async function unrelatedContainer(): Promise<string> {
  const name = `audivra-it-unrelated-${Math.random().toString(36).slice(2, 10)}`
  createdContainers.add(name)
  const started = await docker('run', '--detach', '--name', name, '--label', 'audivra.test=phase-2b', '--network', 'none', IMAGE, 'node', '-e', 'setInterval(() => {}, 1000)')
  expect(started.ok, started.stderr).toBe(true)
  return name
}

const eventTypes = async (id: string) => (await executions.events(id)).map((e) => e.type)

describe.skipIf(!dockerReady)('isolated container backend', () => {
  beforeAll(async () => {
    boss = createBoss(process.env.DATABASE_URL!)
    await boss.start()
    await ensureQueues(boss)
    setProcessStore({
      insert: (record) => processStore.insert(db, record),
      finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
      listStale: (ownerId) => processStore.listStale(db, ownerId),
    })
    worker = createSecurityExecutionWorker({ db, boss, log, runtime: { pollIntervalMs: 200, cancelGraceMs: 3000, maxActive: 4 } })
    broker = createDurableBroker({ db, boss, resolver })
    fixture = await startScopeFixture('primary')
  })

  afterAll(async () => {
    await worker.shutdown()
    await boss.stop({ graceful: false })
    setProcessStore(null)
    for (const name of createdContainers) await docker('rm', '--force', name)
    await fixture.close()
    await handle.close()
  })

  beforeEach(async () => {
    await boss.offWork(QUEUES.securityExecution).catch(() => undefined)
    await resetDb(handle)
    await pool.query('truncate security_engagements cascade')
    await boss.deleteAllJobs()
    await worker.start()
  })

  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  })

  it('broker → durable execution → worker → isolated container → workspace output → evidence → cleanup', async () => {
    const engagement = await readyEngagement()
    const before = fixture.total()
    const id = await submit(engagement, 4)
    const name = containerNameFor(id)
    await containerRunning(name)

    // The security profile, as Docker reports it while the container runs.
    const inspected = JSON.parse((await docker('inspect', '--type', 'container', name)).stdout)[0] as {
      HostConfig: Record<string, unknown>
      Config: { User: string; Labels: Record<string, string>; Image: string }
      Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[]
    }
    const host = inspected.HostConfig
    expect(host).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      Memory: 256 * 1_048_576,
      MemorySwap: 256 * 1_048_576,
      NanoCpus: 500_000_000,
      PidsLimit: 64,
      IpcMode: 'private',
      Init: true,
    })
    expect(host.CapDrop).toEqual(['ALL'])
    expect(host.CapAdd ?? null).toBeNull()
    expect(host.SecurityOpt).toEqual(['no-new-privileges'])
    expect(host.PidMode ?? '').toBe('')
    expect(Object.keys(host.Tmpfs as Record<string, string>)).toEqual(['/tmp'])
    expect(inspected.Config.User).not.toMatch(/^(0|root)(:|$)/)
    expect(inspected.Config.Image).toBe(IMAGE)
    expect(inspected.Config.Labels).toMatchObject({ 'audivra.owner': 'security-execution', 'audivra.execution': id, 'audivra.engagement': engagement.id, 'audivra.runtime': 'node-sandbox@1' })
    const workspaceDir = path.join(engagementWorkspaceDir(engagement.id), 'executions', id)
    // Docker Desktop may report Windows sources in its own form; each must be exactly this execution's area.
    const ownArea = (source: string, target: string) => source.replaceAll('\\', '/').toLowerCase().endsWith(`/${engagement.id}/executions/${id}/${target.split('/').pop()}`)
    const mounts = inspected.Mounts.map((m) => ({ type: m.Type, to: m.Destination, rw: m.RW, inside: ownArea(m.Source, m.Destination) }))
    expect(mounts.sort((a, b) => a.to.localeCompare(b.to))).toEqual([
      { type: 'bind', to: '/audivra/artifacts', rw: true, inside: true },
      { type: 'bind', to: '/audivra/inputs', rw: false, inside: true },
      { type: 'bind', to: '/audivra/outputs', rw: true, inside: true },
    ])
    expect(JSON.stringify(inspected.Mounts)).not.toMatch(/docker\.sock|docker_engine/)

    const done = await settled(id, 'succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted')
    expect(done.failure).toBeNull()
    expect(done.status).toBe('succeeded')
    expect(done.runner).toMatchObject({ backend: 'isolated-container' })
    expect(done.snapshot.isolation).toMatchObject({ mode: 'isolated-container', runtime: { id: 'node-sandbox', version: 1, image: IMAGE }, network: 'none', container: { memoryMb: 256, cpus: 0.5, pidsLimit: 64 } })
    expect(done.exit).toMatchObject({ outcome: 'succeeded', runtime: { backend: 'isolated-container', container: { name, exitCode: 0, oomKilled: false, removed: true } } })

    // The same profile, as the executor saw it from the inside.
    const sandbox = (done.result!.output as { sandbox: Record<string, unknown> }).sandbox
    expect(sandbox).toMatchObject({
      writable: { root: false, inputs: false, tmp: true, outputs: true },
      dockerControl: [],
      hostPaths: [],
      network: ['lo'],
      mounts: ['/audivra/artifacts', '/audivra/inputs', '/audivra/outputs'],
      cgroup: { memoryMax: String(256 * 1_048_576), pidsMax: '64', cpuMax: '50000 100000' },
      capabilities: '0000000000000000',
      noNewPrivileges: '1',
    })
    expect(sandbox.uid).not.toBe(0)

    // Only the minimum input was staged, read-only, for the executor.
    expect(JSON.parse(readFileSync(path.join(workspaceDir, 'inputs', 'input.json'), 'utf8'))).toEqual({ marker: id, holdSeconds: 4, note: null })

    const [evidence] = await executions.evidence(id)
    expect(evidence).toMatchObject({ type: 'tool-result', artifactPath: `executions/${id}/artifacts/isolated-check.txt`, provenance: { executionId: id, capabilityId: 'diagnostic.isolated-check' } })
    expect(readFileSync(path.join(engagementWorkspaceDir(engagement.id), evidence!.artifactPath!), 'utf8')).toContain('root filesystem: read-only')
    expect(await eventTypes(id)).toEqual([
      'capability.requested',
      'capability.allowed',
      'execution.requested',
      'execution.queued',
      'execution.preparing',
      'execution.container-preparing',
      'execution.container-created',
      'execution.started',
      'execution.container-started',
      'execution.container-exited',
      'execution.cleanup-started',
      'execution.container-removed',
      'execution.cleanup-completed',
      'execution.completed',
    ])
    expect(await containerState(name)).toBe('absent')
    // The docker CLI helper that waited for the container is an owned process of this execution, now closed.
    const helpers = await until(async () => {
      const { rows } = await pool.query<{ tool: string; status: string }>('select tool, status from owned_processes where security_execution_id = $1', [id])
      return rows.length > 0 && rows.every((r) => r.status !== 'running') && rows
    }, 15_000, 'helper records closed')
    expect(new Set(helpers.map((h) => h.tool))).toEqual(new Set(['runtime:docker']))
    expect(fixture.total()).toBe(before)
  }, 120_000)

  it('two simultaneous executions cannot see each other\'s files', async () => {
    const engagement = await readyEngagement()
    const a = await submit(engagement, 6)
    const b = await submit(engagement, 6)
    await containerRunning(containerNameFor(a))
    await containerRunning(containerNameFor(b))
    expect([await containerState(containerNameFor(a)), await containerState(containerNameFor(b))]).toEqual(['running', 'running'])
    const [doneA, doneB] = await Promise.all([settled(a, 'succeeded', 'failed'), settled(b, 'succeeded', 'failed')])
    expect([doneA.status, doneB.status]).toEqual(['succeeded', 'succeeded'])
    const seen = (r: SecurityExecutionRow) => (r.result!.output as { sandbox: { markers: string[] } }).sandbox.markers
    expect(seen(doneA)).toEqual([`/audivra/outputs/${a}.marker`])
    expect(seen(doneB)).toEqual([`/audivra/outputs/${b}.marker`])
  }, 120_000)

  it('cancelling A stops only A\'s container; B and an unrelated container keep running', async () => {
    const engagement = await readyEngagement()
    const unrelated = await unrelatedContainer()
    const a = await submit(engagement, 120)
    const b = await submit(engagement, 120)
    await containerRunning(containerNameFor(a))
    await containerRunning(containerNameFor(b))
    await settled(a, 'running')

    expect(await executions.cancel(a, user)).toMatchObject({ status: 'cancelling' })
    expect(await executions.cancel(a, user)).toMatchObject({ status: 'cancelling' })
    const cancelled = await settled(a, 'cancelled', 'failed')
    expect(cancelled).toMatchObject({ status: 'cancelled', failure: { kind: 'cancelled' }, exit: { runtime: { container: { removed: true } } } })
    expect(await containerState(containerNameFor(a))).toBe('absent')
    expect(await containerState(containerNameFor(b))).toBe('running')
    expect(await containerState(unrelated)).toBe('running')
    expect((await row(b)).status).toBe('running')
    expect(await eventTypes(a)).toEqual(expect.arrayContaining(['execution.cancel-requested', 'execution.container-stop-requested', 'execution.container-exited', 'execution.container-removed', 'execution.cancelled']))
    // The executor flushed what it knew when it was asked to stop.
    expect(JSON.parse(readFileSync(path.join(engagementWorkspaceDir(engagement.id), 'executions', a, 'outputs', 'result.json'), 'utf8'))).toMatchObject({ status: 'stopped' })

    await executions.cancel(b, user)
    await settled(b, 'cancelled')
    expect(await containerState(containerNameFor(b))).toBe('absent')
    expect(await containerState(unrelated)).toBe('running')
  }, 180_000)

  it('stops the exact container at the policy timeout', async () => {
    const engagement = await readyEngagement({ executionTimeoutSeconds: 3 })
    const unrelated = await unrelatedContainer()
    const started = Date.now()
    const id = await submit(engagement, 120)
    await containerRunning(containerNameFor(id))
    const done = await settled(id, 'timed-out', 'failed', 'succeeded')
    expect(Date.now() - started).toBeLessThan(45_000)
    expect(done).toMatchObject({ status: 'timed-out', failure: { kind: 'timeout', rule: 'runtime.timeout' }, snapshot: { runtime: { timeoutSeconds: 3 } } })
    expect(await containerState(containerNameFor(id))).toBe('absent')
    expect(await containerState(unrelated)).toBe('running')
    expect((await eventTypes(id)).slice(-4)).toEqual(['execution.cleanup-started', 'execution.container-removed', 'execution.cleanup-completed', 'execution.timed-out'])
  }, 120_000)

  it('after a worker crash, reconciles the exact containers: stops a running one, collects a finished one, notices a missing one', async () => {
    await boss.offWork(QUEUES.securityExecution)
    const engagement = await readyEngagement()
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('apps', 'worker', 'test', 'security-worker.child.ts')], {
      cwd: REPO_ROOT,
      env: { ...process.env, LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child worker did not start')), 60_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    const unrelated = await unrelatedContainer()
    const running = await submit(engagement, 300)
    const missing = await submit(engagement, 300)
    const finishing = await submit(engagement, 6)
    for (const id of [running, missing, finishing]) await containerRunning(containerNameFor(id))

    // Crash: kill exactly the worker process. Its containers belong to Docker and keep going.
    const exited = new Promise((resolve) => child.once('exit', resolve))
    process.kill(child.pid!)
    await exited
    expect(await containerState(containerNameFor(running))).toBe('running')
    // One container disappears while no worker watches; another finishes on its own.
    await docker('rm', '--force', containerNameFor(missing))
    await until(async () => (await containerState(containerNameFor(finishing))) === 'exited', 60_000, 'finishing container exited')

    // A container labelled like an execution's, but of no execution in this database: never touched.
    const foreignId = 'sx_notinthisdb000'
    const foreign = containerNameFor(foreignId)
    createdContainers.add(foreign)
    expect((await docker('run', '--detach', '--name', foreign, '--label', 'audivra.owner=security-execution', '--label', `audivra.execution=${foreignId}`, '--label', 'audivra.engagement=foreign0001', '--network', 'none', IMAGE, 'node', '-e', 'setInterval(() => {}, 1000)')).ok).toBe(true)

    const report = await worker.recover()
    expect(report.reconciled).toEqual(expect.arrayContaining([
      { id: running, status: 'interrupted' },
      { id: missing, status: 'interrupted' },
      { id: finishing, status: 'succeeded' },
    ]))
    expect(report.containersUntouched).toContain(foreign)
    for (const id of [running, missing, finishing]) expect(await containerState(containerNameFor(id))).toBe('absent')
    expect(await containerState(unrelated)).toBe('running')
    expect(await containerState(foreign)).toBe('running')

    const recovered = async (id: string) => (await executions.events(id)).find((e) => e.type === 'execution.recovered')!.data as { action: string; container: string }
    expect(await recovered(running)).toMatchObject({ action: 'interrupted', container: 'running' })
    expect(await recovered(missing)).toMatchObject({ action: 'interrupted', container: 'missing' })
    expect(await recovered(finishing)).toMatchObject({ action: 'collected', container: 'exited' })
    expect((await row(running)).failure).toMatchObject({ kind: 'worker-interrupted' })
    // Stopped gracefully first (it flushed and exited within the grace period), then removed.
    expect(await eventTypes(running)).toEqual(expect.arrayContaining(['execution.recovered', 'execution.container-stop-requested', 'execution.container-exited', 'execution.container-removed']))
    const [evidence] = await executions.evidence(finishing)
    expect(evidence).toMatchObject({ provenance: { executionId: finishing }, artifactPath: `executions/${finishing}/artifacts/isolated-check.txt` })
    // Collected, never re-run: started once (by the crashed worker), its container started once.
    const finishingEvents = await eventTypes(finishing)
    expect(finishingEvents.filter((t) => t === 'execution.started')).toHaveLength(1)
    expect(finishingEvents.filter((t) => t === 'execution.container-started')).toHaveLength(1)

    // Idempotent.
    const again = await worker.recover()
    expect(again.reconciled).toEqual([])
    expect(again.containersRemoved).toEqual([])
    await worker.start()
  }, 240_000)

  it('on worker shutdown, a running isolated execution is interrupted and only its own container is stopped and removed', async () => {
    await boss.offWork(QUEUES.securityExecution)
    const stopping = new ExecutionRuntime({
      registry: createRuntimeRegistry(),
      store: createDbSecurityStore(db),
      executions: createDbExecutionStore(db),
      resolver,
      backends: { 'isolated-container': new IsolatedContainerBackend() },
      pollIntervalMs: 200,
      cancelGraceMs: 3000,
    })
    const engagement = await readyEngagement()
    const unrelated = await unrelatedContainer()
    const id = await submit(engagement, 300)
    const running = stopping.run(id)
    await containerRunning(containerNameFor(id))
    await settled(id, 'running')
    await stopping.shutdown()
    expect(await running).toBe('interrupted')
    expect(await row(id)).toMatchObject({ status: 'interrupted', failure: { kind: 'worker-interrupted', rule: 'runtime.shutdown' }, exit: { runtime: { container: { removed: true } } } })
    expect(await containerState(containerNameFor(id))).toBe('absent')
    expect(await containerState(unrelated)).toBe('running')
    // Nothing is left for a restart to reconcile.
    expect((await worker.recover()).reconciled).toEqual([])
    await worker.start()
  }, 120_000)

  it('a container left by a failed cleanup is kept on record and removed by a later reconciliation', async () => {
    await boss.offWork(QUEUES.securityExecution)
    class RemovalFails extends IsolatedContainerBackend {
      override async cleanup(prepared: PreparedExecution): Promise<{ removedBytes: number }> {
        await prepared.spec.events('execution.container-cleanup-failed', 'Simulated: the container could not be removed', {}, 'error')
        throw new Error('simulated removal failure')
      }
    }
    const failing = new ExecutionRuntime({
      registry: createRuntimeRegistry(),
      store: createDbSecurityStore(db),
      executions: createDbExecutionStore(db),
      resolver,
      backends: { 'isolated-container': new RemovalFails() },
      pollIntervalMs: 200,
    })
    const engagement = await readyEngagement()
    const id = await submit(engagement, 0)
    expect(await failing.run(id)).toBe('failed')
    const done = await row(id)
    expect(done).toMatchObject({ status: 'failed', failure: { kind: 'cleanup-failed' }, exit: { runtime: { container: { removed: false } } } })
    expect(await containerState(containerNameFor(id))).toBe('exited')

    const report = await worker.recover()
    expect(report.containersRemoved).toEqual([containerNameFor(id)])
    expect(await containerState(containerNameFor(id))).toBe('absent')
    expect((await executions.events(id)).at(-1)).toMatchObject({ type: 'execution.recovered', data: { action: 'container-removed' } })
    expect((await worker.recover()).containersRemoved).toEqual([])
    await worker.start()
  }, 120_000)
})
