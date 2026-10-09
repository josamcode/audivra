import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getLogger } from '@audivra/config'
import type { ExecutionStatus, SecurityEngagementDetail, SecurityObservation, SensorResult } from '@audivra/contracts'
import { createBoss, ensureQueues, processStore, QUEUES, type PgBoss, type SecurityExecutionRow } from '@audivra/database'
import {
  createDbExecutionStore,
  createDurableBroker,
  ExecutionService,
  findApprovedRuntime,
  runtimeImageRef,
  SecurityService,
  type CapabilityBroker,
  type Resolver,
} from '@audivra/security'
import { setProcessStore } from '@audivra/tool-runtime'
import { createSecurityExecutionWorker, type SecurityExecutionWorker } from '../src/security-executions.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * Security sensors on the real stack: PostgreSQL, pg-boss, the worker and Docker. Each sensor is an
 * approved external tool (httpx, katana, semgrep) run as a reviewed capability through the full control
 * plane: Capability Broker → durable execution → isolated runtime → (for networked sensors) the scope-
 * enforcing gateway. The tests prove the tool output becomes normalized, evidence-backed observations
 * with provenance; that a discovered out-of-scope destination is recorded but never contacted; and that
 * a sensor whose image is absent is simply skipped. Each block is skipped when its image is unavailable.
 */

const run = promisify(execFile)
async function imageReady(runtimeId: string): Promise<boolean> {
  const rt = findApprovedRuntime(runtimeId)
  if (!rt) return false
  try {
    await run('docker', ['image', 'inspect', runtimeImageRef(rt), '--format', '{{.Id}}'], { windowsHide: true, timeout: 60_000 })
    return true
  } catch {
    return false
  }
}
const httpxReady = await imageReady('httpx')
const katanaReady = await imageReady('katana')
const semgrepReady = await imageReady('semgrep')

const handle = testDb()
const { db, pool } = handle
const log = getLogger()
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const resolver: Resolver = async (host) => {
  if (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver })
const executions = new ExecutionService({ db })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let boss: PgBoss
let worker: SecurityExecutionWorker
let broker: CapabilityBroker

/** A host fixture bound to 127.0.0.1 that counts every request. */
interface Fixture {
  port: number
  hits: () => number
  close: () => void
}
const fixtures: Fixture[] = []
/** Fixture A: a small linked site; `extPort` (when given) is linked and redirected to, but out of scope. */
function startSite(extPort?: () => number): Promise<Fixture> {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    const ext = extPort ? `http://127.0.0.1:${extPort()}/ext` : ''
    if (req.url === '/redirect-out' && extPort) {
      res.writeHead(302, { location: `http://127.0.0.1:${extPort()}/from-redirect` })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/html', server: 'audivra-fixture' })
    if (req.url === '/' || req.url === '/index.html') {
      return res.end(`<!doctype html><html><head><title>Home</title></head><body>
        <a href="/about">About</a><a href="/contact">Contact</a>${ext ? `<a href="${ext}">ext</a>` : ''}
        <form action="/login" method="post"><input name="user"><input name="pass"></form></body></html>`)
    }
    res.end(`<!doctype html><html><head><title>${req.url}</title></head><body><a href="/">home</a></body></html>`)
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
async function until<T>(check: () => T | Promise<T>, ms = 120_000, what = 'condition'): Promise<Truthy<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as Truthy<T>
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`)
    await sleep(200)
  }
}
const row = async (id: string): Promise<SecurityExecutionRow> => (await createDbExecutionStore(db).get(id))!
const settled = (id: string) => until(async () => (['succeeded', 'failed', 'timed-out', 'cancelled', 'interrupted'] as ExecutionStatus[]).includes((await row(id)).status) && (await row(id)), 150_000, `${id} final`)
const sensorResult = (r: SecurityExecutionRow) => r.result!.output as SensorResult

async function readyEngagement(name: string, targetPort: number): Promise<SecurityEngagementDetail> {
  const created = await service.createEngagement({ name, targetUrl: `http://127.0.0.1:${targetPort}/`, environment: 'staging' })
  return (await service.requestAuthorization(created.id, { method: 'local-development' })).engagement
}
async function submit(engagementId: string, capabilityId: string, input: Record<string, unknown>): Promise<string> {
  const outcome = await broker.submit({ engagementId, capabilityId, input, actor: user })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  return outcome.executionId
}

beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  setProcessStore({
    insert: (r) => processStore.insert(db, r),
    finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
    listStale: (ownerId) => processStore.listStale(db, ownerId),
  })
  worker = createSecurityExecutionWorker({ db, boss, log, runtime: { pollIntervalMs: 250, cancelGraceMs: 4000, maxActive: 2 } })
  broker = createDurableBroker({ db, boss, resolver })
})

afterAll(async () => {
  await worker.shutdown()
  await boss.stop({ graceful: false })
  setProcessStore(null)
  for (const f of fixtures) f.close()
  const left = await run('docker', ['ps', '-aq', '--filter', 'label=audivra.owner=security-execution'], { windowsHide: true }).then((r) => r.stdout.trim()).catch(() => '')
  if (left) await run('docker', ['rm', '-f', ...left.split(/\s+/)], { windowsHide: true }).catch(() => undefined)
  const nets = await run('docker', ['network', 'ls', '-q', '--filter', 'label=audivra.owner=security-execution'], { windowsHide: true }).then((r) => r.stdout.trim()).catch(() => '')
  if (nets) await run('docker', ['network', 'rm', ...nets.split(/\s+/)], { windowsHide: true }).catch(() => undefined)
  await handle.close()
})

