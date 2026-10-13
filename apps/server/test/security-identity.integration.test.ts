import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { SessionEstablishmentResult } from '@audivra/contracts'
import { createBoss, ensureQueues, type PgBoss } from '@audivra/database'
import {
  CapabilityBroker,
  createBossExecutionQueue,
  createDbExecutionStore,
  createDbSecurityStore,
  createRuntimeRegistry,
  DomainService,
  ExecutionRuntime,
  GraphProjector,
  keyringFromKeys,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  VaultAuthResolver,
  type FormLoginDriver,
  type Resolver,
} from '@audivra/security'
import { chromiumExecutable } from '@audivra/tool-runtime'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 5 Step 3 end to end on the real database: establish a session for a declared identity, run an
 * identity-aware capability that authenticates with the injected material, and prove — the capability
 * authenticated as exactly that identity, its evidence/observations are tagged with the identity/session,
 * the graph records AUTHENTICATES_AS, revocation makes further runs refuse, A/B identities stay isolated,
 * anonymous still works, a down vault degrades safely, sessions survive a "restart", and no secret leaks.
 */

const KEY = randomBytes(32)
const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const loopback: Resolver = async (host) => {
  if (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver: loopback })
const domain = new DomainService({ db })
const vault = new SecretVault({ db, keyring: keyringFromKeys([{ key: KEY }]) })
const projector = new GraphProjector({ db })
const registry = createRuntimeRegistry()

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: IdentityFixture
let broker: CapabilityBroker
let runtime: ExecutionRuntime
let establishment: SessionEstablishmentService
const logs: string[] = []

const authResolver = () => new VaultAuthResolver({ db, vault })

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  const log = createLogger({ write: (chunk: string) => void logs.push(chunk) })
  app = await buildApp({ db, boss, hub: null, log, security: service })
  fixture = await startIdentityFixture('primary')
  const store = createDbSecurityStore(db)
  const executions = createDbExecutionStore(db)
  broker = new CapabilityBroker({ registry, store, resolver: loopback, authResolver: authResolver(), executions: { store: executions, queue: createBossExecutionQueue(boss) } })
  runtime = new ExecutionRuntime({ registry, store, executions, resolver: loopback, authResolver: authResolver(), pollIntervalMs: 200, cancelGraceMs: 1500 })
  establishment = new SessionEstablishmentService({ db, vault, projector })
})

afterAll(async () => {
  await runtime.shutdown()
  await app.close()
  await boss.stop({ graceful: false })
  await fixture.close()
  await handle.close()
  delete process.env.AUDIVRA_SECRET_KEY
  resetConfig()
})

beforeEach(async () => {
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
  await boss.deleteAllJobs()
  fixture.requests.length = 0
  fixture.tokens.clear()
  fixture.sessions.clear()
  fixture.headerSecrets.clear()
  fixture.users.clear()
})

async function readyEngagement(name: string): Promise<string> {
  const created = await service.createEngagement({ name, targetUrl: fixture.url, environment: 'staging' }, user)
  await service.requestAuthorization(created.id, { method: 'local-development' }, user)
  return created.id
}

