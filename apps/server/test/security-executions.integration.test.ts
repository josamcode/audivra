import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getLogger } from '@audivra/config'
import type { SecurityEngagementDetail, SecurityEventItem, SecurityEvidenceItem, SecurityExecutionDetail, SecurityExecutionItem } from '@audivra/contracts'
import { createBoss, ensureQueues, type PgBoss } from '@audivra/database'
import {
  CapabilityBroker,
  createBossExecutionQueue,
  createDbExecutionStore,
  createDbSecurityStore,
  createRuntimeRegistry,
  ExecutionRuntime,
  SecurityService,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startScopeFixture, testDb, type ScopeFixture } from '../../../test/helpers.ts'

/*
 * The execution API on the real database: inspection and cancellation only. Executions are created
 * through the capability broker (platform code) and run by an in-process runtime here; the API offers
 * no way to create or run one.
 */

const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const resolver: Resolver = async (host) => {
  if (host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver })
const registry = createRuntimeRegistry()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: ScopeFixture
let broker: CapabilityBroker
let runtime: ExecutionRuntime

beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: getLogger(), security: service })
  fixture = await startScopeFixture('primary')
  const store = createDbSecurityStore(db)
  const executions = createDbExecutionStore(db)
  broker = new CapabilityBroker({ registry, store, resolver, executions: { store: executions, queue: createBossExecutionQueue(boss) } })
  runtime = new ExecutionRuntime({ registry, store, executions, resolver, pollIntervalMs: 200, cancelGraceMs: 1500 })
})

afterAll(async () => {
  await runtime.shutdown()
  await app.close()
  await boss.stop({ graceful: false })
  await fixture.close()
  await handle.close()
})

beforeEach(async () => {
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
  await boss.deleteAllJobs()
})

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: T; text: string; type: string }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) })
  let body: unknown
  try {
    body = response.json()
  } catch {
    body = null
  }
  return { status: response.statusCode, body: body as T, text: response.body, type: String(response.headers['content-type'] ?? '') }
}

async function readyEngagement(): Promise<SecurityEngagementDetail> {
  const created = await service.createEngagement({ name: 'API fixture', targetUrl: fixture.url, environment: 'staging' })
  return (await service.requestAuthorization(created.id, { method: 'local-development' })).engagement
}

async function submit(engagementId: string, input: Record<string, unknown> = {}): Promise<string> {
  const outcome = await broker.submit({ engagementId, capabilityId: 'diagnostic.runtime-check', input: { target: fixture.url, holdSeconds: 0, ...input }, actor: user })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  return outcome.executionId
}

