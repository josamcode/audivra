import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { SecurityFinding } from '@audivra/contracts'
import { createBoss, ensureQueues, listFindingsForEngagement, type PgBoss } from '@audivra/database'
import {
  ComparisonEngine,
  createDurableBroker,
  createRuntimeRegistry,
  DomainService,
  GraphProjector,
  HistoryReadService,
  HistoryService,
  keyringFromKeys,
  RetestService,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  VerificationService,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 6C end to end on the real database + identity fixture. A broken object boundary becomes a supported
 * finding; replaying it against a later assessment yields a historical result:
 *   - still leaky → STILL_PRESENT
 *   - now enforced (bob denied, owner alice still allowed) → FIXED (control proves the test is meaningful)
 *   - resource no longer declared → CANNOT_REPRODUCE (a gap, never a fix).
 * The assessment comparison then classifies a retest-proven absence as fixed and an un-retested absence as
 * not-tested — "not found again" is never silently a fix.
 */

const KEY = randomBytes(32)
const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const service = new SecurityService({ db, resolver: loopback })
const domain = new DomainService({ db })
const vault = new SecretVault({ db, keyring: keyringFromKeys([{ key: KEY }]) })
const registry = createRuntimeRegistry()

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: IdentityFixture
let engine: ComparisonEngine
let establishment: SessionEstablishmentService
let projector: GraphProjector
let retests: RetestService
let history: HistoryService
let read: HistoryReadService

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: createLogger({ write: () => {} }), security: service })
  fixture = await startIdentityFixture('history')
  projector = new GraphProjector({ db })
  const broker = createDurableBroker({ db, boss, resolver: loopback })
  engine = new ComparisonEngine({ db, broker, projector })
  establishment = new SessionEstablishmentService({ db, vault })
  retests = new RetestService({ db, comparisonEngine: engine, registry })
  history = new HistoryService({ db })
  read = new HistoryReadService({ db })
})

afterAll(async () => {
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
  for (const m of [fixture.tokens, fixture.sessions, fixture.principals, fixture.resources, fixture.users]) m.clear()
})

