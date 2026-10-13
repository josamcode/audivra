import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getLogger } from '@audivra/config'
import type { SecurityEngagementDetail, ScopeValidationResult } from '@audivra/contracts'
import {
  createAuditRecord,
  createBoss,
  createEvidence,
  ensureQueues,
  listEvidence,
  QUEUES,
  type PgBoss,
} from '@audivra/database'
import {
  CapabilityBroker,
  CapabilityRegistry,
  createDbSecurityStore,
  createDefaultRegistry,
  httpObserveCapability,
  SecurityService,
  type Resolver,
  type SecurityCapability,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startScopeFixture, testDb, type ScopeFixture } from '../../../test/helpers.ts'

/*
 * Security engagements end to end on the real database: API, persistence, the append-only audit trail
 * and the broker with the PostgreSQL store, against the local scope fixture only.
 */

const handle = testDb()
const { db, pool } = handle
let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: ScopeFixture
let otherService: ScopeFixture

// Loopback names resolve locally; nothing else may be looked up by this suite.
const resolver: Resolver = async (host) => {
  if (host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.1']
  if (host === 'public.test') return ['93.184.215.14']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver })
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }

beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  await boss.deleteAllJobs()
  app = await buildApp({ db, boss, hub: null, log: getLogger(), security: service })
  fixture = await startScopeFixture('primary')
  otherService = await startScopeFixture('other-service')
})

afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await fixture.close()
  await otherService.close()
  await handle.close()
})

beforeEach(async () => {
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
})

async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as T }
}

async function readyEngagement(environment: 'production' | 'staging' | 'isolated-lab' = 'staging'): Promise<SecurityEngagementDetail> {
  const created = await api<SecurityEngagementDetail>('POST', '/api/security/engagements', { name: 'Local fixture', targetUrl: fixture.url, environment })
  expect(created.status).toBe(201)
  const authorized = await api<{ engagement: SecurityEngagementDetail }>('POST', `/api/security/engagements/${created.body.id}/authorizations`, { method: 'local-development' })
  expect(authorized.status).toBe(201)
  expect(authorized.body.engagement.readiness.ready).toBe(true)
  return authorized.body.engagement
}

async function eventTypes(engagementId: string): Promise<string[]> {
  return (await api<{ type: string }[]>('GET', `/api/security/engagements/${engagementId}/events`)).body.map((e) => e.type)
}

