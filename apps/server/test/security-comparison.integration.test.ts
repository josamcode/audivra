import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import { createBoss, ensureQueues, type PgBoss } from '@audivra/database'
import {
  ComparisonEngine,
  ComparisonService,
  createDurableBroker,
  DomainService,
  keyringFromKeys,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  validateProposedComparison,
  type PlannerInput,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 5 Step 4 end to end on the real database + the multi-tenant identity fixture: Audivra establishes
 * sessions for authorized test identities, plans a differential comparison, runs each arm as that identity,
 * and classifies the result from the controls and expected behaviour — object/tenant boundaries, business
 * state before/after, positive/negative controls, invariant support/contradiction, deterministic hypothesis
 * updates, A/B isolation, the secret canary, policy/environment constraints on state-changing actions, the
 * bounded planner and adversarial-proposal rejection.
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

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: IdentityFixture
let engine: ComparisonEngine
let comparisons: ComparisonService
let establishment: SessionEstablishmentService
const logs: string[] = []

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  const log = createLogger({ write: (chunk: string) => void logs.push(chunk) })
  app = await buildApp({ db, boss, hub: null, log, security: service })
  fixture = await startIdentityFixture('tenant')
  const broker = createDurableBroker({ db, boss, resolver: loopback })
  engine = new ComparisonEngine({ db, broker })
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

async function engagement(name: string, environment: 'staging' | 'isolated-lab' = 'isolated-lab'): Promise<string> {
  const created = await service.createEngagement({ name, targetUrl: fixture.url, environment }, user)
  await service.requestAuthorization(created.id, { method: 'local-development' }, user)
  return created.id
}

/** Declares an identity with a bearer credential the fixture recognizes, registers it, and establishes a session. */
async function identity(engagementId: string, ref: string, tenant: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const token = `CANARY-${ref}-${randomBytes(6).toString('hex')}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role })
  await domain.declare(engagementId, { kind: 'identity', ref, spec: { identityType: role === 'admin' ? 'admin' : 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, user)
  await vault.setCredential(engagementId, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  const result = await establishment.establish(engagementId, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
  expect(result.established, JSON.stringify(result.failure)).toBe(true)
  return token
}

async function resource(engagementId: string, id: string, opts: { tenant: string; owner: string; enforce: 'strict' | 'tenant' | 'leaky'; state?: string; testData?: string }): Promise<string> {
  fixture.resources.set(id, { tenant: opts.tenant, owner: opts.owner, state: opts.state ?? 'draft', enforce: opts.enforce })
  const url = `${fixture.url}/api/resources/${id}`
  await domain.declare(engagementId, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: opts.owner, tenantRef: opts.tenant, canonicalUrl: url, testData: opts.testData ?? 'test-owned' } }, user)
  return url
}

const armPlan = (role: 'subject' | 'positive-control' | 'negative-control', identityRef: string | null, resourceRef: string, url: string, outcome: 'allow' | 'deny', method: 'GET' | 'POST' = 'GET') => ({
  role,
  identityRef,
  resourceRef,
  url,
  method,
  expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', invariantRef: null, sourceRef: null, rationale: `${role} expected ${outcome}` },
})

describe('differential authorization comparisons', () => {
  it('detects a broken object boundary (IDOR) with controls, tags evidence, and contradicts the invariant', async () => {
    const e = await engagement('object-leaky', 'staging')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    await domain.declare(e, { kind: 'invariant', ref: 'inv-obj', spec: { category: 'object-boundary', rule: 'Only the owner may read a document', affects: [{ kind: 'resource', ref: 'doc1' }] } }, user)
    const url = await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'leaky' })

    const result = await engine.planAndRun(
      e,
      {
        dimension: 'object-boundary',
        resourceRef: 'doc1',
        action: 'read',
        invariantRef: 'inv-obj',
        arms: [armPlan('subject', 'bob', 'doc1', url, 'deny'), armPlan('positive-control', 'alice', 'doc1', url, 'allow'), armPlan('negative-control', null, 'doc1', url, 'deny')],
      },
      user,
    )

    expect(result.status).toBe('completed')
    expect(result.result).toBe('inconsistent')
    expect(result.controls).toEqual({ positive: true, negative: true })
    expect(result.resourceRelationship).toBe('different-owner')
    expect(result.invariantEvaluation).toBe('contradicted')
    // Semantic comparison went beyond status: bob and alice both got 200 (response-class), and the negative
    // control (anonymous) was denied — so bob's access is a real boundary break.
    const subject = result.arms.find((a) => a.role === 'subject')!
    expect(subject.observation?.responseClass).toBe('success')
    expect(result.arms.find((a) => a.role === 'negative-control')!.observation?.responseClass).toBe('auth-required')
    expect(result.evidenceRefs.length).toBeGreaterThanOrEqual(3)

    // The fixture saw bob's own token on the subject arm (A/B isolation: never alice's).
    const bobReads = fixture.requests.filter((r) => r.path === '/api/resources/doc1' && r.authenticatedAs === 'bob')
    expect(bobReads.length).toBeGreaterThan(0)

    // The linked hypothesis moved deterministically to a confirmed signal (adequate controls), and the
    // invariant.contradicted event was recorded.
    const hypo = await pool.query('select status, category from security_hypotheses where engagement_id = $1', [e])
    expect(hypo.rows[0]).toMatchObject({ status: 'confirmed-signal', category: 'object-boundary' })
    const events = (await service.listEvents(e)).map((ev) => ev.type)
    expect(events).toContain('invariant.contradicted')
    expect(events).toContain('comparison.completed')
  })

  it('confirms an enforced object boundary as consistent and disproves the weakness hypothesis', async () => {
    const e = await engagement('object-strict', 'staging')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    await domain.declare(e, { kind: 'invariant', ref: 'inv-obj', spec: { category: 'object-boundary', rule: 'Only the owner may read a document', affects: [{ kind: 'resource', ref: 'doc1' }] } }, user)
    const url = await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'strict' })

    const result = await engine.planAndRun(
      e,
      { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', invariantRef: 'inv-obj', arms: [armPlan('subject', 'bob', 'doc1', url, 'deny'), armPlan('positive-control', 'alice', 'doc1', url, 'allow'), armPlan('negative-control', null, 'doc1', url, 'deny')] },
      user,
    )
    expect(result.result).toBe('consistent')
    expect(result.invariantEvaluation).toBe('supported')
    expect(result.arms.find((a) => a.role === 'subject')!.observation?.responseClass).toBe('denied')
    const hypo = await pool.query('select status from security_hypotheses where engagement_id = $1', [e])
    expect(hypo.rows[0]?.status).toBe('disproved')
  })

  it('compares a tenant boundary across tenants (different-tenant relationship)', async () => {
    const e = await engagement('tenant', 'staging')
    await identity(e, 'alice', 't1')
    await identity(e, 'carol', 't2')
    const url = await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'tenant' })
    const result = await engine.planAndRun(
      e,
      { dimension: 'tenant-boundary', resourceRef: 'doc1', action: 'read', arms: [armPlan('subject', 'carol', 'doc1', url, 'deny'), armPlan('positive-control', 'alice', 'doc1', url, 'allow'), armPlan('negative-control', null, 'doc1', url, 'deny')] },
      user,
    )
    expect(result.result).toBe('consistent') // carol (t2) is denied a t1 resource
    expect(result.resourceRelationship).toBe('different-tenant')
    expect(fixture.requests.some((r) => r.path === '/api/resources/doc1' && r.authenticatedAs === 'carol')).toBe(true)
  })

  it('records a business-state transition before→after with cleanup (isolated lab)', async () => {
    const e = await engagement('state', 'isolated-lab')
    await identity(e, 'alice', 't1')
    const url = await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'strict', state: 'draft' })
    const result = await engine.planAndRun(
      e,
      {
        dimension: 'state-transition',
        resourceRef: 'doc1',
        action: 'approve',
        arms: [armPlan('subject', 'alice', 'doc1', `${url}/approve`, 'allow', 'POST')],
        stateProbeUrl: `${url}/state`,
        expectedTransition: 'draft→approved',
        cleanupRequired: true,
        cleanup: { identityRef: 'alice', url: `${url}/reset`, method: 'POST', body: null },
      },
      user,
    )
    expect(result.status).toBe('completed')
    expect(result.state?.before?.businessResult).toBe('draft')
    expect(result.state?.after?.businessResult).toBe('approved')
    expect(result.state?.transitionObserved).toBe(true)
    expect(result.cleanup).toMatchObject({ required: true, attempted: true, succeeded: true })
    // Cleanup reset the fixture resource to draft.
    expect(fixture.resources.get('doc1')?.state).toBe('draft')
  })

  it('keeps a state-changing comparison policy-constrained in staging (action blocked)', async () => {
    const e = await engagement('state-staging', 'staging')
    await identity(e, 'alice', 't1')
    const url = await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'strict', state: 'draft' })
    const result = await engine.planAndRun(
      e,
      { dimension: 'state-transition', resourceRef: 'doc1', action: 'approve', arms: [armPlan('subject', 'alice', 'doc1', `${url}/approve`, 'allow', 'POST')], stateProbeUrl: `${url}/state` },
      user,
    )
    // staging policy marks state-changing/reversible-write opt-in → the broker denies the action arm.
    const subject = result.arms.find((a) => a.role === 'subject')!
    expect(subject.status).toBe('blocked')
    expect(['blocked', 'inconclusive']).toContain(result.result)
    expect(fixture.resources.get('doc1')?.state).toBe('draft') // never mutated
  })

  it('CANARY: no session token leaks into evidence, events, graph, comparisons or logs', async () => {
    const start = logs.length
    const e = await engagement('canary', 'staging')
    const aliceToken = await identity(e, 'alice', 't1')
    const bobToken = await identity(e, 'bob', 't1')
    const url = await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'leaky' })
    const result = await engine.planAndRun(
      e,
      { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [armPlan('subject', 'bob', 'doc1', url, 'deny'), armPlan('positive-control', 'alice', 'doc1', url, 'allow')] },
      user,
    )
    const surfaces = [
      JSON.stringify(result),
      JSON.stringify(await comparisons.get(result.id)),
      JSON.stringify(await service.listEvents(e)),
      JSON.stringify(await service.listEvidence(e)),
      JSON.stringify(await service.listObservations(e)),
      JSON.stringify((await pool.query('select * from security_comparisons where engagement_id = $1', [e])).rows),
      logs.slice(start).join(''),
    ]
    for (const text of surfaces) {
      expect(text).not.toContain(aliceToken)
      expect(text).not.toContain(bobToken)
    }
    // Sanity: the fixture really did receive the tokens (so the canary is meaningful).
    expect(fixture.requests.some((r) => r.headers.authorization === `Bearer ${bobToken}`)).toBe(true)
  })

  it('proposes a bounded, deduplicated set of comparisons and rejects adversarial proposals', async () => {
    const e = await engagement('planner', 'staging')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'strict' })
    await resource(e, 'doc2', { tenant: 't1', owner: 'bob', enforce: 'strict' })

    const { plans: proposed, stats } = await comparisons.propose(e)
    expect(proposed.length).toBeGreaterThan(0)
    expect(proposed.length).toBeLessThanOrEqual(6)
    // Each proposal carries a control arm; the candidate space is pruned below the Cartesian product.
    for (const p of proposed) expect(p.plan.arms.some((a) => a.role === 'positive-control' || a.role === 'negative-control')).toBe(true)
    expect(stats.candidates).toBeLessThanOrEqual(stats.cartesian)

    // Running one then re-proposing excludes the now-existing comparison (dedupe).
    const first = proposed.find((p) => p.plan.dimension === 'object-boundary')!.plan
    await engine.planAndRun(e, first, user)
    const after = await comparisons.propose(e)
    expect(after.plans.some((p) => p.plan.dimension === first.dimension && p.plan.resourceRef === first.resourceRef && p.plan.action === first.action)).toBe(false)

    // Adversarial proposals are rejected deterministically.
    const plannerInput: PlannerInput = {
      environment: 'staging',
      identities: [{ ref: 'alice', key: 'identity:alice', tenantRef: 't1', roleRefs: [], hasSession: true }],
      resources: [{ ref: 'doc1', key: 'resource:document:doc1', ownerRef: 'alice', tenantRef: 't1', testData: 'test-owned', url: `${fixture.url}/api/resources/doc1` }],
      invariants: [],
      actions: [],
      roles: [],
      openGaps: [],
      existingDedupeKeys: new Set(),
    }
    expect(validateProposedComparison({ hypothesisId: 'hy_00000000000000', dimension: 'object-boundary', resourceRef: 'ghost', action: 'read', invariantRef: null, arms: [], expectedTransition: null, reason: 'invented resource' } as never, plannerInput)).toMatchObject({ ok: false, reason: 'unknown-resource' })
    expect(
      validateProposedComparison(
        { hypothesisId: 'hy_00000000000000', dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', invariantRef: null, expectedTransition: null, reason: 'invented identity', arms: [{ role: 'subject', identityRef: 'mallory', resourceRef: 'doc1', url: `${fixture.url}/api/resources/doc1`, method: 'GET', body: null, expected: { outcome: 'deny', basis: 'ai-inferred', invariantRef: null, sourceRef: null, rationale: 'x' } }] } as never,
        plannerInput,
      ),
    ).toMatchObject({ ok: false, reason: 'unknown-identity' })
  })

  it('refuses to establish/plan against an undeclared resource (references must exist)', async () => {
    const e = await engagement('refs', 'staging')
    await identity(e, 'alice', 't1')
    const planned = await engine.plan(e, { dimension: 'object-boundary', resourceRef: 'ghost', action: 'read', arms: [armPlan('subject', 'alice', 'ghost', `${fixture.url}/api/resources/ghost`, 'deny')] }, user)
    expect(planned.status).toBe('blocked')
    expect(planned.result).toBe('blocked')
    expect(planned.resultReason).toMatch(/not declared/)
  })

  it('is idempotent: re-running a completed comparison does not re-execute its arms', async () => {
    const e = await engagement('idempotent', 'staging')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    const url = await resource(e, 'doc1', { tenant: 't1', owner: 'alice', enforce: 'strict' })
    const result = await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [armPlan('subject', 'bob', 'doc1', url, 'deny'), armPlan('positive-control', 'alice', 'doc1', url, 'allow')] }, user)
    const reads = fixture.requests.filter((r) => r.path === '/api/resources/doc1').length
    const again = await engine.run(result.id, user)
    expect(again.result).toBe(result.result)
    expect(fixture.requests.filter((r) => r.path === '/api/resources/doc1').length).toBe(reads) // no re-execution
  })
})