/** Declares an identity with a bearer credential the fixture recognizes, then establishes an api-token session. */
async function establishBearer(engagementId: string, ref: string): Promise<{ token: string; result: SessionEstablishmentResult }> {
  const token = `CANARY-${ref}-${randomBytes(8).toString('hex')}`
  fixture.tokens.set(token, ref)
  await domain.declare(engagementId, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred` } }, user)
  await vault.setCredential(engagementId, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  const result = await establishment.establish(engagementId, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
  return { token, result }
}

async function runIdentityHttp(engagementId: string, extra: { identityRef?: string; sessionRef?: string } = {}): Promise<{ executionId: string; status: string }> {
  const outcome = await broker.submit({ engagementId, capabilityId: 'discovery.identity-http', input: { url: `${fixture.url}/me` }, actor: user, ...extra })
  if (outcome.status !== 'queued') return { executionId: outcome.executionId, status: `denied:${outcome.decision.reason}` }
  const status = await runtime.run(outcome.executionId)
  return { executionId: outcome.executionId, status: status ?? 'unknown' }
}

const edges = (engagementId: string, type: string) => pool.query('select * from security_graph_edges e where e.engagement_id = $1 and e.type = $2', [engagementId, type]).then((r) => r.rows)

describe('identity-aware execution', () => {
  it('establishes, authenticates, tags evidence/observations and the graph, then refuses after revocation', async () => {
    const e = await readyEngagement('lifecycle')
    const { token, result } = await establishBearer(e, 'alice')
    expect(result).toMatchObject({ established: true, reused: false, failure: null })
    const sessionId = result.session!.id
    expect(result.session).toMatchObject({ identityRef: 'alice', status: 'active', authMethod: 'api-token', material: true })

    // Run the identity-aware capability as alice.
    const run = await runIdentityHttp(e, { identityRef: 'alice', sessionRef: sessionId })
    expect(run.status).toBe('succeeded')

    // The fixture saw the bearer and recognized alice (the /me request during this run).
    const meRuns = fixture.requests.filter((r) => r.path === '/me' && r.headers.authorization === `Bearer ${token}`)
    expect(meRuns.at(-1)?.authenticatedAs).toBe('alice')

    // The observation is tagged with the identity/session and reports an authenticated response.
    const observations = await service.listObservations(e)
    const response = observations.find((o) => o.type === 'http-response')!
    expect(response.value).toMatchObject({ status: 200, authenticated: true })
    expect(response.contributions.at(-1)).toMatchObject({ identityRef: 'alice', sessionRef: sessionId })
    const evidence = await service.listEvidence(e)
    expect(evidence.some((ev) => ev.provenance.identityRef === 'alice' && ev.provenance.sessionRef === sessionId)).toBe(true)

    // The graph records AUTHENTICATES_AS (active).
    const active = await edges(e, 'AUTHENTICATES_AS')
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ attributes: { active: true } })

    // Revoke the session → a later identity-aware run refuses, and the edge goes inactive.
    await establishment.revoke(sessionId, user)
    const afterRevoke = await runIdentityHttp(e, { identityRef: 'alice', sessionRef: sessionId })
    expect(afterRevoke.status).toMatch(/^denied:/)
    const inactive = await edges(e, 'AUTHENTICATES_AS')
    expect(inactive[0]).toMatchObject({ attributes: { active: false } })

    // CANARY: the bearer token never reaches an Audivra surface.
    const surfaces = [
      JSON.stringify(observations),
      JSON.stringify(evidence),
      JSON.stringify(await service.listEvents(e)),
      JSON.stringify((await pool.query('select * from security_graph_nodes where engagement_id = $1', [e])).rows),
      JSON.stringify((await pool.query('select * from security_graph_edges where engagement_id = $1', [e])).rows),
      logs.join(''),
    ]
    for (const text of surfaces) expect(text).not.toContain(token)
    // Sanity: the fixture really did receive the token (so the test is meaningful).
    expect(fixture.requests.some((r) => r.headers.authorization === `Bearer ${token}`)).toBe(true)
  })

  it('keeps A/B identities isolated and runs them concurrently', async () => {
    const e = await readyEngagement('isolation')
    const alice = await establishBearer(e, 'alice')
    const bob = await establishBearer(e, 'bob')
    const [ra, rb] = await Promise.all([
      runIdentityHttp(e, { identityRef: 'alice', sessionRef: alice.result.session!.id }),
      runIdentityHttp(e, { identityRef: 'bob', sessionRef: bob.result.session!.id }),
    ])
    expect(ra.status).toBe('succeeded')
    expect(rb.status).toBe('succeeded')
    // Each identity authenticated as itself; neither bearer was ever seen under the other's name.
    const byToken = (t: string) => fixture.requests.filter((r) => r.headers.authorization === `Bearer ${t}`).map((r) => r.authenticatedAs)
    expect(new Set(byToken(alice.token))).toEqual(new Set(['alice']))
    expect(new Set(byToken(bob.token))).toEqual(new Set(['bob']))
  })

  it('runs anonymously (unchanged) when no identity is referenced', async () => {
    const e = await readyEngagement('anonymous')
    const run = await runIdentityHttp(e)
    expect(run.status).toBe('succeeded')
    const observations = await service.listObservations(e)
    const response = observations.find((o) => o.type === 'http-response')!
    expect(response.value).toMatchObject({ authenticated: false })
    expect(response.contributions.at(-1)).toMatchObject({ identityRef: null, sessionRef: null })
    // The /me request carried no credential.
    expect(fixture.requests.at(-1)?.authenticatedAs).toBeNull()
  })

  it('survives a worker "restart": a fresh resolver still resolves the stored session', async () => {
    const e = await readyEngagement('restart')
    const { result } = await establishBearer(e, 'alice')
    // New broker + runtime instances (same key, same DB) stand in for a restarted worker.
    const store = createDbSecurityStore(db)
    const executions = createDbExecutionStore(db)
    const broker2 = new CapabilityBroker({ registry, store, resolver: loopback, authResolver: authResolver(), executions: { store: executions, queue: createBossExecutionQueue(boss) } })
    const runtime2 = new ExecutionRuntime({ registry, store, executions, resolver: loopback, authResolver: authResolver(), pollIntervalMs: 200 })
    try {
      const outcome = await broker2.submit({ engagementId: e, capabilityId: 'discovery.identity-http', input: { url: `${fixture.url}/me` }, actor: user, identityRef: 'alice', sessionRef: result.session!.id })
      expect(outcome.status).toBe('queued')
      expect(await runtime2.run(outcome.executionId)).toBe('succeeded')
      expect(fixture.requests.at(-1)?.authenticatedAs).toBe('alice')
    } finally {
      await runtime2.shutdown()
    }
  })

  it('degrades safely when the vault is unavailable, and anonymous work still runs', async () => {
    const e = await readyEngagement('vault-down')
    await domain.declare(e, { kind: 'identity', ref: 'alice', spec: { authMethod: 'api-token', credentialRef: 'alice-cred' } }, user)
    await vault.setCredential(e, { ref: 'alice-cred', identityRef: 'alice', secret: { type: 'bearer-token', token: 'CANARY-vd' } }, user)
    // An establishment service whose vault has no key cannot resolve the credential.
    const downVault = new SecretVault({ db, keyring: keyringFromKeys([]) })
    const downEstablish = new SessionEstablishmentService({ db, vault: downVault, projector })
    const result = await downEstablish.establish(e, { identityRef: 'alice', flow: { type: 'api-token', placement: 'bearer', validStatuses: [200] } }, user)
    expect(result).toMatchObject({ established: false, failure: { kind: 'vault-unavailable' } })
    // Anonymous identity-aware work is unaffected.
    expect((await runIdentityHttp(e)).status).toBe('succeeded')
  })

  it('reuses a valid session instead of re-authenticating', async () => {
    const e = await readyEngagement('reuse')
    const first = await establishBearer(e, 'alice')
    const again = await establishment.establish(e, { identityRef: 'alice', flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] }, reuse: true }, user)
    expect(again).toMatchObject({ established: true, reused: true })
    expect(again.session!.id).toBe(first.result.session!.id)
  })

  it('refuses to establish for an unknown identity, and reports a precise failure kind', async () => {
    const e = await readyEngagement('unknown')
    const missing = await establishment.establish(e, { identityRef: 'nobody', flow: { type: 'api-token', placement: 'bearer', validStatuses: [200] } }, user)
    expect(missing).toMatchObject({ established: false, failure: { kind: 'identity-unknown' } })
    // A declared identity with no credential fails distinctly (credential-missing), never silently.
    await domain.declare(e, { kind: 'identity', ref: 'nocred', spec: { authMethod: 'api-token' } }, user)
    const noCred = await establishment.establish(e, { identityRef: 'nocred', flow: { type: 'api-token', placement: 'bearer', validStatuses: [200] } }, user)
    expect(noCred).toMatchObject({ established: false, failure: { kind: 'credential-missing' } })
  })

  it('establishes a form-login session (injected driver) and authenticates with its cookies', async () => {
    const e = await readyEngagement('form-login')
    const sid = `CANARY-sid-${randomBytes(8).toString('hex')}`
    fixture.sessions.set(sid, 'carol')
    await domain.declare(e, { kind: 'identity', ref: 'carol', spec: { authMethod: 'form', credentialRef: 'carol-cred' } }, user)
    await vault.setCredential(e, { ref: 'carol-cred', identityRef: 'carol', secret: { type: 'username-password', username: 'carol', password: 'pw' } }, user)
    const driver: FormLoginDriver = {
      login: async () => ({ cookies: [{ name: 'sid', value: sid }], finalUrl: `${fixture.url}/dashboard` }),
    }
    const withDriver = new SessionEstablishmentService({ db, vault, projector, browserLogin: driver })
    const result = await withDriver.establish(
      e,
      { identityRef: 'carol', flow: { type: 'form-login', loginUrl: `${fixture.url}/login`, usernameSelector: '#username', passwordSelector: '#password', submitSelector: 'button[type=submit]', validateUrl: `${fixture.url}/me` } },
      user,
    )
    expect(result).toMatchObject({ established: true, failure: null })
    const run = await runIdentityHttp(e, { identityRef: 'carol', sessionRef: result.session!.id })
    expect(run.status).toBe('succeeded')
    expect(fixture.requests.filter((r) => r.path === '/me').at(-1)?.authenticatedAs).toBe('carol')
  })

  // Uses the real Playwright driver against the fixture's login form. Skipped where no browser is installed.
  it.skipIf(!chromiumExecutable())('establishes a form-login session with a real headless browser', async () => {
    const e = await readyEngagement('browser-login')
    fixture.users.set('dave', { password: 'pw-dave', sid: `CANARY-sid-${randomBytes(6).toString('hex')}`, who: 'dave' })
    await domain.declare(e, { kind: 'identity', ref: 'dave', spec: { authMethod: 'form', credentialRef: 'dave-cred' } }, user)
    await vault.setCredential(e, { ref: 'dave-cred', identityRef: 'dave', secret: { type: 'username-password', username: 'dave', password: 'pw-dave' } }, user)
    // No injected driver → the service lazily loads the Playwright driver.
    const result = await establishment.establish(
      e,
      { identityRef: 'dave', flow: { type: 'form-login', loginUrl: `${fixture.url}/login`, usernameSelector: '#username', passwordSelector: '#password', submitSelector: 'button[type=submit]', successUrlIncludes: '/dashboard', validateUrl: `${fixture.url}/me` } },
      user,
    )
    expect(result, JSON.stringify(result.failure)).toMatchObject({ established: true, failure: null })
    const run = await runIdentityHttp(e, { identityRef: 'dave', sessionRef: result.session!.id })
    expect(run.status).toBe('succeeded')
    expect(fixture.requests.filter((r) => r.path === '/me').at(-1)?.authenticatedAs).toBe('dave')
  }, 60_000)

  it('exposes identity coverage over the API', async () => {
    const e = await readyEngagement('coverage')
    const { result } = await establishBearer(e, 'alice')
    expect((await runIdentityHttp(e, { identityRef: 'alice', sessionRef: result.session!.id })).status).toBe('succeeded')
    const response = await app.inject({ method: 'GET', url: `/api/security/engagements/${e}/identities/coverage` })
    const coverage = response.json() as { ref: string; credentialAvailable: boolean; sessionActive: boolean; observationsUnderIdentity: number }[]
    const alice = coverage.find((c) => c.ref === 'alice')!
    expect(alice).toMatchObject({ credentialAvailable: true, sessionActive: true })
    expect(alice.observationsUnderIdentity).toBeGreaterThan(0)
  })
})
