import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetConfig } from '@audivra/config'
import { SECURITY_REPORT_EXPORT_KINDS } from '@audivra/contracts'
import { createBoss, ensureQueues, listFindingsForEngagement, type PgBoss } from '@audivra/database'
import {
  ATTACK_PATH_EXPORT_KINDS,
  AttackPathReadService,
  AttackPathService,
  type CapabilityBroker,
  collectDiagnostics,
  ComparisonEngine,
  createDurableBroker,
  createRuntimeRegistry,
  createSecurityReportService,
  DomainService,
  FakeSpecialistEngine,
  FINDING_EXPORT_KINDS,
  FindingReadService,
  generateAttackPathExport,
  generateFindingExport,
  generateHistoryExport,
  generateSecurityReportExport,
  GraphProjector,
  HISTORY_EXPORT_KINDS,
  HistoryReadService,
  keyringFromKeys,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  SpecialistRunService,
  VerificationService,
  type Resolver,
} from '@audivra/security'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 6F — a systematic secret-safety audit of EVERY security export. A canary credential token and a
 * session cookie are seeded into an engagement that then produces a finding, an attack path and a specialist
 * run; the client report + every export kind + the diagnostics are generated, and the canary markers must
 * appear in NONE of them. This is the headline "exports leak no secrets" gate (§20).
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
let fixture: IdentityFixture
let projector: GraphProjector
let engine: ComparisonEngine
let broker: CapabilityBroker
let establishment: SessionEstablishmentService

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  fixture = await startIdentityFixture('exports-safety')
  projector = new GraphProjector({ db })
  broker = createDurableBroker({ db, boss, resolver: loopback })
  engine = new ComparisonEngine({ db, broker, projector })
  establishment = new SessionEstablishmentService({ db, vault })
})
afterAll(async () => {
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

describe('Phase 6F — security exports contain no secrets', () => {
  it('no canary token or cookie reaches any export kind, the client report or diagnostics', async () => {
    const tokenCanary = `CANARY-${randomBytes(12).toString('hex')}`
    const cookieCanary = `CANARY-${randomBytes(12).toString('hex')}`
    const created = await service.createEngagement({ name: 'Exports safety', targetUrl: fixture.url, environment: 'isolated-lab' }, user)
    const eid = created.id
    await service.requestAuthorization(eid, { method: 'local-development' }, user)

    // Seed canary secrets into bob's credential (token) and a session (cookie).
    for (const [ref, token] of [['alice', `al-${randomBytes(4).toString('hex')}`], ['bob', tokenCanary]] as const) {
      fixture.tokens.set(token, ref)
      fixture.principals.set(ref, { tenant: 't1', role: 'user' })
      await domain.declare(eid, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: 't1' } }, user)
      await vault.setCredential(eid, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
      const est = await establishment.establish(eid, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
      expect(est.established).toBe(true)
    }
    // The canary cookie lives on a standalone identity so it cannot shadow a comparison participant's session.
    await domain.declare(eid, { kind: 'identity', ref: 'carol', spec: { identityType: 'user', authMethod: 'session', credentialRef: 'carol-cred', tenantRef: 't1' } }, user)
    await vault.createSession(eid, { identityRef: 'carol', environment: 'isolated-lab', authMethod: 'session-cookie', status: 'active', material: { cookies: [{ name: 'sid', value: cookieCanary }] }, expiresAt: null }, user)

    // Produce a finding + attack path from a broken object boundary (bob reads alice's resource).
    fixture.resources.set('xdoc', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
    const url = `${fixture.url}/api/resources/xdoc`
    await domain.declare(eid, { kind: 'resource', ref: 'xdoc', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, user)
    const arm = (role: string, identityRef: string | null, outcome: string) => ({ role, identityRef, resourceRef: 'xdoc', url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })
    const cmp = await engine.planAndRun(eid, { dimension: 'object-boundary', resourceRef: 'xdoc', action: 'read', arms: [arm('subject', 'bob', 'deny'), arm('positive-control', 'alice', 'allow'), arm('negative-control', null, 'deny')] }, user)
    expect(cmp.result).toBe('inconsistent')
    await new VerificationService({ db, registry, graphProjector: projector }).drive(eid)
    await new AttackPathService({ db }).drive(eid)
    expect((await listFindingsForEngagement(db, eid)).length).toBeGreaterThanOrEqual(1)

    // A specialist run (fake engine, no vulns) so the specialist read surface has a row.
    const specialist = new SpecialistRunService({ db, broker, engines: { strix: new FakeSpecialistEngine({ vulnerabilities: [] }) }, graphProjector: projector })
    const run = await specialist.request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['xdoc'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
    await specialist.drive(run.id)

    // A second engagement as "previous" so the history export has content to diff against.
    const prev = await service.createEngagement({ name: 'Previous', targetUrl: fixture.url, environment: 'isolated-lab' }, user)

    const reportService = createSecurityReportService(db)
    const surfaces: Record<string, string> = {}
    for (const kind of FINDING_EXPORT_KINDS) surfaces[`finding:${kind}`] = (await generateFindingExport(new FindingReadService({ db }), eid, kind)).body
    for (const kind of ATTACK_PATH_EXPORT_KINDS) surfaces[`path:${kind}`] = (await generateAttackPathExport(new AttackPathReadService({ db }), eid, kind)).body
    for (const kind of HISTORY_EXPORT_KINDS) surfaces[`history:${kind}`] = (await generateHistoryExport(new HistoryReadService({ db }), prev.id, eid, kind)).body
    for (const kind of SECURITY_REPORT_EXPORT_KINDS) surfaces[`report:${kind}`] = (await generateSecurityReportExport(reportService, eid, kind, { previousEngagementId: prev.id })).body
    surfaces['diagnostics'] = JSON.stringify(await collectDiagnostics({ db }))

    for (const [name, body] of Object.entries(surfaces)) {
      expect(body.length, `${name} should not be empty`).toBeGreaterThan(0)
      expect(body, `${name} must not contain the token canary`).not.toContain(tokenCanary)
      expect(body, `${name} must not contain the cookie canary`).not.toContain(cookieCanary)
    }

    // Sanity: the vault CAN still reveal the real secret, so the assertions above are not vacuous.
    const resolved = await vault.resolveCredentialByRef(eid, 'bob-cred')
    expect(resolved).not.toBeNull()
    expect(JSON.stringify(resolved!.secret.reveal())).toContain(tokenCanary)
  }, 180_000)
})