describe('engagement setup through the API', () => {
  it('creates a draft engagement scoped to exactly the target, with an audit trail', async () => {
    const { status, body } = await api<SecurityEngagementDetail>('POST', '/api/security/engagements', { name: 'Fixture', targetUrl: `${fixture.url}/some/page` })
    expect(status).toBe(201)
    expect(body).toMatchObject({ status: 'draft', environment: null, policyProfile: { key: 'standard', version: 1 }, configVersion: 1 })
    expect(body.scope.hosts).toEqual([{ host: '127.0.0.1', includeSubdomains: false, ports: [fixture.port] }])
    expect(body.readiness).toMatchObject({ ready: false, state: 'policy-incomplete' })
    expect(body.policy.evaluatedEnvironment).toBe('production')
    expect(body.authorizationMethods.find((m) => m.method === 'local-development')?.available).toBe(true)
    expect(await eventTypes(body.id)).toEqual(['engagement.created'])
    expect((await api('POST', '/api/security/engagements', { name: 'x', targetUrl: 'javascript:alert(1)' })).status).toBe(400)
    expect((await api('POST', '/api/security/engagements', { name: 'x', targetUrl: fixture.url, authorized: true })).status).toBe(400)
  })

  it('moves from draft to authorization pending to ready as requirements are met', async () => {
    const created = (await api<SecurityEngagementDetail>('POST', '/api/security/engagements', { name: 'Fixture', targetUrl: fixture.url })).body
    const withEnv = (await api<SecurityEngagementDetail>('PATCH', `/api/security/engagements/${created.id}`, { environment: 'staging' })).body
    expect(withEnv).toMatchObject({ status: 'authorization-pending', configVersion: 2, readiness: { state: 'not-authorized' } })
    const { status, body } = await api<{ authorization: { status: string; effectiveStatus: string; expiresAt: string }; engagement: SecurityEngagementDetail }>(
      'POST',
      `/api/security/engagements/${created.id}/authorizations`,
      { method: 'local-development' },
    )
    expect(status).toBe(201)
    expect(body.authorization).toMatchObject({ status: 'verified', effectiveStatus: 'verified' })
    expect(body.engagement).toMatchObject({ status: 'ready', readiness: { ready: true, state: 'ready' } })
    expect(await eventTypes(created.id)).toEqual([
      'engagement.created',
      'environment.changed',
      'lifecycle.changed',
      'authorization.requested',
      'authorization.changed',
      'lifecycle.changed',
    ])
  })

  it('refuses unimplemented authorization methods instead of faking them, and records failed local checks', async () => {
    const created = (await api<SecurityEngagementDetail>('POST', '/api/security/engagements', { name: 'Site', targetUrl: 'https://public.test/', environment: 'production' })).body
    for (const method of ['dns-txt', 'well-known-file', 'repository', 'deployment', 'manual-approval']) {
      const response = await api<{ error: string }>('POST', `/api/security/engagements/${created.id}/authorizations`, { method })
      expect(response.status, method).toBe(422)
      expect(response.body.error).toMatch(/Not available in this version/)
    }
    const local = await api<{ authorization: { status: string; reason: string } }>('POST', `/api/security/engagements/${created.id}/authorizations`, { method: 'local-development' })
    expect(local.body.authorization).toMatchObject({ status: 'failed' })
    const detail = (await api<SecurityEngagementDetail>('GET', `/api/security/engagements/${created.id}`)).body
    expect(detail.readiness.state).toBe('not-authorized')
    expect(detail.authorizations.map((a) => a.method)).toEqual(['local-development'])
  })

  it('validates URLs against the scope by name and by resolved address', async () => {
    const engagement = await readyEngagement()
    const check = async (url: string, manifest?: unknown) =>
      (await api<ScopeValidationResult>('POST', `/api/security/engagements/${engagement.id}/scope/validate`, { url, ...(manifest ? { manifest } : {}) })).body
    expect((await check(`${fixture.url}/allowed`)).evaluation).toMatchObject({ decision: 'allow', classification: 'primary' })
    expect((await check(`${fixture.url}/allowed`)).network).toMatchObject({ decision: 'allow', kind: 'network' })
    expect((await check(`http://localhost:${fixture.port}/`)).evaluation).toMatchObject({ decision: 'deny', rule: 'scope.host-not-listed' })
    expect((await check(`http://127.0.0.1:${otherService.port}/`)).evaluation).toMatchObject({ decision: 'deny', rule: 'scope.port-not-allowed' })
    const draft = { hosts: [{ host: 'public.test' }] }
    expect((await check('https://www.public.test/', draft)).evaluation).toMatchObject({ decision: 'deny', rule: 'scope.subdomain-not-included' })
    expect((await check('https://public.test/', draft)).network).toMatchObject({ decision: 'allow', destination: { addresses: [{ address: '93.184.215.14', category: 'public' }] } })
  })

  it('versions scope changes, rejects invalid or stale ones and re-evaluates readiness', async () => {
    const engagement = await readyEngagement()
    const scopeUrl = `/api/security/engagements/${engagement.id}/scope`
    expect((await api('PUT', scopeUrl, { manifest: { hosts: [{ host: '127.0.0.1' }], networks: { cidrs: ['0.0.0.0/0'] } } })).status).toBe(400)
    expect((await api('PUT', scopeUrl, { manifest: { hosts: [{ host: '127.0.0.1' }], authorized: true } })).status).toBe(400)
    expect((await api('PUT', scopeUrl, { manifest: engagement.scope, expectedScopeVersion: 7 })).status).toBe(409)
    // Adding a port that no authorization covers makes the engagement not ready again.
    const widened = { ...engagement.scope, hosts: [{ host: '127.0.0.1', ports: [fixture.port, otherService.port] }] }
    const { status, body } = await api<SecurityEngagementDetail>('PUT', scopeUrl, { manifest: widened, expectedScopeVersion: 1 })
    expect(status).toBe(200)
    expect(body).toMatchObject({ scopeVersion: 2, status: 'authorization-pending', readiness: { state: 'not-authorized' } })
    expect(body.scopeHash).not.toBe(engagement.scopeHash)
    const events = (await api<{ type: string; data: { scope?: unknown; scopeVersion?: number } }[]>('GET', `/api/security/engagements/${engagement.id}/events`)).body
    expect(events.filter((e) => e.type === 'scope.changed').map((e) => e.data.scopeVersion)).toEqual([2])
  })

  it('gates lifecycle actions on readiness and freezes closed engagements', async () => {
    const draft = (await api<SecurityEngagementDetail>('POST', '/api/security/engagements', { name: 'Draft', targetUrl: fixture.url })).body
    expect((await api('POST', `/api/security/engagements/${draft.id}/lifecycle`, { action: 'activate' })).status).toBe(409)
    const engagement = await readyEngagement()
    expect((await api<SecurityEngagementDetail>('POST', `/api/security/engagements/${engagement.id}/lifecycle`, { action: 'activate' })).body.status).toBe('active')
    expect((await api<SecurityEngagementDetail>('POST', `/api/security/engagements/${engagement.id}/lifecycle`, { action: 'cancel' })).body.status).toBe('cancelled')
    expect((await api('PATCH', `/api/security/engagements/${engagement.id}`, { environment: 'isolated-lab' })).status).toBe(409)
  })

  it('exposes catalog and policy views but no endpoint that executes a capability', async () => {
    const engagement = await readyEngagement()
    expect((await api<{ id: string }[]>('GET', '/api/security/capabilities')).body.map((c) => c.id)).toEqual([
      'api.contract-test',
      'discovery.crawl',
      'discovery.http-inspect',
      'discovery.http-observe',
      'discovery.identity-http',
      'source.static-analysis',
      'web.signal-scan',
    ])
    expect((await api<{ evaluatedEnvironment: string }>('GET', `/api/security/engagements/${engagement.id}/policy`)).body.evaluatedEnvironment).toBe('staging')
    for (const path of ['execute', 'run', 'capabilities/discovery.http-observe', 'executions']) {
      expect((await app.inject({ method: 'POST', url: `/api/security/engagements/${engagement.id}/${path}`, payload: {} })).statusCode, path).toBe(404)
    }
  })
})