beforeEach(async () => {
  await boss.offWork(QUEUES.securityExecution).catch(() => undefined)
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
  await boss.deleteAllJobs()
  await worker.start()
})

const byType = (obs: SecurityObservation[], type: string) => obs.filter((o) => o.type === type)

describe.skipIf(!httpxReady)('httpx sensor (networked, through the gateway)', () => {
  it('records response/technology observations with provenance and keeps raw output as evidence', async () => {
    const site = await startSite()
    const engagement = await readyEngagement('httpx inspect', site.port)
    const id = await submit(engagement.id, 'discovery.http-inspect', { url: `http://127.0.0.1:${site.port}/` })
    const done = await settled(id)
    expect(done.status, JSON.stringify(done.failure)).toBe('succeeded')
    expect(sensorResult(done)).toMatchObject({ state: 'success', tool: 'httpx' })
    expect(sensorResult(done).toolVersion).toContain('@sha256:')

    const obs = await executions.observations(id)
    const response = byType(obs, 'http-response')[0]!
    expect(response).toBeTruthy()
    expect(response.contributions[0]).toMatchObject({ executionId: id, tool: 'httpx', capabilityId: 'discovery.http-inspect' })
    expect(response.contributions[0]!.toolVersion).toContain('@sha256:')
    expect(response.evidenceRefs.length).toBeGreaterThan(0)

    const evidence = await executions.evidence(id)
    expect(evidence.some((e) => e.type === 'tool-result' && /outputs\/httpx\.jsonl$/.test(e.artifactPath ?? ''))).toBe(true)
  }, 180_000)

  it('records an out-of-scope redirect destination without following it (zero traffic to the out-of-scope host)', async () => {
    const ext = await startSite()
    const site = await startSite(() => ext.port)
    const engagement = await readyEngagement('httpx redirect', site.port)
    const before = ext.hits()
    const id = await submit(engagement.id, 'discovery.http-inspect', { url: `http://127.0.0.1:${site.port}/redirect-out` })
    const done = await settled(id)
    expect(done.status, JSON.stringify(done.failure)).toBe('succeeded')

    const redirect = byType(await executions.observations(id), 'redirect')[0]!
    expect(redirect).toBeTruthy()
    expect(redirect.scopeClass).not.toBe('in-scope')
    expect(redirect.value).toMatchObject({ followed: false })
    // The authoritative proof: the out-of-scope destination received no traffic at all.
    expect(ext.hits() - before).toBe(0)
  }, 180_000)
})

describe.skipIf(!katanaReady)('katana sensor (crawl, through the gateway)', () => {
  it('discovers in-scope endpoints and never contacts the linked out-of-scope destination', async () => {
    const ext = await startSite()
    const site = await startSite(() => ext.port)
    const engagement = await readyEngagement('katana crawl', site.port)
    const before = ext.hits()
    const id = await submit(engagement.id, 'discovery.crawl', { url: `http://127.0.0.1:${site.port}/`, maxDepth: 2, durationSeconds: 25, concurrency: 2 })
    const done = await settled(id)
    expect(done.status, JSON.stringify(done.failure)).toBe('succeeded')
    expect(sensorResult(done).tool).toBe('katana')

    const obs = await executions.observations(id)
    const endpoints = byType(obs, 'endpoint')
    const inScopePaths = endpoints.filter((o) => o.scopeClass === 'in-scope').map((o) => o.asset)
    // The crawl followed in-scope links from the seed.
    expect(inScopePaths.some((u) => u.endsWith('/about'))).toBe(true)
    expect(endpoints.every((o) => o.contributions[0]!.tool === 'katana')).toBe(true)
    // The authoritative scope proof: the out-of-scope fixture received zero requests.
    expect(ext.hits() - before).toBe(0)
  }, 240_000)
})

describe.skipIf(!semgrepReady)('semgrep sensor (static analysis, no network)', () => {
  it('records source-finding observations from a staged source tree and never opens a gateway', async () => {
    const site = await startSite()
    const engagement = await readyEngagement('semgrep analysis', site.port)
    const id = await submit(engagement.id, 'source.static-analysis', {
      files: [
        { path: 'app.js', content: 'function handler(req){ const r = eval(req.query.code); return r }\n' },
        { path: 'config.js', content: 'const password = "supersecret123";\nmodule.exports = { password };\n' },
      ],
    })
    const done = await settled(id)
    expect(done.status, JSON.stringify(done.failure)).toBe('succeeded')
    expect(sensorResult(done)).toMatchObject({ state: 'success', tool: 'semgrep' })

    const findings = byType(await executions.observations(id), 'source-finding')
    expect(findings.length).toBeGreaterThanOrEqual(2)
    expect(findings.some((o) => o.asset === 'app.js')).toBe(true)
    expect(findings.every((o) => o.contributions[0]!.tool === 'semgrep')).toBe(true)
    // Static analysis is a no-network capability: its isolation declares no gateway.
    expect(done.snapshot.isolation).toMatchObject({ mode: 'isolated-container', network: 'none' })
  }, 180_000)
})