describe('execution API', () => {
  it('lists, reads and explains executions, and serves only their registered artifacts', async () => {
    const engagement = await readyEngagement()
    const id = await submit(engagement.id, { note: 'api check' })
    expect(await runtime.run(id)).toBe('succeeded')

    const list = await api<SecurityExecutionItem[]>('GET', `/api/security/engagements/${engagement.id}/executions`)
    expect(list.status).toBe(200)
    expect(list.body).toEqual([
      expect.objectContaining({ id, status: 'succeeded', capabilityId: 'diagnostic.runtime-check', capabilityName: 'Runtime check', environment: 'staging', failure: null, durationMs: expect.any(Number) }),
    ])

    const detail = await api<SecurityExecutionDetail>('GET', `/api/security/executions/${id}`)
    expect(detail.body).toMatchObject({
      id,
      engagementId: engagement.id,
      cancellable: false,
      workspacePath: `executions/${id}`,
      trusted: { scopeVersion: 1, scopeHash: engagement.scopeHash, policyProfile: { key: 'standard', version: 1 }, allowedTargets: [`${fixture.url}/`], runtime: { maxProcesses: 4 } },
      exit: { outcome: 'succeeded', processes: { started: 1 }, artifacts: { registered: 1 } },
      result: { summary: expect.stringContaining('Runtime check passed') },
      runner: { backend: 'in-process' },
    })
    expect(detail.body.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
    // The capability input (target data) stays out of the API view.
    expect(JSON.stringify(detail.body)).not.toContain('api check')

    const events = await api<SecurityEventItem[]>('GET', `/api/security/executions/${id}/events`)
    expect(events.body.map((e) => e.type)).toEqual([
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
    const evidence = await api<SecurityEvidenceItem[]>('GET', `/api/security/executions/${id}/evidence`)
    expect(evidence.body).toEqual([expect.objectContaining({ ref: 'EV-1', artifactPath: `executions/${id}/artifacts/runtime-check.txt`, provenance: expect.objectContaining({ executionId: id }) })])

    const artifact = await api('GET', `/api/security/executions/${id}/artifacts/artifacts/runtime-check.txt`)
    expect(artifact.status).toBe(200)
    expect(artifact.type).toContain('text/plain')
    expect(artifact.text).toContain(`execution:   ${id}`)
    for (const path of ['inputs/input.json', '..%2F..%2F..%2Fpackage.json', '..\\..\\x', `executions/${id}/../../x`]) {
      expect((await api('GET', `/api/security/executions/${id}/artifacts/${path}`)).status, path).toBe(404)
    }
    expect((await api('GET', '/api/security/executions/sx_doesnotexist00')).status).toBe(404)
    expect((await api('GET', '/api/security/executions/..%2Fsecret')).status).toBe(404)
    expect((await api('GET', '/api/security/engagements/nosuchengagement/executions')).status).toBe(404)
  }, 60_000)

  it('offers no way to create, run or change an execution', async () => {
    const engagement = await readyEngagement()
    const id = await submit(engagement.id)
    const attempts: [method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string][] = [
      ['POST', `/api/security/engagements/${engagement.id}/executions`],
      ['POST', '/api/security/executions'],
      ['POST', `/api/security/executions/${id}/run`],
      ['POST', `/api/security/executions/${id}/retry`],
      ['POST', `/api/security/executions/${id}/start`],
      ['PUT', `/api/security/executions/${id}`],
      ['PATCH', `/api/security/executions/${id}`],
      ['DELETE', `/api/security/executions/${id}`],
    ]
    for (const [method, url] of attempts) {
      const response = await api(method, url, { capabilityId: 'diagnostic.runtime-check', command: 'whoami', image: 'alpine' })
      expect(response.status, `${method} ${url}`).toBe(404)
    }
    expect((await pool.query('select count(*)::int as n from security_executions')).rows[0].n).toBe(1)
  })

  it('cancels idempotently through the API and refuses to cancel finished work', async () => {
    const engagement = await readyEngagement()
    const queued = await submit(engagement.id)
    const cancelledQueued = await api<SecurityExecutionDetail>('POST', `/api/security/executions/${queued}/cancel`)
    expect(cancelledQueued).toMatchObject({ status: 202, body: { status: 'cancelled', failure: { rule: 'execution.cancelled-before-start' } } })
    expect(await runtime.run(queued)).toBe('cancelled')

    const id = await submit(engagement.id, { holdSeconds: 60 })
    const running = runtime.run(id)
    for (let i = 0; i < 200 && (await api<SecurityExecutionDetail>('GET', `/api/security/executions/${id}`)).body.status !== 'running'; i++) await sleep(100)
    const first = await api<SecurityExecutionDetail>('POST', `/api/security/executions/${id}/cancel`)
    expect(first).toMatchObject({ status: 202, body: { status: 'cancelling', cancellable: false, cancelRequestedAt: expect.any(String) } })
    expect((await api<SecurityExecutionDetail>('POST', `/api/security/executions/${id}/cancel`)).body.status).toBe('cancelling')
    expect(await running).toBe('cancelled')
    expect((await api<SecurityExecutionDetail>('POST', `/api/security/executions/${id}/cancel`)).body).toMatchObject({ status: 'cancelled', failure: { kind: 'cancelled' } })
    const events = (await api<SecurityEventItem[]>('GET', `/api/security/executions/${id}/events`)).body
    expect(events.filter((e) => e.type === 'execution.cancel-requested')).toHaveLength(1)

    const done = await submit(engagement.id)
    await runtime.run(done)
    const refused = await api<{ error: string }>('POST', `/api/security/executions/${done}/cancel`)
    expect(refused).toMatchObject({ status: 409, body: { error: 'The execution is already succeeded' } })
  }, 90_000)

  it('redacts secrets from execution responses and served artifacts', async () => {
    const engagement = await readyEngagement()
    const secret = 'abcdefghijklmnop1234567890'
    const id = await submit(engagement.id, { note: `Authorization: Bearer ${secret}` })
    expect(await runtime.run(id)).toBe('succeeded')
    for (const url of [`/api/security/executions/${id}`, `/api/security/executions/${id}/events`, `/api/security/executions/${id}/evidence`, `/api/security/executions/${id}/artifacts/artifacts/runtime-check.txt`]) {
      const response = await api('GET', url)
      expect(response.status, url).toBe(200)
      expect(response.text, url).not.toContain(secret)
    }
    const raw = JSON.stringify((await pool.query('select message, data from security_events where execution_id = $1', [id])).rows)
    expect(raw).not.toContain(secret)
  }, 60_000)
})