describe('Phase 1 flow through the persisted broker', () => {
  const broker = (registry = createDefaultRegistry()) => new CapabilityBroker({ registry, store: createDbSecurityStore(db), resolver })
  const observe = (engagementId: string, url: string, registry?: CapabilityRegistry) =>
    broker(registry).execute({ engagementId, capabilityId: 'discovery.http-observe', input: { url }, actor: user })

  it('Case A — valid engagement: allowed, executed, evidence and events persisted', async () => {
    const engagement = await readyEngagement()
    const outcome = await observe(engagement.id, `${fixture.url}/redirect/in-scope`)
    expect(outcome.status).toBe('completed')
    expect(outcome.decision).toMatchObject({ decision: 'allow', authorization: { state: 'valid' }, scope: { version: 1, hash: engagement.scopeHash } })

    const events = (await api<{ type: string; executionId: string | null; decision: { decision: string } | null }[]>('GET', `/api/security/engagements/${engagement.id}/events?execution=${outcome.executionId}`)).body
    expect(events.map((e) => e.type)).toEqual(['capability.requested', 'capability.allowed', 'capability.started', 'capability.completed'])
    expect(events[1]!.decision?.decision).toBe('allow')

    const evidence = (await api<{ ref: string; provenance: Record<string, unknown> }[]>('GET', `/api/security/engagements/${engagement.id}/evidence`)).body
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ ref: 'EV-1', provenance: { executionId: outcome.executionId, capabilityId: 'discovery.http-observe', environment: 'staging', scopeVersion: 1 } })
    const row = await pool.query('select audit_id, engagement_id, security_execution_id from evidence')
    expect(row.rows).toEqual([{ audit_id: null, engagement_id: engagement.id, security_execution_id: outcome.executionId }])
  })

  it('Case B — unauthorized engagement: denied, executor never reached, nothing sent', async () => {
    const created = (await api<SecurityEngagementDetail>('POST', '/api/security/engagements', { name: 'Unauthorized', targetUrl: fixture.url, environment: 'staging' })).body
    const before = fixture.total()
    const outcome = await observe(created.id, `${fixture.url}/allowed`)
    expect(outcome).toMatchObject({ status: 'denied', decision: { stage: 'authorization', rule: 'authorization.engagement-not-authorized' } })
    expect(fixture.total()).toBe(before)
    expect(await eventTypes(created.id)).toEqual(expect.arrayContaining(['capability.requested', 'capability.denied']))
    expect(await eventTypes(created.id)).not.toContain('capability.started')
    expect((await pool.query('select count(*)::int as n from evidence')).rows[0].n).toBe(0)
  })

  it('Case C — out-of-scope destination: scope denies before anything is sent', async () => {
    const engagement = await readyEngagement()
    const before = otherService.total()
    for (const url of [`${otherService.url}/allowed`, `http://localhost:${fixture.port}/allowed`, `http://sub.localhost:${fixture.port}/`]) {
      const outcome = await observe(engagement.id, url)
      expect(outcome.decision, url).toMatchObject({ decision: 'deny', stage: 'scope' })
    }
    expect(otherService.total()).toBe(before)
    // An out-of-scope redirect is recorded but not followed.
    const redirected = await observe(engagement.id, `${fixture.url}/redirect/other-port?port=${otherService.port}`)
    expect((redirected.output as { blockedRedirect: { rule: string } }).blockedRedirect.rule).toBe('scope.port-not-allowed')
    expect(otherService.total()).toBe(before)
  })

  it('Case D — capability risk incompatible with the environment: policy denies', async () => {
    const engagement = await readyEngagement('production')
    let reached = 0
    const stateChanging: SecurityCapability<{ url: string }, null> = {
      metadata: {
        ...httpObserveCapability.metadata,
        id: 'web.test-state-change',
        name: 'State-changing test capability',
        description: 'Declares state-changing risk; used only to prove policy denial.',
        riskClass: 'state-changing',
        sideEffect: 'reversible-write',
        implementation: 'test/state-change@1',
      },
      implementation: {
        id: 'test/state-change@1',
        input: z.strictObject({ url: z.string() }),
        targets: (input) => [input.url],
        execute: async () => {
          reached++
          return { output: null, summary: 'should never run' }
        },
      },
    }
    const outcome = await broker(new CapabilityRegistry().register(stateChanging)).execute({
      engagementId: engagement.id,
      capabilityId: 'web.test-state-change',
      input: { url: `${fixture.url}/allowed` },
      actor: user,
    })
    expect(outcome.decision).toMatchObject({ decision: 'deny', stage: 'policy', rule: 'policy.risk-not-selected', environment: 'production' })
    expect(reached).toBe(0)
  })
})

