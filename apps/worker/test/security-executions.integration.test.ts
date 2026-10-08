import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { engagementWorkspaceDir, getLogger, REPO_ROOT } from '@audivra/config'
import type { ExecutionStatus, ScopeManifest, SecurityEngagementDetail } from '@audivra/contracts'
import { createBoss, createSecurityExecution, ensureQueues, processStore, QUEUES, type PgBoss, type SecurityExecutionRow } from '@audivra/database'
import {
  CapabilityBroker,
  createBossExecutionQueue,
  createDbExecutionStore,
  createDbSecurityStore,
  createRuntimeRegistry,
  ExecutionService,
  SecurityService,
  snapshotHash,
  type Resolver,
} from '@audivra/security'
import { processIdentity, setProcessStore } from '@audivra/tool-runtime'
import { createSecurityExecutionWorker, type SecurityExecutionWorker } from '../src/security-executions.ts'
import { resetDb, startScopeFixture, testDb, type ScopeFixture } from '../../../test/helpers.ts'

/*
 * Durable security executions on the real stack: PostgreSQL, pg-boss and the worker's execution
 * runtime with real owned child processes. A second, separate worker process is crashed mid-execution
 * to prove restart reconciliation.
 */

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

let boss: PgBoss
let worker: SecurityExecutionWorker
let fixture: ScopeFixture
let broker: CapabilityBroker

beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  setProcessStore({
    insert: (record) => processStore.insert(db, record),
    finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
    listStale: (ownerId) => processStore.listStale(db, ownerId),
  })
  worker = createSecurityExecutionWorker({ db, boss, log, runtime: { pollIntervalMs: 200, cancelGraceMs: 1500 } })
  broker = new CapabilityBroker({
    registry: createRuntimeRegistry(),
    store: createDbSecurityStore(db),
    resolver,
    executions: { store: createDbExecutionStore(db), queue: createBossExecutionQueue(boss) },
  })
  fixture = await startScopeFixture('primary')
})

