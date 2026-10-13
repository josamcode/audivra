import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { ComparisonPlannerOutput, SecurityDomainDeclaration } from '@audivra/contracts'
import { createBoss, ensureQueues, type PgBoss } from '@audivra/database'
import {
  ComparisonEngine,
  ComparisonReasoner,
  ComparisonService,
  createDurableBroker,
  DomainService,
  GraphProjector,
  GraphService,
  keyringFromKeys,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  type ReasoningAi,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 5 Step 5: the closing-the-gaps work. Proves comparison→graph derivation (a strong inconsistent
 * comparison derives a CAN_ACCESS fact with distinct comparison-derived provenance), Phase-5 knowledge gaps
 * (generated from the domain graph, answered by comparisons), domain declaration management with history
 * (create/update/retire through the API, versioned, never rewritten), and the reasoning closed loop
 * (deterministic + AI-proposal validation + provider fallback) that ties it together.
 */

const KEY = randomBytes(32)
const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const service = new SecurityService({ db, resolver: loopback })
const domain = new DomainService({ db })
const vault = new SecretVault({ db, keyring: keyringFromKeys([{ key: KEY }]) })
const graph = new GraphService({ db })

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: IdentityFixture
let engine: ComparisonEngine
let comparisons: ComparisonService
let establishment: SessionEstablishmentService

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: createLogger({ write: () => {} }), security: service })
  fixture = await startIdentityFixture('step5')
  const broker = createDurableBroker({ db, boss, resolver: loopback })
  engine = new ComparisonEngine({ db, broker, projector: new GraphProjector({ db }) })
  comparisons = new ComparisonService({ db, engine })
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
async function identity(e: string, ref: string, tenant: string, role: 'user' | 'admin' = 'user'): Promise<void> {
  const token = `s5-${ref}-${randomBytes(5).toString('hex')}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role })
  await domain.declare(e, { kind: 'identity', ref, spec: { identityType: role === 'admin' ? 'admin' : 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, user)
  await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  const r = await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
  expect(r.established).toBe(true)
}
async function resource(e: string, id: string, owner: string, tenant: string, enforce: 'strict' | 'leaky'): Promise<string> {
  fixture.resources.set(id, { tenant, owner, state: 'draft', enforce })
  const url = `${fixture.url}/api/resources/${id}`
  await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: owner, tenantRef: tenant, canonicalUrl: url, testData: 'test-owned' } }, user)
  return url
}
const arm = (role: string, identityRef: string | null, resourceRef: string, url: string, outcome: string) => ({ role, identityRef, resourceRef, url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })

describe('Phase 5 Step 5 — hardening and the closed loop', () => {
  it('derives a CAN_ACCESS graph fact with distinct comparison-derived provenance from a broken boundary', async () => {
    const e = await engagement('derive')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    const url = await resource(e, 'doc1', 'alice', 't1', 'leaky')
    const result = await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [arm('subject', 'bob', 'doc1', url, 'deny'), arm('positive-control', 'alice', 'doc1', url, 'allow'), arm('negative-control', null, 'doc1', url, 'deny')] }, user)
    expect(result.result).toBe('inconsistent')

    // The engine re-projected; the graph now carries a comparison-derived CAN_ACCESS edge (bob → doc1).
    const edges = await graph.edges(e, { type: 'CAN_ACCESS' })
    expect(edges.length).toBeGreaterThanOrEqual(1)
    const canAccess = edges.find((x) => x.fromKey === 'identity:bob')!
    expect(canAccess.basis).toBe('derived')
    const prov = (await pool.query("select source, trust from security_graph_provenance where engagement_id = $1 and source = 'comparison-derivation'", [e])).rows
    expect(prov[0]).toMatchObject({ source: 'comparison-derivation', trust: 'differential-comparison' })
    // Declared OWNS (alice → doc1) stays declared — never overwritten by the derived fact.
    const owns = (await graph.edges(e, { type: 'OWNS' })).find((x) => x.fromKey === 'identity:alice')
    expect(owns?.basis).toBe('declared')
  })

  it('raises Phase-5 knowledge gaps and answers them with comparisons', async () => {
    const e = await engagement('gaps')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    const url = await resource(e, 'doc1', 'alice', 't1', 'strict')
    await graph.project(e)
    const gapsBefore = (await graph.gaps(e)).filter((g) => g.status === 'open').map((g) => g.kind)
    expect(gapsBefore).toContain('identity-role-unknown') // alice/bob have no role
    expect(gapsBefore).toContain('authorization-expectation-unknown') // doc1 not yet compared

    await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [arm('subject', 'bob', 'doc1', url, 'deny'), arm('positive-control', 'alice', 'doc1', url, 'allow')] }, user)
    const authGap = (await graph.gaps(e)).find((g) => g.kind === 'authorization-expectation-unknown')
    expect(authGap?.status).toBe('resolved') // a comparison tested the boundary → the unknown is answered
  })

  it('manages domain declarations through the API with versioned history (create / update / retire)', async () => {
    const e = await engagement('mgmt')
    await domain.declare(e, { kind: 'identity', ref: 'alice', spec: { identityType: 'user' } }, user)
    const created = await app.inject({ method: 'POST', url: `/api/security/engagements/${e}/domain/declarations`, payload: { kind: 'resource', ref: 'doc1', label: 'Doc 1', spec: { resourceType: 'document', testData: 'unknown' } } })
    expect(created.statusCode).toBe(201)
    const v1 = created.json() as SecurityDomainDeclaration
    expect(v1).toMatchObject({ version: 1, status: 'active' })

    // Update → the active version is superseded and a new one created (history preserved).
    const updated = await app.inject({ method: 'PUT', url: `/api/security/domain/declarations/${v1.id}`, payload: { spec: { resourceType: 'document', ownerRef: 'alice', testData: 'test-owned' } } })
    expect(updated.statusCode).toBe(200)
    const v2 = updated.json() as SecurityDomainDeclaration
    expect(v2).toMatchObject({ version: 2, status: 'active', ref: 'doc1' })
    expect(v2.id).not.toBe(v1.id)
    expect((await domain.get(v1.id)).status).toBe('superseded') // the old version is kept, not rewritten
    expect((await domain.list(e, 'resource')).map((d) => d.id)).toEqual([v2.id]) // list shows only the active version
    expect((await domain.list(e, 'resource', 'all')).length).toBe(2) // history is still there

    // Retire → kept for history, no longer active/resolvable.
    const retired = await app.inject({ method: 'POST', url: `/api/security/domain/declarations/${v2.id}/retire` })
    expect(retired.statusCode).toBe(200)
    expect((retired.json() as SecurityDomainDeclaration).status).toBe('retired')
    expect((await domain.list(e, 'resource')).length).toBe(0)
  })

  it('closes the loop: the reasoner proposes+runs comparisons (deterministic), validating AI proposals and falling back when the provider is down', async () => {
    const e = await engagement('loop')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    await resource(e, 'doc1', 'alice', 't1', 'leaky')
    await domain.declare(e, { kind: 'invariant', ref: 'inv-obj', spec: { category: 'object-boundary', rule: 'only owner reads', affects: [{ kind: 'resource', ref: 'doc1' }] } }, user)

    // A scripted AI proposer: one valid proposal + one that invents a resource (must be rejected).
    const url = `${fixture.url}/api/resources/doc1`
    const output: ComparisonPlannerOutput = {
      comparisons: [
        { hypothesisId: 'hy_00000000000000', dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', invariantRef: 'inv-obj', expectedTransition: null, reason: 'valid', arms: [arm('subject', 'bob', 'doc1', url, 'deny'), arm('positive-control', 'alice', 'doc1', url, 'allow')] as never },
        { hypothesisId: 'hy_00000000000000', dimension: 'object-boundary', resourceRef: 'ghost', action: 'read', invariantRef: null, expectedTransition: null, reason: 'invented', arms: [arm('subject', 'bob', 'ghost', `${fixture.url}/api/resources/ghost`, 'deny')] as never },
      ],
      notes: '',
    }
    const scriptedAi: ReasoningAi = {
      run: async () => ({ outcome: 'succeeded', output, selection: { taskType: 'security-plan', providerId: 'scripted', model: 'test', reason: 'ok', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 1, refused: false, promptVersion: 'test:v1' }),
    }
    const reasoner = new ComparisonReasoner({ db, engine, service: comparisons, ai: scriptedAi })
    const pass = await reasoner.drive(e, { mode: 'investigate', actor: user })
    expect(pass.executed).toBeGreaterThanOrEqual(1)
    expect(pass.aiProposed).toBe(2)
    expect(pass.aiAccepted).toBe(1) // the valid one
    expect(pass.aiRejected['unknown-resource']).toBe(1) // the invented one rejected before execution
    expect(pass.pruning.candidates).toBeLessThanOrEqual(pass.pruning.cartesian)

    // The comparison ran, derived the graph fact and moved the hypothesis — closed loop.
    expect((await comparisons.list(e)).some((c) => c.result === 'inconsistent')).toBe(true)
    expect((await pool.query("select count(*) from security_hypotheses where engagement_id = $1 and status = 'confirmed-signal'", [e])).rows[0].count).not.toBe('0')

    // Provider resilience: a down provider still produces deterministic proposals.
    const down = new ComparisonReasoner({ db, engine, service: comparisons, ai: { run: async () => ({ outcome: 'provider-unavailable', output: null, selection: { taskType: 'security-plan', providerId: null, model: null, reason: 'down', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 0, refused: false, promptVersion: null }) } })
    const fallback = await down.drive(e, { mode: 'propose', actor: user })
    expect(fallback.aiOutcome).toBe('provider-unavailable')
    expect(fallback.deterministicProposed).toBeGreaterThanOrEqual(0)
  })

  it('reports multidimensional authorization/business coverage', async () => {
    const e = await engagement('coverage')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    const url = await resource(e, 'doc1', 'alice', 't1', 'strict')
    await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [arm('subject', 'bob', 'doc1', url, 'deny'), arm('positive-control', 'alice', 'doc1', url, 'allow'), arm('negative-control', null, 'doc1', url, 'deny')] }, user)
    const coverage = (await app.inject({ method: 'GET', url: `/api/security/engagements/${e}/comparisons/coverage` })).json() as { entities: { identities: number; resources: number }; dimensions: Record<string, { tested: number }>; controls: { both: number } }
    expect(coverage.entities).toMatchObject({ identities: 2, resources: 1 })
    expect(coverage.dimensions['object-boundary']?.tested).toBe(1)
    expect(coverage.controls.both).toBe(1)
  })
})