async function engagement(name: string): Promise<string> {
  const created = await service.createEngagement({ name, targetUrl: fixture.url, environment: 'isolated-lab' }, user)
  await service.requestAuthorization(created.id, { method: 'local-development' }, user)
  return created.id
}
async function identity(e: string, ref: string, tenant: string): Promise<void> {
  const token = `h-${ref}-${randomBytes(5).toString('hex')}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role: 'user' })
  await domain.declare(e, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, user)
  await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  const r = await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
  expect(r.established).toBe(true)
}
const arm = (role: string, identityRef: string | null, resourceRef: string, url: string, outcome: string) => ({ role, identityRef, resourceRef, url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })

/** Declare a resource (and set its fixture enforcement), without running a comparison. */
async function declareResource(e: string, id: string, enforce: 'strict' | 'leaky'): Promise<string> {
  fixture.resources.set(id, { tenant: 't1', owner: 'alice', state: 'draft', enforce })
  const url = `${fixture.url}/api/resources/${id}`
  await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, user)
  return url
}
/** Declare a leaky resource and run the object-boundary comparison (→ inconsistent, a candidate). */
async function broken(e: string, id: string): Promise<void> {
  const url = await declareResource(e, id, 'leaky')
  const result = await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: id, action: 'read', arms: [arm('subject', 'bob', id, url, 'deny'), arm('positive-control', 'alice', id, url, 'allow'), arm('negative-control', null, id, url, 'deny')] }, user)
  expect(result.result).toBe('inconsistent')
}
async function assessmentWithFindings(name: string, resourceIds: string[]): Promise<{ id: string; findings: SecurityFinding[] }> {
  const id = await engagement(name)
  await identity(id, 'alice', 't1')
  await identity(id, 'bob', 't1')
  for (const r of resourceIds) await broken(id, r)
  await new VerificationService({ db, registry, graphProjector: projector }).drive(id)
  return { id, findings: await listFindingsForEngagement(db, id) }
}
const findingFor = (findings: SecurityFinding[], resource: string) =>
  findings.find((f) => f.issueKey.includes(resource) || f.affectedEntities.some((en) => en.label === resource || en.key.includes(resource)))!

async function api<T = unknown>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const response = await app.inject({ method, url, ...(body ? { payload: body } : {}) })
  return { status: response.statusCode, body: (response.headers['content-type']?.includes('json') ? response.json() : null) as T, text: response.body }
}

describe('Phase 6C — retesting and historical comparison', () => {
  it('replays a finding into still-present / fixed / cannot-reproduce, and a fix needs a working control', async () => {
    const a = await assessmentWithFindings('hist-A', ['hdoc1', 'hdoc2', 'hdoc3'])
    expect(a.findings.length).toBe(3)
    const caseHdoc1 = await retests.ensureCase(findingFor(a.findings, 'hdoc1').id)
    const caseHdoc2 = await retests.ensureCase(findingFor(a.findings, 'hdoc2').id)
    expect(caseHdoc1.reproductionFormat).toBe('differential-comparison')
    expect(caseHdoc1.eligibility.eligible).toBe(true)

    // Still present: a later assessment where the boundary is still broken.
    const b = await engagement('hist-B')
    await identity(b, 'alice', 't1')
    await identity(b, 'bob', 't1')
    await declareResource(b, 'hdoc1', 'leaky')
    const still = await retests.runRetest(caseHdoc1.id, b)
    expect(still.state).toBe('still-present')
    expect(still.controlValid).toBe(true)

    // Fixed: a later assessment where the boundary is now enforced (bob denied, owner alice still allowed).
    const c = await engagement('hist-C')
    await identity(c, 'alice', 't1')
    await identity(c, 'bob', 't1')
    await declareResource(c, 'hdoc2', 'strict')
    const fixed = await retests.runRetest(caseHdoc2.id, c)
    expect(fixed.state).toBe('fixed')
    expect(fixed.controlValid).toBe(true) // the positive control proved the test still meaningful
    expect(fixed.freshResult).toBe('consistent')

    // Cannot reproduce: a later assessment that no longer declares the resource → a gap, never a fix.
    const d = await engagement('hist-D')
    await identity(d, 'alice', 't1')
    await identity(d, 'bob', 't1')
    const gap = await retests.runRetest(caseHdoc1.id, d)
    expect(gap.state).toBe('cannot-reproduce')
    expect(gap.state).not.toBe('fixed')
  }, 180_000)

  it('classifies a retest-proven absence as fixed and an un-retested absence as not-tested', async () => {
    const a = await assessmentWithFindings('cmp-A', ['cdoc1', 'cdoc2'])
    const caseC1 = await retests.ensureCase(findingFor(a.findings, 'cdoc1').id)

    // Current assessment C: cdoc1 is enforced and retested (→ fixed); cdoc2 is never retested.
    const c = await engagement('cmp-C')
    await identity(c, 'alice', 't1')
    await identity(c, 'bob', 't1')
    await declareResource(c, 'cdoc1', 'strict')
    const fixed = await retests.runRetest(caseC1.id, c)
    expect(fixed.state).toBe('fixed')

    const comparison = await history.compareAssessments(a.id, c, { persist: true })
    const c1Key = findingFor(a.findings, 'cdoc1').issueKey
    const c2Key = findingFor(a.findings, 'cdoc2').issueKey
    const c1 = comparison.findingChanges.find((e) => e.match.previousIssueKey === c1Key)!
    const c2 = comparison.findingChanges.find((e) => e.match.previousIssueKey === c2Key)!
    expect(c1.class).toBe('fixed')
    expect(c1.retestResultId).toBeTruthy()
    expect(c2.class).toBe('not-tested') // absence without a retest is NEVER fixed
    // Zero false fixed: every "fixed" entry is backed by a retest result.
    expect(comparison.findingChanges.filter((e) => e.class === 'fixed').every((e) => e.retestResultId)).toBe(true)
    expect(comparison.summary.fixed).toBe(1)
    expect(comparison.summary.notTested).toBeGreaterThanOrEqual(1)

    // The historical report and lineage read from persisted state; the comparison is persisted (API).
    const report = await read.report(a.id, c)
    expect(report.fixedFindings.length).toBe(1)
    expect(report.executiveSummary).toContain('fixed')
    const lineage = await read.findingLineage(findingFor(a.findings, 'cdoc1').id)
    expect(lineage.entries.length).toBeGreaterThanOrEqual(2)

    // API: the comparison and a JSON export built only from persisted state.
    const persisted = await api<{ summary: { fixed: number } }>('GET', `/api/security/engagements/${c}/history/comparison?previous=${a.id}`)
    expect(persisted.status).toBe(200)
    expect(persisted.body.summary.fixed).toBe(1)
    const exported = await api('GET', `/api/security/engagements/${c}/history/export/json?previous=${a.id}`)
    expect(exported.status).toBe(200)
    expect(JSON.parse(exported.text).schemaVersion).toBe('audivra.security-history.v1')

    // An analyst decision is recorded with an audit trail (and changes no evidence).
    const decision = await api('POST', `/api/security/engagements/${c}/history/decisions`, { kind: 'note', subjectRef: c1Key, note: 'Reviewed and accepted as remediated.' })
    expect(decision.status).toBe(201)
    const decisions = await api<unknown[]>('GET', `/api/security/engagements/${c}/history/decisions`)
    expect(decisions.body.length).toBe(1)
  }, 180_000)
})