describe('audit trail, redaction and trusted configuration', () => {
  it('keeps security events append-only and evidence single-owner at the database level', async () => {
    const engagement = await readyEngagement()
    await expect(pool.query('update security_events set message = $1 where engagement_id = $2', ['rewritten', engagement.id])).rejects.toThrow(/append-only/)
    await expect(pool.query('delete from security_events where engagement_id = $1', [engagement.id])).rejects.toThrow(/append-only/)
    await expect(
      pool.query(`insert into evidence (id, ref, source, type, title, summary) values ('ev_orphan', 'EV-1', 'system', 'metric', 't', 's')`),
    ).rejects.toThrow(/evidence_single_owner/)
  })

  it('redacts secrets from API responses and persisted events', async () => {
    const created = (await api<SecurityEngagementDetail>('POST', '/api/security/engagements', {
      name: 'Secrets',
      targetUrl: fixture.url,
      environment: 'staging',
      description: 'Staging login: password=hunter2, token Bearer abcdef123456',
    })).body
    expect(JSON.stringify(created)).not.toContain('hunter2')
    expect(JSON.stringify(created)).not.toContain('abcdef123456')
    await api('POST', `/api/security/engagements/${created.id}/authorizations`, { method: 'local-development' })
    await observe(created.id, `${fixture.url}/headers?access_token=query-secret-999`)
    const raw = JSON.stringify((await pool.query('select message, decision, data from security_events where engagement_id = $1', [created.id])).rows)
    const evidence = JSON.stringify((await pool.query('select title, summary, metadata from evidence where engagement_id = $1', [created.id])).rows)
    for (const secret of ['query-secret-999', 'fixture-session-secret-value', 'fixture-api-key-secret']) {
      expect(raw, secret).not.toContain(secret)
      expect(evidence, secret).not.toContain(secret)
    }
    const listed = JSON.stringify((await api('GET', `/api/security/engagements/${created.id}/evidence`)).body)
    expect(listed).not.toContain('fixture-session-secret-value')
    expect(JSON.parse(listed)[0].provenance).toMatchObject({ sensitivity: 'sensitive' })
  })

  it('refuses configuration changes from agents and leaves the engagement untouched', async () => {
    const engagement = await readyEngagement('production')
    const agent = { kind: 'agent' as const, id: null, agentRunId: 'ar_injected' }
    await expect(service.updateScope(engagement.id, { manifest: { hosts: [{ host: 'evil.test', includeSubdomains: true }] } }, agent)).rejects.toMatchObject({ status: 403 })
    await expect(service.updateEngagement(engagement.id, { environment: 'isolated-lab' }, agent)).rejects.toMatchObject({ status: 403 })
    await expect(service.requestAuthorization(engagement.id, { method: 'local-development', subject: { host: 'localhost', port: 1 } }, agent)).rejects.toMatchObject({ status: 403 })
    await expect(service.applyLifecycle(engagement.id, { action: 'activate' }, agent)).rejects.toMatchObject({ status: 403 })
    const after = await service.getEngagement(engagement.id)
    expect(after).toMatchObject({ environment: 'production', scopeVersion: 1, configVersion: engagement.configVersion, status: 'ready' })
    expect(after.authorizations).toHaveLength(1)
  })

  it('Website Audits keep working without any security engagement or authorization', async () => {
    expect((await pool.query('select count(*)::int as n from security_engagements')).rows[0].n).toBe(0)
    const response = await app.inject({ method: 'POST', url: '/api/audits', payload: { url: 'example.com' } })
    expect(response.statusCode).toBe(201)
    const audit = response.json() as { id: string; status: string }
    expect(audit.status).toBe('queued')
    const jobs = await boss.fetch(QUEUES.baseline, { batchSize: 10 })
    expect(jobs.map((j) => (j.data as { auditId: string }).auditId)).toContain(audit.id)
    // Audit evidence is unaffected by the engagement-owned evidence extension.
    const row = await createAuditRecord(db, { url: 'example.org', normalizedUrl: 'https://example.org/', domain: 'example.org', aiEnabled: false })
    const item = await createEvidence(db, { auditId: row.id, source: 'baseline', type: 'metric', title: 'Load time', summary: '1.2 s' })
    expect(item).toMatchObject({ ref: 'EV-1', auditId: row.id })
    expect((await listEvidence(db, row.id)).map((e) => e.ref)).toEqual(['EV-1'])
  })
})

function observe(engagementId: string, url: string) {
  return new CapabilityBroker({ registry: createDefaultRegistry(), store: createDbSecurityStore(db), resolver }).execute({
    engagementId,
    capabilityId: 'discovery.http-observe',
    input: { url },
    actor: user,
  })
}
