import { spawn, execFile, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getLogger, REPO_ROOT } from '@audivra/config'
import type { ExecutionStatus, SecurityEngagementDetail } from '@audivra/contracts'
import { createBoss, ensureQueues, processStore, QUEUES, type PgBoss, type SecurityExecutionRow } from '@audivra/database'
import {
  APPROVED_RUNTIMES,
  containerNameFor,
  createDbExecutionStore,
  createDurableBroker,
  egressNetworkName,
  gatewayNameFor,
  internalNetworkName,
  ExecutionService,
  runtimeImageRef,
  SecurityService,
  type CapabilityBroker,
  type Resolver,
} from '@audivra/security'
import { setProcessStore } from '@audivra/tool-runtime'
import { createSecurityExecutionWorker, type SecurityExecutionWorker } from '../src/security-executions.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * Controlled network egress on the real stack: PostgreSQL, pg-boss, the worker and Docker. A networked
 * isolated capability reaches local counting fixtures ONLY through its execution-private gateway, which
 * enforces the trusted scope. The tests prove allowed destinations are reached, out-of-scope ones
 * (host/port/redirect) receive zero traffic, executions are isolated from each other, and all
 * execution-owned networks and gateways are cleaned up — by exact name, never pruned. Skipped when
 * Docker or the approved runtime image is not available.
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
  if (host === '127.0.0.1') return ['127.0.0.1']
  if (host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver })
const executions = new ExecutionService({ db })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const children: ChildProcess[] = []

let boss: PgBoss
let worker: SecurityExecutionWorker
let broker: CapabilityBroker

/** A host fixture bound to 127.0.0.1 that counts every request; one path issues a redirect. */
interface Fixture {
  port: number
  hits: () => number
  close: () => void
}
const fixtures: Fixture[] = []
function startFixture(redirectTo?: () => number): Promise<Fixture> {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    if (redirectTo && req.url?.startsWith('/redirect-out')) {
      res.writeHead(302, { location: `http://127.0.0.1:${redirectTo()}/from-redirect` })
      return res.end()
    }
    res.writeHead(200)
    res.end('fixture')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('node:net').AddressInfo).port
      const fixture: Fixture = { port, hits: () => hits, close: () => server.close() }
      fixtures.push(fixture)
      resolve(fixture)
    })
  })
}

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>
async function until<T>(check: () => T | Promise<T>, ms = 90_000, what = 'condition'): Promise<Truthy<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as Truthy<T>
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`)
    await sleep(150)
  }
}
const row = async (id: string): Promise<SecurityExecutionRow> => (await createDbExecutionStore(db).get(id))!
const settled = (id: string, ...s: ExecutionStatus[]) => until(async () => s.includes((await row(id)).status) && (await row(id)), 120_000, `${id} final`)
const containerState = async (name: string) => {
  const r = await docker('inspect', '--type', 'container', '--format', '{{.State.Status}}', name)
  return r.ok ? r.stdout : 'absent'
}
const networkState = async (name: string) => ((await docker('network', 'inspect', '--format', '{{.Name}}', name)).ok ? 'present' : 'absent')
async function allAbsent(id: string): Promise<boolean> {
  const [c, g, i, e] = await Promise.all([containerState(containerNameFor(id)), containerState(gatewayNameFor(id)), networkState(internalNetworkName(id)), networkState(egressNetworkName(id))])
  return c === 'absent' && g === 'absent' && i === 'absent' && e === 'absent'
}
const eventTypes = async (id: string) => (await executions.events(id)).map((e) => e.type)

async function readyEngagement(name: string, targetPort: number): Promise<SecurityEngagementDetail> {
  const created = await service.createEngagement({ name, targetUrl: `http://127.0.0.1:${targetPort}/`, environment: 'staging' })
  return (await service.requestAuthorization(created.id, { method: 'local-development' })).engagement
}
async function submitEgress(engagement: SecurityEngagementDetail, targetUrl: string, probes: { label: string; url: string }[] = [], holdSeconds = 0): Promise<string> {
  const outcome = await broker.submit({
    engagementId: engagement.id,
    capabilityId: 'diagnostic.egress-check',
    input: { target: targetUrl, probes, holdSeconds },
    actor: user,
  })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  return outcome.executionId
}
type Reached = { label: string; url: string; status: number | null; denied: boolean }
const reachedOf = (r: SecurityExecutionRow) => (r.result!.output as { reached: Reached[] }).reached
const directOf = (r: SecurityExecutionRow) => (r.result!.output as { direct: Record<string, string> }).direct