afterAll(async () => {
  await worker.shutdown()
  await boss.stop({ graceful: false })
  setProcessStore(null)
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>

async function until<T>(check: () => T | Promise<T>, ms = 45_000, what = 'condition'): Promise<Truthy<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as Truthy<T>
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`)
    await sleep(100)
  }
}

async function row(id: string): Promise<SecurityExecutionRow> {
  return (await createDbExecutionStore(db).get(id))!
}

const settled = (id: string, ...statuses: ExecutionStatus[]) =>
  until(async () => {
    const current = await row(id)
    return statuses.includes(current.status) && current
  }, 60_000, `${id} reaching ${statuses.join('/')}`)

/** PIDs of running owned processes recorded for an execution (from the persisted registry). */
const ownedPids = (id: string) =>
  until(async () => {
    const { rows } = await pool.query<{ pid: number }>(`select pid from owned_processes where security_execution_id = $1 and status = 'running'`, [id])
    return rows.length > 0 && rows.map((r) => r.pid)
  }, 30_000, `owned process of ${id}`)

async function readyEngagement(limits: ScopeManifest['limits'] = {}): Promise<SecurityEngagementDetail> {
  const created = await service.createEngagement({ name: 'Runtime fixture', targetUrl: fixture.url, environment: 'staging' })
  if (Object.keys(limits).length) await service.updateScope(created.id, { manifest: { ...created.scope, limits } })
  const { engagement } = await service.requestAuthorization(created.id, { method: 'local-development' })
  expect(engagement.readiness.ready).toBe(true)
  return engagement
}

async function submit(engagement: SecurityEngagementDetail, holdSeconds: number): Promise<string> {
  const outcome = await broker.submit({ engagementId: engagement.id, capabilityId: 'diagnostic.runtime-check', input: { target: fixture.url, holdSeconds }, actor: user })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  return outcome.executionId
}

const eventTypes = async (id: string) => (await executions.events(id)).map((e) => e.type)

describe('durable executions through pg-boss', () => {
  it('Capability Broker → queued execution → worker → backend → evidence → final state', async () => {
    const engagement = await readyEngagement()
    const before = fixture.total()
    const id = await submit(engagement, 1)
    expect((await pool.query('select state from pgboss.job where name = $1 and singleton_key = $2', [QUEUES.securityExecution, id])).rows).toHaveLength(1)
    const done = await settled(id, 'succeeded', 'failed', 'timed-out', 'cancelled', 'interrupted')
    expect(done).toMatchObject({ status: 'succeeded', failure: null, runner: { backend: 'in-process' } })
    expect(done.snapshotHash).toBe(snapshotHash(done.snapshot))
    expect(done.exit).toMatchObject({ outcome: 'succeeded', processes: { started: 1 }, artifacts: { registered: 1 } })
    expect(await eventTypes(id)).toEqual([
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
    const [evidence] = await executions.evidence(id)
    expect(evidence).toMatchObject({ ref: 'EV-1', type: 'tool-result', artifactPath: `executions/${id}/artifacts/runtime-check.txt`, provenance: { executionId: id, environment: 'staging', decisionEventId: done.decisionEventId } })
    const artifact = path.join(engagementWorkspaceDir(engagement.id), evidence!.artifactPath!)
    expect(readFileSync(artifact, 'utf8')).toContain(`execution:   ${id}`)
    expect((await pool.query('select engagement_id, security_execution_id from evidence')).rows).toEqual([{ engagement_id: engagement.id, security_execution_id: id }])
    const owned = await until(async () => {
      const { rows } = await pool.query(`select status, tool from owned_processes where security_execution_id = $1`, [id])
      return rows[0]?.status !== 'running' && rows
    }, 15_000, 'owned process record closed')
    expect(owned).toEqual([{ status: 'exited', tool: 'diagnostic.runtime-check' }])
    // The diagnostic never contacts the target.
    expect(fixture.total()).toBe(before)
    expect(existsSync(path.join(engagementWorkspaceDir(engagement.id), 'executions', id, 'tmp'))).toBe(false)
  }, 90_000)

  it('keeps the snapshot immutable and final executions frozen at the database level', async () => {
    const engagement = await readyEngagement()
    const snapshot = { schemaVersion: 1 }
    const created = await createSecurityExecution(db, {
      id: 'sx_dbguard000000a',
      engagementId: engagement.id,
      capabilityId: 'diagnostic.runtime-check',
      capabilityVersion: 1,
      environment: 'staging',
      configVersion: engagement.configVersion,
      correlationId: 'sx_dbguard000000a',
      requestedBy: user,
      decisionEventId: 1,
      snapshot: snapshot as never,
      snapshotHash: snapshotHash(snapshot),
    })
    const update = (sql: string) => pool.query(`update security_executions set ${sql} where id = $1`, [created.id])
    await expect(update(`snapshot = '{"schemaVersion":1,"limits":{"executionTimeoutSeconds":86400}}'`)).rejects.toThrow(/immutable/)
    await expect(update(`snapshot_hash = 'forged'`)).rejects.toThrow(/immutable/)
    await expect(update(`environment = 'isolated-lab'`)).rejects.toThrow(/immutable/)
    await expect(update(`config_version = config_version + 1`)).rejects.toThrow(/immutable/)
    await update(`status = 'failed', finished_at = now()`)
    await expect(update(`status = 'succeeded'`)).rejects.toThrow(/final/)
    await expect(update(`failure = null`)).rejects.toThrow(/final/)
  })

  it('a configuration change after acceptance keeps a queued execution from starting', async () => {
    await boss.offWork(QUEUES.securityExecution)
    const engagement = await readyEngagement()
    const id = await submit(engagement, 0)
    await service.updateScope(engagement.id, { manifest: { ...engagement.scope, hosts: [...engagement.scope.hosts, { host: 'localhost', ports: [fixture.port] }] } })
    await worker.start()
    const done = await settled(id, 'failed', 'succeeded')
    expect(done).toMatchObject({ status: 'failed', failure: { kind: 'preflight-failed', rule: 'execution.config-changed' } })
    expect(await eventTypes(id)).not.toContain('execution.started')
    expect((await pool.query('select count(*)::int as n from owned_processes where security_execution_id = $1', [id])).rows[0].n).toBe(0)
  }, 60_000)

  it('cancelling A stops exactly A\'s owned process; execution B and an unrelated process survive', async () => {
    const engagement = await readyEngagement()
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    children.push(unrelated)
    const a = await submit(engagement, 120)
    const b = await submit(engagement, 120)
    const [pidA] = await ownedPids(a)
    const [pidB] = await ownedPids(b)
    await settled(a, 'running')
    await settled(b, 'running')

    expect(await executions.cancel(a, user)).toMatchObject({ status: 'cancelling', cancellable: false })
    expect(await executions.cancel(a, user)).toMatchObject({ status: 'cancelling' })
    const cancelled = await settled(a, 'cancelled', 'failed')
    expect(cancelled).toMatchObject({ status: 'cancelled', failure: { kind: 'cancelled' }, cancelRequestedBy: user })
    await until(() => !alive(pidA!), 20_000, 'A process gone')
    await until(async () => (await pool.query(`select status from owned_processes where pid = $1 and security_execution_id = $2`, [pidA, a])).rows[0]?.status === 'killed', 15_000, 'A record killed')
    expect(alive(pidB!)).toBe(true)
    expect(alive(unrelated.pid!)).toBe(true)
    expect((await row(b)).status).toBe('running')
    const types = await eventTypes(a)
    expect(types.slice(-4)).toEqual(['execution.cancel-requested', 'execution.cleanup-started', 'execution.cleanup-completed', 'execution.cancelled'])
    expect((await executions.events(a)).find((e) => e.type === 'execution.cancel-requested')!.actor).toMatchObject({ kind: 'user' })
    expect(await executions.cancel(a, user)).toMatchObject({ status: 'cancelled' })

    await executions.cancel(b, user)
    await settled(b, 'cancelled')
    await until(() => !alive(pidB!), 20_000, 'B process gone')
    expect(alive(unrelated.pid!)).toBe(true)
  }, 120_000)

  it('enforces the timeout from the engagement policy, stops the owned process and persists it', async () => {
    const engagement = await readyEngagement({ executionTimeoutSeconds: 2 })
    const started = Date.now()
    const id = await submit(engagement, 120)
    const [pid] = await ownedPids(id)
    const done = await settled(id, 'timed-out', 'failed', 'succeeded')
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(done).toMatchObject({ status: 'timed-out', failure: { kind: 'timeout', rule: 'runtime.timeout' }, snapshot: { limits: { executionTimeoutSeconds: 2 }, runtime: { timeoutSeconds: 2 } } })
    await until(() => !alive(pid!), 20_000, 'process gone')
    expect((await eventTypes(id)).slice(-3)).toEqual(['execution.cleanup-started', 'execution.cleanup-completed', 'execution.timed-out'])
  }, 90_000)

  it('pausing the engagement cancels its running execution', async () => {
    const engagement = await readyEngagement()
    await service.applyLifecycle(engagement.id, { action: 'activate' })
    // The decision is made against the active configuration.
    const id = await submit((await service.getEngagement(engagement.id)), 120)
    await settled(id, 'running')
    await service.applyLifecycle(engagement.id, { action: 'pause' })
    const done = await settled(id, 'cancelled', 'failed')
    expect(done).toMatchObject({ status: 'cancelled', cancelRequestedBy: { kind: 'system' } })
  }, 90_000)
})

describe('restart reconciliation', () => {
  async function childWorker(): Promise<ChildProcess> {
    // A single node process (no tsx wrapper), so killing its PID kills exactly the worker.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('apps', 'worker', 'test', 'security-worker.child.ts')], {
      cwd: REPO_ROOT,
      env: { ...process.env, LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child worker did not start: ${stderr}`)), 60_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', (code) => reject(new Error(`child worker exited (${code}): ${stderr}`)))
    })
    return child
  }

  it('reconciles executions of a crashed worker: orphans terminated exactly, nothing re-run, idempotent', async () => {
    // Only the child worker consumes the queue while it lives.
    await boss.offWork(QUEUES.securityExecution)
    const engagement = await readyEngagement()
    const child = await childWorker()
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    children.push(unrelated)

    const running = await submit(engagement, 300)
    const [holder] = await ownedPids(running)
    const held = await settled(running, 'running')
    expect(held.runner).toMatchObject({ pid: child.pid })
    const { rows: holderRows } = await pool.query<{ owner_id: string }>('select owner_id from owned_processes where pid = $1', [holder])
    const crashedOwnerId = holderRows[0]!.owner_id

    // Crash: kill exactly the worker process (its PID only, no tree kill).
    const exited = new Promise((resolve) => child.once('exit', resolve))
    process.kill(child.pid!)
    await exited
    await sleep(500)
    expect((await row(running)).status).toBe('running')
    // On Windows the OS ends a Node process's children with it (libuv's kill-on-close job object), so the
    // real holder is usually gone already; on Linux/macOS it survives as an orphan. Both are reconciled.
    // A surviving orphan (as on Linux, or a detached process or container) is represented by a live
    // process recorded under the crashed worker's identity, exactly as its own registry would have it.
    const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true })
    children.push(survivor)
    const survivorIdentity = await processIdentity(survivor.pid!)
    await pool.query(
      `insert into owned_processes (id, pid, process_started_at, image, tool, owner_id, parent_pid, command, security_execution_id, status)
       values ('proc_survivor01', $1, $2, $3, 'diagnostic.runtime-check', $4, $5, 'held by the crashed worker', $6, 'running')`,
      [survivor.pid, survivorIdentity!.startedAt, survivorIdentity!.image, crashedOwnerId, child.pid, running],
    )
    expect(alive(survivor.pid!)).toBe(true)

    // Completed work awaiting finalization, left by the same crashed worker.
    const finishing = await submit(engagement, 0)
    const result = { outcome: 'succeeded', summary: 'finished before the crash', output: { ok: true }, failure: null, evidenceRefs: [], artifactBytes: 0, processesStarted: 0, endedAt: new Date().toISOString() }
    await pool.query(`update security_executions set status = 'finalizing', runner = $2, started_at = now(), result = $3 where id = $1`, [finishing, JSON.stringify(held.runner), JSON.stringify(result)])
    // A queued execution whose job was lost.
    const lost = await submit(engagement, 0)
    await pool.query('delete from pgboss.job where singleton_key = $1', [lost])

    // Restart: the worker's start-up reconciliation.
    const report = await worker.recover()
    expect(report.reconciled).toEqual(expect.arrayContaining([{ id: running, status: 'interrupted' }, { id: finishing, status: 'succeeded' }]))
    expect(report.requeued).toEqual([lost])
    await until(() => !alive(survivor.pid!), 20_000, 'surviving orphan terminated')
    await until(() => !alive(holder!), 20_000, 'holder gone')
    expect(alive(unrelated.pid!)).toBe(true)

    const interrupted = await row(running)
    expect(interrupted).toMatchObject({ status: 'interrupted', failure: { kind: 'worker-interrupted' }, exit: { outcome: 'interrupted' } })
    const recovered = (await executions.events(running)).find((e) => e.type === 'execution.recovered')!
    const found = (recovered.data as { processes: { orphanedTerminated: number; alreadyGone: number; heldByLiveInstance: number } }).processes
    expect(recovered.data).toMatchObject({ action: 'interrupted', previousStatus: 'running' })
    expect(found.orphanedTerminated).toBeGreaterThanOrEqual(1)
    expect(found.orphanedTerminated + found.alreadyGone).toBe(2)
    expect(found.heldByLiveInstance).toBe(0)
    expect(interrupted.exit!.processes.reaped).toBe(found.orphanedTerminated)
    const statuses = Object.fromEntries(
      (await pool.query<{ id: string; pid: number; status: string }>('select id, pid, status from owned_processes where security_execution_id = $1', [running])).rows.map((r) => [r.pid === holder ? 'holder' : r.id, r.status]),
    )
    expect(statuses.proc_survivor01).toBe('reaped')
    expect(['reaped', 'gone']).toContain(statuses.holder)
    expect(await eventTypes(running)).not.toContain('execution.completed')
    expect((await row(finishing)).exit).toMatchObject({ summary: 'finished before the crash' })

    // Idempotent: a second reconciliation finds nothing to do.
    const again = await worker.recover()
    expect(again.reconciled).toEqual([])
    expect((await executions.events(running)).filter((e) => e.type === 'execution.recovered')).toHaveLength(1)

    // The restarted worker consumes again: the re-queued execution runs to completion.
    await worker.start()
    expect((await settled(lost, 'succeeded', 'failed')).status).toBe('succeeded')
  }, 180_000)
})
