import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { PolicyDecision, SpecialistVulnerability } from '@audivra/contracts'
import { createBoss, ensureQueues, listFindingsForEngagement, listSecurityObservations, recordSecurityObservation, updateSpecialistRun, getSpecialistRunRow, type PgBoss } from '@audivra/database'
import {
  createDurableBroker,
  createRuntimeRegistry,
  DomainService,
  FakeSpecialistEngine,
  fakeVuln,
  GraphProjector,
  observationDedupeKey,
  SecurityService,
  SpecialistReadService,
  SpecialistRunService,
  VerificationService,
  type Resolver,
  type SpecialistEngine,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 6D end to end on the real database + identity fixture, with the DETERMINISTIC fake specialist engine
 * (no Docker, no provider). It proves the integration boundary: Audivra authorizes the run; a specialist
 * result becomes an observation, never a verified finding; a lone Strix signal yields no finding (§49); a
 * corroborated one reaches a finding only through the 6A verification boundary (§26/§30); out-of-scope results
 * are dropped (§13); provider-unavailable is honest (§43); and cancellation + crash recovery are clean
 * (§51/§52).
 */

const KEY = randomBytes(32)
const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const service = new SecurityService({ db, resolver: loopback })
const domain = new DomainService({ db })
const registry = createRuntimeRegistry()

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: IdentityFixture
let projector: GraphProjector

// A broker stub that authorizes (used for lifecycle scenarios); authority itself is proven with the real broker.
const allowBroker = { async preflight(): Promise<PolicyDecision> { return { decision: 'allow', reason: 'test-allow' } as unknown as PolicyDecision } }

function specialist(engine: SpecialistEngine, broker: { preflight(req: unknown): Promise<PolicyDecision> } = allowBroker) {
  return new SpecialistRunService({ db, broker, engines: { strix: engine }, graphProjector: projector, log: createLogger({ write: () => {} }) })
}
async function verify(engagementId: string) {
  await new VerificationService({ db, registry, graphProjector: projector }).drive(engagementId)
}

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  process.env.STRIX_ENABLED = 'true'
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: createLogger({ write: () => {} }), security: service })
  fixture = await startIdentityFixture('specialist')
  projector = new GraphProjector({ db })
})
afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await fixture.close()
  await handle.close()
  delete process.env.AUDIVRA_SECRET_KEY
  delete process.env.STRIX_ENABLED
  resetConfig()
})
beforeEach(async () => {
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
  await boss.deleteAllJobs()
  for (const m of [fixture.tokens, fixture.sessions, fixture.principals, fixture.resources, fixture.users]) m.clear()
})

async function engagement(name: string): Promise<string> {
  const created = await service.createEngagement({ name, targetUrl: fixture.url, environment: 'isolated-lab' }, user)
  await service.requestAuthorization(created.id, { method: 'local-development' }, user)
  return created.id
}
async function declareResource(eid: string, id: string): Promise<string> {
  const url = `${fixture.url}/api/resources/${id}`
  await domain.declare(eid, { kind: 'resource', ref: id, spec: { resourceType: 'document', canonicalUrl: url, testData: 'test-owned' } }, user)
  return url
}
const webVuln = (url: string): SpecialistVulnerability => fakeVuln({ nativeId: 's1', title: 'Reflected XSS', nativeCategory: 'A03:Injection', affected: { url, sourcePath: null, apiOperation: null, assetHint: null } })