describe.skipIf(!dockerReady)('controlled network egress', () => {
  let A: Fixture
  let B: Fixture
  let C: Fixture

  beforeAll(async () => {
    boss = createBoss(process.env.DATABASE_URL!)
    await boss.start()
    await ensureQueues(boss)
    setProcessStore({
      insert: (r) => processStore.insert(db, r),
      finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
      listStale: (ownerId) => processStore.listStale(db, ownerId),
    })
    worker = createSecurityExecutionWorker({ db, boss, log, runtime: { pollIntervalMs: 250, cancelGraceMs: 4000, maxActive: 4 } })
    broker = createDurableBroker({ db, boss, resolver })
    B = await startFixture()
    C = await startFixture()
    A = await startFixture(() => B.port)
  })

  afterAll(async () => {
    await worker.shutdown()
    await boss.stop({ graceful: false })
    setProcessStore(null)
    for (const f of fixtures) f.close()
    // Exact cleanup of anything these tests may have left (never a global prune).
    const left = await docker('ps', '-aq', '--filter', 'label=audivra.owner=security-execution')
    if (left.stdout) await docker('rm', '-f', ...left.stdout.split(/\s+/))
    const nets = await docker('network', 'ls', '-q', '--filter', 'label=audivra.owner=security-execution')
    if (nets.stdout) await docker('network', 'rm', ...nets.stdout.split(/\s+/))
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

  it('reaches the in-scope destination through the gateway; out-of-scope host, port and redirect receive zero traffic', async () => {
    const engagement = await readyEngagement('egress allowed', A.port)
    const before = { A: A.hits(), B: B.hits(), C: C.hits() }
    const id = await submitEgress(engagement, `http://127.0.0.1:${A.port}/ok`, [
      { label: 'out-of-scope-port', url: `http://127.0.0.1:${B.port}/secret` },
      { label: 'alternate-port', url: `http://127.0.0.1:${C.port}/x` },
      { label: 'redirect-out', url: `http://127.0.0.1:${A.port}/redirect-out` },
    ])
    const done = await settled(id, 'succeeded', 'failed', 'timed-out', 'cancelled', 'interrupted')
    expect(done).toMatchObject({ status: 'succeeded', failure: null })
    expect(done.snapshot.isolation).toMatchObject({ mode: 'isolated-container', network: 'scoped-egress' })

    // What the executor saw through the gateway.
    const reached = Object.fromEntries(reachedOf(done).map((r) => [r.label, r]))
    expect(reached['target']).toMatchObject({ status: 200, denied: false })
    expect(reached['out-of-scope-port']).toMatchObject({ denied: true })
    expect(reached['alternate-port']).toMatchObject({ denied: true })
    expect(reached['redirect-out']).toMatchObject({ denied: true }) // the redirect was followed to B and denied there

    // The authoritative proof: out-of-scope fixtures received zero requests; the in-scope one did.
    expect(A.hits() - before.A).toBeGreaterThanOrEqual(2) // /ok and /redirect-out
    expect(B.hits() - before.B).toBe(0)
    expect(C.hits() - before.C).toBe(0)

    // The executor had no route around the gateway.
    const direct = directOf(done)
    expect(Object.values(direct)).not.toContain('CONNECTED')

    // Policy-level observability, and the private resources are gone.
    expect(done.exit).toMatchObject({ runtime: { network: { profile: 'scoped-egress', gateway: { ready: true, removed: true }, decisions: { allowed: expect.any(Number), denied: expect.any(Number) } } } })
    expect(done.exit!.runtime!.network!.decisions).toMatchObject({ denied: expect.any(Number) })
    expect(done.exit!.runtime!.network!.decisions!.denied).toBeGreaterThanOrEqual(3)
    expect(done.exit!.runtime!.network!.networks.every((n) => n.removed)).toBe(true)
    const types = await eventTypes(id)
    expect(types).toEqual(expect.arrayContaining(['execution.network-preparing', 'execution.gateway-started', 'execution.network-ready', 'execution.network-summary']))
    expect(await allAbsent(id)).toBe(true)

    const [evidence] = await executions.evidence(id)
    expect(evidence).toMatchObject({ type: 'tool-result', artifactPath: `executions/${id}/artifacts/egress-check.txt` })
  }, 150_000)

  it('runs two networked executions with different scopes in isolation; cancelling one leaves the other', async () => {
    const eng1 = await readyEngagement('egress scope A', A.port)
    const eng2 = await readyEngagement('egress scope B', B.port)
    const before = { A: A.hits(), B: B.hits() }
    // Each may reach only its own fixture; each also attempts the other's (denied by its own gateway).
    const id1 = await submitEgress(eng1, `http://127.0.0.1:${A.port}/ok`, [{ label: 'other', url: `http://127.0.0.1:${B.port}/x` }], 8)
    const id2 = await submitEgress(eng2, `http://127.0.0.1:${B.port}/ok`, [{ label: 'other', url: `http://127.0.0.1:${A.port}/x` }], 8)
    await until(async () => (await row(id1)).status === 'running' && (await row(id2)).status === 'running', 60_000, 'both running')

    // Each execution has its own gateway and networks (distinct names), never shared.
    expect(internalNetworkName(id1)).not.toBe(internalNetworkName(id2))
    expect(await containerState(gatewayNameFor(id1))).toBe('running')
    expect(await containerState(gatewayNameFor(id2))).toBe('running')

    // Cancel execution 1 while it holds; execution 2 keeps running.
    await executions.cancel(id1, user)
    const done1 = await settled(id1, 'cancelled', 'failed')
    expect(done1.status).toBe('cancelled')
    expect(await allAbsent(id1)).toBe(true)
    expect(['running', 'finalizing', 'succeeded']).toContain((await row(id2)).status)

    const done2 = await settled(id2, 'succeeded', 'failed')
    expect(done2.status).toBe('succeeded')
    const reached2 = Object.fromEntries(reachedOf(done2).map((r) => [r.label, r]))
    expect(reached2['target']).toMatchObject({ status: 200, denied: false })
    expect(reached2['other']).toMatchObject({ denied: true }) // exec2 cannot reach A (out of its scope)

    // B received traffic only from exec2 (its own scope); A received none from exec2.
    expect(B.hits() - before.B).toBeGreaterThanOrEqual(1)
    expect(await allAbsent(id2)).toBe(true)
  }, 180_000)

  it('stops the gateway and executor at the policy timeout and removes all private resources', async () => {
    const engagement = await readyEngagement('egress timeout', A.port)
    await service.updateScope(engagement.id, { manifest: { ...engagement.scope, limits: { executionTimeoutSeconds: 4 } } })
    const ready = await service.getEngagement(engagement.id)
    const started = Date.now()
    const id = await submitEgress(ready, `http://127.0.0.1:${A.port}/ok`, [], 120)
    await until(async () => (await containerState(gatewayNameFor(id))) === 'running', 60_000, 'gateway running')
    const done = await settled(id, 'timed-out', 'failed', 'succeeded')
    expect(Date.now() - started).toBeLessThan(60_000)
    expect(done).toMatchObject({ status: 'timed-out', failure: { kind: 'timeout' } })
    expect(await allAbsent(id)).toBe(true)
  }, 120_000)

  it('after a worker crash, reconciles the exact gateway, executor and networks; unrelated resources untouched', async () => {
    await boss.offWork(QUEUES.securityExecution)
    const engagement = await readyEngagement('egress recovery', A.port)
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('apps', 'worker', 'test', 'security-worker.child.ts')], {
      cwd: REPO_ROOT,
      env: { ...process.env, LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child worker did not start')), 60_000)
      child.stdout?.on('data', (c: Buffer) => c.toString().includes('ready') && (clearTimeout(timer), resolve()))
    })
    // An unrelated Audivra-looking network and container that belong to no execution: never touched.
    const foreignExecId = 'sx_notarealexec01'
    const foreignNet = internalNetworkName(foreignExecId)
    await docker('network', 'create', '--label', 'audivra.owner=security-execution', '--label', `audivra.execution=${foreignExecId}`, '--label', 'audivra.engagement=foreign0001', foreignNet)

    const id = await submitEgress(engagement, `http://127.0.0.1:${A.port}/ok`, [], 300)
    await until(async () => (await containerState(gatewayNameFor(id))) === 'running', 60_000, 'gateway running')
    await settled(id, 'running')

    // Crash the worker; its containers and networks keep existing in Docker.
    const exited = new Promise((r) => child.once('exit', r))
    process.kill(child.pid!)
    await exited
    expect(await networkState(internalNetworkName(id))).toBe('present')

    const report = await worker.recover()
    expect(report.reconciled).toEqual(expect.arrayContaining([{ id, status: 'interrupted' }]))
    expect(await row(id).then((r) => r.failure)).toMatchObject({ kind: 'worker-interrupted' })
    await until(() => allAbsent(id), 60_000, 'execution resources removed')
    expect(await networkState(foreignNet)).toBe('present') // untouched

    const again = await worker.recover()
    expect(report.containersUntouched).toContain(foreignNet)
    expect(again.reconciled).toEqual([])
    expect(again.containersRemoved).toEqual([])
    await docker('network', 'rm', foreignNet)
    await worker.start()
  }, 240_000)
})
