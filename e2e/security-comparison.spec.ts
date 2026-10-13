import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityComparison, SecurityEngagementDetail, SessionEstablishmentResult } from '@audivra/contracts'
import { createDb, type DbHandle } from '@audivra/database'
import { DomainService, LOCAL_USER } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 5 Step 4 end to end, deterministic (no AI, no Docker): two authorized test identities establish
 * sessions, resources are declared, a differential object-boundary comparison runs through the worker (one
 * identity-aware execution per arm, decided by the Capability Broker), the leaky resource is detected as an
 * inconsistent boundary with its controls, and the Access view shows the expected-vs-observed result with the
 * invariant contradicted. Entirely on the controlled multi-tenant identity fixture.
 */

interface IdentityFixtureLike {
  url: string
  tokens: Map<string, string>
  principals: Map<string, { tenant: string; role: 'user' | 'admin' }>
  resources: Map<string, { tenant: string; owner: string; state: string; enforce: 'strict' | 'tenant' | 'leaky' }>
  close(): Promise<void>
}

let fixture: IdentityFixtureLike
let handle: DbHandle
let domain: DomainService

test.beforeAll(async () => {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../fixtures/identity/server.mjs')) as { startIdentityFixture(opts: { port: number; label: string }): Promise<IdentityFixtureLike> }
  fixture = await mod.startIdentityFixture({ port: 0, label: 'e2e-comparison' })
  handle = createDb(E2E_DATABASE_URL, 2)
  domain = new DomainService({ db: handle.db })
})
test.afterAll(async () => {
  await fixture.close()
  await handle.close()
})

// Declarations are configuration a person/Audivra creates (no public create API in Step 1); seed them directly
// against the shared E2E database, exactly as the integration tests and platform code do.
async function declare(engagementId: string, body: { kind: 'identity' | 'resource' | 'invariant'; ref: string; spec: Record<string, unknown> }): Promise<void> {
  await domain.declare(engagementId, body, LOCAL_USER)
}

async function identity(request: APIRequestContext, engagementId: string, ref: string, tenant: string): Promise<void> {
  const token = `e2e-${ref}-${Math.random().toString(36).slice(2, 10)}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role: 'user' })
  await declare(engagementId, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } })
  const cred = await request.post(`/api/security/engagements/${engagementId}/credentials`, { data: { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } } })
  expect(cred.status(), await cred.text()).toBe(201)
  const established = await request.post(`/api/security/engagements/${engagementId}/sessions/establish`, { data: { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } } })
  expect(established.status(), await established.text()).toBe(201)
  expect(((await established.json()) as SessionEstablishmentResult).established).toBe(true)
}

test('two identities → sessions → a differential comparison → inconsistent boundary shown in the Access view', async ({ page, request }) => {
  test.setTimeout(3 * 60_000)

  // Engagement on the identity fixture, authorized (loopback).
  const created = await request.post('/api/security/engagements', { data: { name: 'E2E comparison', targetUrl: fixture.url, environment: 'staging' } })
  expect(created.status()).toBe(201)
  const engagement = (await created.json()) as SecurityEngagementDetail
  const authorized = await request.post(`/api/security/engagements/${engagement.id}/authorizations`, { data: { method: 'local-development' } })
  expect(((await authorized.json()) as { engagement: SecurityEngagementDetail }).engagement.readiness.ready).toBe(true)

  // Two identities (owner + a non-owner), a leaky resource (broken object boundary) and the invariant.
  await identity(request, engagement.id, 'alice', 't1')
  await identity(request, engagement.id, 'bob', 't1')
  fixture.resources.set('doc1', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  const url = `${fixture.url}/api/resources/doc1`
  await declare(engagement.id, { kind: 'resource', ref: 'doc1', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } })
  await declare(engagement.id, { kind: 'invariant', ref: 'inv-obj', spec: { category: 'object-boundary', rule: 'Only the owner may read a document', affects: [{ kind: 'resource', ref: 'doc1' }] } })

  // Plan + queue the comparison; the worker runs its arms through the broker.
  const arm = (role: string, identityRef: string | null, outcome: string) => ({ role, identityRef, resourceRef: 'doc1', url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })
  const planned = await request.post(`/api/security/engagements/${engagement.id}/comparisons`, {
    data: { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', invariantRef: 'inv-obj', arms: [arm('subject', 'bob', 'deny'), arm('positive-control', 'alice', 'allow'), arm('negative-control', null, 'deny')] },
  })
  expect(planned.status(), await planned.text()).toBe(201)
  const comparisonId = ((await planned.json()) as SecurityComparison).id

  // The worker completes it with an inconsistent result (bob read alice's document; the positive control confirms it is controlled).
  await expect
    .poll(async () => ((await (await request.get(`/api/security/comparisons/${comparisonId}`)).json()) as { comparison: SecurityComparison }).comparison.result, { timeout: 90_000 })
    .toBe('inconsistent')

  // The Access view shows the comparison and its result; the detail shows the contradicted invariant.
  await page.goto(`/security/${engagement.id}?tab=access`)
  const row = page.getByTestId('access-comparison').filter({ hasText: 'object-boundary' }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText('Inconsistent')
  await expect(row).toContainText('bob read doc1')
  await row.click()
  // The detail sheet shows the arms (expected vs observed) and the security-relevant semantic difference.
  await expect(page.getByText('Arms: expected vs observed')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Semantic differences')).toBeVisible()
  await expect(page.getByText(/invariant contradicted/i).first()).toBeVisible()

  // The audit trail and coverage record it honestly.
  const comparisons = (await (await request.get(`/api/security/engagements/${engagement.id}/comparisons`)).json()) as SecurityComparison[]
  expect(comparisons[0]?.invariantEvaluation).toBe('contradicted')
  const coverage = (await (await request.get(`/api/security/engagements/${engagement.id}/comparisons/coverage`)).json()) as { invariants: { contradicted: number } }
  expect(coverage.invariants.contradicted).toBe(1)
})
