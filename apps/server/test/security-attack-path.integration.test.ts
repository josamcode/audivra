import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { AiTaskOutcome, AttackPathCoverage, AttackPathReport, SecurityAttackPath } from '@audivra/contracts'
import { createBoss, ensureQueues, type PgBoss } from '@audivra/database'
import {
  AttackPathService,
  ComparisonEngine,
  createDurableBroker,
  createRuntimeRegistry,
  DomainService,
  GraphProjector,
  keyringFromKeys,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  VerificationService,
  type ReasoningAi,
  type ReasoningAiResult,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 6B end to end on the real database + identity fixture: two broken object boundaries for one principal
 * become two verified-supported findings; attack-path analysis discovers the single-finding impact paths and
 * a same-principal correlation path, relating the dominated subpaths. A healthy engagement yields no paths.
 * An AI proposal that cites an invented finding is rejected; a provider failure leaves deterministic paths
 * intact. The pass is idempotent, and the read API / report / exports are built only from stored state.
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

function aiResult(outcome: AiTaskOutcome['outcome'], output: unknown): ReasoningAiResult {
  return { outcome, output, selection: { taskType: 'security-analyze-observations', providerId: 'fake', model: null, reason: 'test', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 1, refused: false, promptVersion: 'v1' }
}
/** A proposer that references an invented finding id — the service must reject it. */
function inventingAi(): ReasoningAi {
  return {
    async run(task) {
      if (task.prompt === 'security-attack-path-proposer') return aiResult('succeeded', { proposals: [{ title: 'invented chain', findingIds: ['fnd_ghostghostgho'], connectingEntityKeys: [], impactClass: 'privilege-boundary-crossed', rationale: 'an invented correlation' }] })
      if (task.prompt === 'security-attack-path-explainer') return aiResult('succeeded', { title: 'A route', explanation: 'A short route explanation.' })
      return aiResult('succeeded', {})
    },
  }
}
function failingAi(): ReasoningAi {
  return { async run() { return aiResult('provider-unavailable', null) } }
}

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: createLogger({ write: () => {} }), security: service })
  fixture = await startIdentityFixture('attack-path')
  projector = new GraphProjector({ db })
  const broker = createDurableBroker({ db, boss, resolver: loopback })
  engine = new ComparisonEngine({ db, broker, projector })
  establishment = new SessionEstablishmentService({ db, vault })
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
  const token = `ap-${ref}-${randomBytes(5).toString('hex')}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role: 'user' })
  await domain.declare(e, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, user)
  await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  const r = await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
  expect(r.established).toBe(true)
}
const arm = (role: string, identityRef: string | null, resourceRef: string, url: string, outcome: string) => ({ role, identityRef, resourceRef, url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })
async function brokenResource(e: string, id: string): Promise<void> {
  fixture.resources.set(id, { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  const url = `${fixture.url}/api/resources/${id}`
  await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, user)
  const result = await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: id, action: 'read', arms: [arm('subject', 'bob', id, url, 'deny'), arm('positive-control', 'alice', id, url, 'allow'), arm('negative-control', null, id, url, 'deny')] }, user)
  expect(result.result).toBe('inconsistent')
}
/** Two broken object boundaries for bob → two supported findings. */
async function twoFindings(e: string): Promise<void> {
  await identity(e, 'alice', 't1')
  await identity(e, 'bob', 't1')
  await brokenResource(e, 'doc1')
  await brokenResource(e, 'doc2')
  await new VerificationService({ db, registry, graphProjector: projector }).drive(e)
}

async function api<T = unknown>(method: 'GET' | 'POST', url: string): Promise<{ status: number; body: T; text: string }> {
  const response = await app.inject({ method, url })
  return { status: response.statusCode, body: (response.headers['content-type']?.includes('json') ? response.json() : null) as T, text: response.body }
}

describe('Phase 6B — evidence-backed attack paths', () => {
  it('discovers single-finding paths and a same-principal correlation path, relating the dominated subpaths', async () => {
    const e = await engagement('ap-chain')
    await twoFindings(e)
    const result = await new AttackPathService({ db }).drive(e)
    expect(result.findings).toBe(2)
    expect(result.pathsCreated).toBeGreaterThanOrEqual(3) // two single-finding + at least one chain

    const all = (await api<SecurityAttackPath[]>('GET', `/api/security/engagements/${e}/attack-paths?includeDominated=true`)).body
    expect(all.some((p) => p.findingIds.length === 2)).toBe(true)
    expect(all.some((p) => p.dominatedBy)).toBe(true)
    // The default list hides dominated subpaths.
    const primary = (await api<SecurityAttackPath[]>('GET', `/api/security/engagements/${e}/attack-paths`)).body
    expect(primary.every((p) => !p.dominatedBy)).toBe(true)
    expect(primary.length).toBeLessThan(all.length)

    const chain = all.find((p) => p.findingIds.length === 2)!
    expect(['supported', 'verified']).toContain(chain.state)
    const detail = (await api<{ path: SecurityAttackPath; findings: unknown[] }>('GET', `/api/security/attack-paths/${chain.id}`)).body
    expect(detail.findings.length).toBe(2)
    expect(detail.path.steps.length).toBeGreaterThanOrEqual(3)
  })

  it('a healthy engagement yields no attack paths', async () => {
    const e = await engagement('ap-healthy')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    fixture.resources.set('doc1', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'strict' })
    const url = `${fixture.url}/api/resources/doc1`
    await domain.declare(e, { kind: 'resource', ref: 'doc1', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, user)
    await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [arm('subject', 'bob', 'doc1', url, 'deny'), arm('positive-control', 'alice', 'doc1', url, 'allow'), arm('negative-control', null, 'doc1', url, 'deny')] }, user)
    await new VerificationService({ db, registry, graphProjector: projector }).drive(e)
    const result = await new AttackPathService({ db }).drive(e)
    expect(result.pathsCreated).toBe(0)
    expect((await api<SecurityAttackPath[]>('GET', `/api/security/engagements/${e}/attack-paths`)).body).toHaveLength(0)
  })

  it('rejects an AI proposal that cites an invented finding and survives a provider failure', async () => {
    const e = await engagement('ap-adversarial')
    await twoFindings(e)
    const invented = await new AttackPathService({ db, ai: inventingAi() }).drive(e)
    expect(invented.aiRejected).toBeGreaterThanOrEqual(1)
    // The invented proposal never became a path; deterministic paths are still present.
    const paths = (await api<SecurityAttackPath[]>('GET', `/api/security/engagements/${e}/attack-paths?includeDominated=true`)).body
    expect(paths.some((p) => p.findingIds.includes('fnd_ghostghostgho'))).toBe(false)
    expect(paths.length).toBeGreaterThanOrEqual(3)

    const resilient = await new AttackPathService({ db, ai: failingAi() }).drive(e)
    expect(resilient.deterministicCandidates).toBeGreaterThanOrEqual(3)
    expect(resilient.aiOutcome).toBe('provider-unavailable')
  })

  it('is idempotent and serves the report, coverage and exports from persisted state', async () => {
    const e = await engagement('ap-report')
    await twoFindings(e)
    const svc = new AttackPathService({ db })
    await svc.drive(e)
    const second = await svc.drive(e)
    expect(second.pathsCreated).toBe(0)

    const report = (await api<AttackPathReport>('GET', `/api/security/engagements/${e}/attack-paths/report`)).body
    expect(report.verifiedPaths.length + report.partiallyVerifiedPaths.length + report.coverage.total).toBeGreaterThanOrEqual(1)
    const coverage = (await api<AttackPathCoverage>('GET', `/api/security/engagements/${e}/attack-paths/coverage`)).body
    expect(coverage.total).toBeGreaterThanOrEqual(1)

    const json = await api('GET', `/api/security/engagements/${e}/attack-paths/export/json`)
    expect(json.status).toBe(200)
    expect(JSON.parse(json.text).schemaVersion).toBe('audivra.security-attack-paths.v1')
    const csv = await api('GET', `/api/security/engagements/${e}/attack-paths/export/csv`)
    expect(csv.status).toBe(200)
    expect(csv.text.split('\n')[0]).toContain('pathKey,title,state')
  })
})
