import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AUDIVRA_VERSION, resetConfig } from '@audivra/config'
import { SystemDiagnostics } from '@audivra/contracts'
import { createBoss, ensureQueues, listFindingsForEngagement, type PgBoss } from '@audivra/database'
import {
  AttackPathService,
  type CapabilityBroker,
  collectDiagnostics,
  ComparisonEngine,
  createDurableBroker,
  createRuntimeRegistry,
  createSecurityReportService,
  DomainService,
  generateSecurityReportExport,
  GraphProjector,
  keyringFromKeys,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  VerificationService,
  type Resolver,
} from '@audivra/security'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 6F — production readiness. Exercises the operator-facing and client-facing deliverables that turn the
 * engine into a product: deterministic environment diagnostics (`pnpm doctor` / the health endpoint), the
 * combined client report (built from stored state with NO AI re-run, §18), and the owned-resource / leak
 * inventory (Audivra-owned only, never global — §24/§61). A clean run must leave no owned processes behind.
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
  fixture = await startIdentityFixture('production')
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
  await pool.query('truncate owned_processes cascade')
  await boss.deleteAllJobs()
  fixture.requests.length = 0
  for (const m of [fixture.tokens, fixture.sessions, fixture.principals, fixture.resources, fixture.users]) m.clear()
})

async function engagementWithFinding(name: string): Promise<string> {
  const created = await service.createEngagement({ name, targetUrl: fixture.url, environment: 'isolated-lab' }, user)
  const eid = created.id
  await service.requestAuthorization(eid, { method: 'local-development' }, user)
  for (const ref of ['alice', 'bob'] as const) {
    const token = `pr-${ref}-${randomBytes(5).toString('hex')}`
    fixture.tokens.set(token, ref)
    fixture.principals.set(ref, { tenant: 't1', role: 'user' })
    await domain.declare(eid, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: 't1' } }, user)
    await vault.setCredential(eid, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
    const est = await establishment.establish(eid, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
    expect(est.established).toBe(true)
  }
  fixture.resources.set('doc1', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  const url = `${fixture.url}/api/resources/doc1`
  await domain.declare(eid, { kind: 'resource', ref: 'doc1', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, user)
  const arm = (role: string, identityRef: string | null, outcome: string) => ({ role, identityRef, resourceRef: 'doc1', url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })
  const cmp = await engine.planAndRun(eid, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [arm('subject', 'bob', 'deny'), arm('positive-control', 'alice', 'allow'), arm('negative-control', null, 'deny')] }, user)
  expect(cmp.result).toBe('inconsistent')
  await new VerificationService({ db, registry, graphProjector: projector }).drive(eid)
  await new AttackPathService({ db }).drive(eid)
  return eid
}

describe('Phase 6F — diagnostics', () => {
  it('returns a well-formed diagnostics report pinned to the product version with the DB check ready', async () => {
    const report = await collectDiagnostics({ db })
    expect(() => SystemDiagnostics.parse(report)).not.toThrow()
    expect(report.version).toBe(AUDIVRA_VERSION)
    expect(['ready', 'degraded', 'blocked']).toContain(report.overall)
    const dbCheck = report.checks.find((c) => c.id === 'database')
    expect(dbCheck?.required).toBe(true)
    expect(dbCheck?.state).toBe('ready')
    // Every actually-unmet check must carry a concrete remediation — never a bare "something went wrong".
    for (const c of report.checks) {
      if (c.state !== 'ready' && c.state !== 'optional') expect(c.remediation.length, `${c.id} needs a remediation`).toBeGreaterThan(0)
    }
  })

  it('reports an owned-only resource inventory — never anything Audivra did not create (§24)', async () => {
    const { resources } = await collectDiagnostics({ db })
    // Every listed container/network must be Audivra-owned (prefix filter at the source); vacuously true when none.
    for (const name of [...resources.ownedContainers, ...resources.ownedNetworks]) expect(name.startsWith('audivra')).toBe(true)
    expect(resources.storageBytes).toBeGreaterThanOrEqual(0)
    expect(resources.activeExecutions).toBeGreaterThanOrEqual(0)
  })
})

describe('Phase 6F — combined client report', () => {
  it('composes findings, attack paths, coverage and residual uncertainty from stored state, with no AI re-run', async () => {
    const eid = await engagementWithFinding('Report build')
    expect((await listFindingsForEngagement(db, eid)).length).toBeGreaterThanOrEqual(1)

    const bundle = await createSecurityReportService(db).build(eid)
    expect(bundle.meta.engagementId).toBe(eid)
    expect(bundle.meta.versions.audivra).toBe(AUDIVRA_VERSION)
    expect(bundle.executiveSummary.length).toBeGreaterThan(0)
    expect(bundle.methodology).toContain('no AI re-run')
    expect(bundle.findings.verifiedFindings.length + bundle.findings.supportedSignals.length).toBeGreaterThanOrEqual(1)
    expect(bundle.residual).toBeTruthy()

    const html = await generateSecurityReportExport(createSecurityReportService(db), eid, 'html')
    expect(html.contentType).toContain('text/html')
    expect(html.body).toContain('Report build')
    expect(html.body.toLowerCase()).toContain('residual')
    // Self-contained: no external scripts, which would both break offline viewing and risk exfiltration.
    expect(html.body).not.toContain('<script')
  })

  it('is deterministic — the same stored state exports identical content (§18)', async () => {
    const eid = await engagementWithFinding('Deterministic export')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    const a = await generateSecurityReportExport(createSecurityReportService(db), eid, 'json', { now })
    const b = await generateSecurityReportExport(createSecurityReportService(db), eid, 'json', { now })
    expect(a.filename).toBe(b.filename)
    // Content is deterministic from stored state; only per-report generation timestamps (metadata, not state) vary.
    const scrub = (s: string): unknown => JSON.parse(s, (k, v) => (k === 'generatedAt' || k === 'checkedAt' ? null : v))
    expect(scrub(a.body)).toEqual(scrub(b.body))
  })
})

describe('Phase 6F — resource-leak gate (§61)', () => {
  it('a completed deterministic run leaves no Audivra-owned processes registered', async () => {
    await engagementWithFinding('Leak gate')
    const { resources } = await collectDiagnostics({ db })
    expect(resources.ownedProcesses).toBe(0)
    expect(resources.unfinishedExecutions).toBe(0)
  })
})