describe('Phase 6D — specialist (Strix) integration', () => {
  it('Audivra authority gates the run: a high-impact specialist run is denied without a policy opt-in', async () => {
    const eid = await engagement('spec-authority')
    await declareResource(eid, 'doc1')
    const svc = specialist(new FakeSpecialistEngine({ vulnerabilities: [] }), createDurableBroker({ db, boss, resolver: loopback }))
    const requested = await svc.request(eid, { engine: 'strix', mode: 'source-only', findingIds: [], resourceRefs: ['doc1'], stagedSourceRef: null, focus: 'broad' })
    const run = await svc.drive(requested.id)
    expect(run.state).toBe('unavailable') // policy/authorization gates it; the engine never ran
    expect(run.stateReason.toLowerCase()).toContain('author')
  })

  it('a lone specialist signal becomes an observation but NEVER a verified finding (§49)', async () => {
    const eid = await engagement('spec-lone')
    const url = await declareResource(eid, 'doc1')
    const run = await specialist(new FakeSpecialistEngine({ vulnerabilities: [webVuln(url)] })).request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
    const driven = await specialist(new FakeSpecialistEngine({ vulnerabilities: [webVuln(url)] })).drive(run.id)
    expect(driven.state).toBe('completed')
    expect(driven.imported.observations).toBe(1)
    const obs = await listSecurityObservations(db, eid, {})
    const strixObs = obs.find((o) => o.contributions.some((c) => c.tool === 'strix'))!
    expect(strixObs.sourceType).toBe('tool-heuristic') // a suspicion to verify, never a verdict
    expect(strixObs.confidence).toBe(0.5)
    expect((strixObs.value as { nativeSeverity?: string }).nativeSeverity).toBe('high') // native severity stays metadata
    await verify(eid)
    expect(await listFindingsForEngagement(db, eid)).toHaveLength(0) // a lone Strix signal is never a finding
  }, 60_000)

  it('a corroborated specialist signal reaches a finding only through 6A verification (§26/§30)', async () => {
    const eid = await engagement('spec-corrob')
    const url = await declareResource(eid, 'doc1')
    const vuln = webVuln(url)
    const subject = `${vuln.nativeCategory}:${vuln.title}`.slice(0, 200)
    // An existing deterministic sensor already observed the same signal; Strix corroborates it (two tools).
    await recordSecurityObservation(db, {
      engagementId: eid,
      dedupeKey: observationDedupeKey('web-signal', url, subject),
      type: 'web-signal',
      asset: url,
      subject,
      title: vuln.title,
      scopeClass: 'in-scope',
      value: { tool: 'nuclei', templateId: 'reflected-xss' },
      sourceType: 'tool-heuristic',
      contribution: { executionId: 'sx_seeded00000001', capabilityId: 'web.nuclei', tool: 'nuclei', toolVersion: 'fixture', evidenceRef: 'EV-seed', confidence: 0.5, identityRef: null, sessionRef: null, at: new Date().toISOString() },
    })
    const run = await specialist(new FakeSpecialistEngine({ vulnerabilities: [vuln] })).request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
    const driven = await specialist(new FakeSpecialistEngine({ vulnerabilities: [vuln] })).drive(run.id)
    expect(driven.imported.merged).toBe(1) // corroborated an existing observation (≥2 tools)
    await verify(eid)
    const findings = await listFindingsForEngagement(db, eid)
    expect(findings.length).toBeGreaterThanOrEqual(1) // reached a finding via the existing 6A boundary
    const signals = (await new SpecialistReadService({ db }).getRun(driven.id)).signals
    expect(signals.some((s) => s.finding)).toBe(true) // the specialist signal links to the corroborated finding
  }, 60_000)

  it('drops an out-of-scope specialist result (§13)', async () => {
    const eid = await engagement('spec-oos')
    await declareResource(eid, 'doc1')
    const driven = await specialist(new FakeSpecialistEngine({ vulnerabilities: [webVuln('http://192.0.2.10/evil')] })).drive(
      (await specialist(new FakeSpecialistEngine()).request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })).id,
    )
    expect(driven.imported.outOfScope).toBe(1)
    expect(driven.imported.observations).toBe(0)
  }, 60_000)

  it('represents a provider-unavailable run honestly — never "clean" (§43)', async () => {
    const eid = await engagement('spec-unavail')
    await declareResource(eid, 'doc1')
    const run = await specialist(new FakeSpecialistEngine({ providerUnavailable: true })).request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
    const driven = await specialist(new FakeSpecialistEngine({ providerUnavailable: true })).drive(run.id)
    expect(driven.state).toBe('unavailable')
    expect(driven.imported.observations).toBe(0)
    await verify(eid)
    expect(await listFindingsForEngagement(db, eid)).toHaveLength(0)
  }, 60_000)

  it('cancels one run without affecting another (§51)', async () => {
    const eid = await engagement('spec-cancel')
    await declareResource(eid, 'doc1')
    const svc = specialist(new FakeSpecialistEngine({ delayMs: 1500, vulnerabilities: [] }))
    const a = await svc.request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
    const b = await svc.request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
    const pa = svc.drive(a.id)
    await new Promise((r) => setTimeout(r, 200))
    const cancelled = await svc.cancel(a.id)
    expect(cancelled.state).toBe('cancelled')
    await pa.catch(() => undefined)
    const fast = specialist(new FakeSpecialistEngine({ delayMs: 0, vulnerabilities: [] }))
    const bDriven = await fast.drive(b.id)
    expect(bDriven.state).toBe('completed') // B is unaffected by A's cancellation
  }, 60_000)

  it('reconciles an interrupted run idempotently on recovery (§52)', async () => {
    const eid = await engagement('spec-recover')
    await declareResource(eid, 'doc1')
    const svc = specialist(new FakeSpecialistEngine())
    const run = await svc.request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
    await updateSpecialistRun(db, run.id, { state: 'running', stateReason: 'left mid-flight' }) // simulate a crash mid-run
    const first = await svc.recover()
    expect(first.reconciled).toBe(1)
    expect((await getSpecialistRunRow(db, run.id))!.state).toBe('failed') // interrupted, not re-run
    const second = await svc.recover()
    expect(second.reconciled).toBe(0) // idempotent — a terminal run is left alone
  }, 60_000)
})
