import { expect, test, type APIRequestContext } from '@playwright/test'
import type { RetestResult, SecurityAssessmentComparison, SecurityComparison, SecurityEngagementDetail, SecurityFinding, SessionEstablishmentResult } from '@audivra/contracts'
import { createDb, type DbHandle } from '@audivra/database'
import { DomainService, LOCAL_USER } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 6C end to end, deterministic: a broken object boundary in assessment A becomes a verified finding;
 * replaying it against assessment B — where the boundary is now enforced (the subject is denied, the owner is
 * still allowed) — produces a FIXED retest result, proven by the control. The assessment comparison then
 * classifies it fixed, and the Retesting view shows the result. A fix is only ever shown with evidence.
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
  fixture = await mod.startIdentityFixture({ port: 0, label: 'e2e-history' })
  handle = createDb(E2E_DATABASE_URL, 2)
  domain = new DomainService({ db: handle.db })
})
test.afterAll(async () => {
  await fixture.close()
  await handle.close()
})

async function declare(engagementId: string, body: { kind: 'identity' | 'resource' | 'invariant'; ref: string; spec: Record<string, unknown> }): Promise<void> {
  await domain.declare(engagementId, body, LOCAL_USER)
}
async function identity(request: APIRequestContext, engagementId: string, ref: string, tenant: string): Promise<void> {
  const token = `e2eh-${ref}-${Math.random().toString(36).slice(2, 10)}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role: 'user' })
  await declare(engagementId, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } })
  const cred = await request.post(`/api/security/engagements/${engagementId}/credentials`, { data: { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } } })
  expect(cred.status(), await cred.text()).toBe(201)
  const established = await request.post(`/api/security/engagements/${engagementId}/sessions/establish`, { data: { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } } })
  expect(((await established.json()) as SessionEstablishmentResult).established).toBe(true)
}
const arm = (role: string, identityRef: string | null, id: string, url: string, outcome: string) => ({ role, identityRef, resourceRef: id, url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })

async function declareResource(eid: string, id: string, enforce: 'strict' | 'leaky'): Promise<string> {
  fixture.resources.set(id, { tenant: 't1', owner: 'alice', state: 'draft', enforce })
  const url = `${fixture.url}/api/resources/${id}`
  await declare(eid, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } })
  return url
}

test('a broken boundary is retested FIXED against an enforced assessment and shown in the Retesting view', async ({ page, request }) => {
  test.setTimeout(5 * 60_000)

  // Assessment A: a leaky object boundary → inconsistent comparison → verified finding.
  const createdA = await request.post('/api/security/engagements', { data: { name: 'E2E history A', targetUrl: fixture.url, environment: 'staging' } })
  const a = ((await createdA.json()) as SecurityEngagementDetail).id
  await request.post(`/api/security/engagements/${a}/authorizations`, { data: { method: 'local-development' } })
  await identity(request, a, 'alice', 't1')
  await identity(request, a, 'bob', 't1')
  const url = await declareResource(a, 'hdoc1', 'leaky')
  const planned = await request.post(`/api/security/engagements/${a}/comparisons`, { data: { dimension: 'object-boundary', resourceRef: 'hdoc1', action: 'read', arms: [arm('subject', 'bob', 'hdoc1', url, 'deny'), arm('positive-control', 'alice', 'hdoc1', url, 'allow'), arm('negative-control', null, 'hdoc1', url, 'deny')] } })
  const comparisonId = ((await planned.json()) as SecurityComparison).id
  await expect.poll(async () => ((await (await request.get(`/api/security/comparisons/${comparisonId}`)).json()) as { comparison: SecurityComparison }).comparison.result, { timeout: 90_000 }).toBe('inconsistent')

  await request.post(`/api/security/engagements/${a}/verify`)
  const findings = await expect
    .poll(async () => ((await (await request.get(`/api/security/engagements/${a}/findings`)).json()) as SecurityFinding[]).length, { timeout: 90_000 })
    .toBeGreaterThanOrEqual(1)
  void findings
  const finding = ((await (await request.get(`/api/security/engagements/${a}/findings`)).json()) as SecurityFinding[])[0]!

  // Assessment B: the same boundary, now enforced (bob denied, owner alice still allowed).
  const createdB = await request.post('/api/security/engagements', { data: { name: 'E2E history B', targetUrl: fixture.url, environment: 'staging' } })
  const b = ((await createdB.json()) as SecurityEngagementDetail).id
  await request.post(`/api/security/engagements/${b}/authorizations`, { data: { method: 'local-development' } })
  await identity(request, b, 'alice', 't1')
  await identity(request, b, 'bob', 't1')
  await declareResource(b, 'hdoc1', 'strict')

  // Request the retest (enqueues a durable worker job) and wait for the FIXED result.
  const requested = await request.post(`/api/security/engagements/${b}/retests`, { data: { findingId: finding.id, allowAdaptation: false } })
  expect(requested.status(), await requested.text()).toBe(202)
  const state = await expect
    .poll(async () => ((await (await request.get(`/api/security/engagements/${b}/retests/results`)).json()) as RetestResult[])[0]?.state, { timeout: 120_000 })
    .toBe('fixed')
  void state
  const result = ((await (await request.get(`/api/security/engagements/${b}/retests/results`)).json()) as RetestResult[])[0]!
  expect(result.controlValid).toBe(true)

  // The assessment comparison classifies it fixed — and only because a retest proved it.
  const compared = await request.post(`/api/security/engagements/${b}/history/compare`, { data: { previousEngagementId: a } })
  const comparison = (await compared.json()) as SecurityAssessmentComparison
  expect(comparison.summary.fixed).toBeGreaterThanOrEqual(1)
  expect(comparison.findingChanges.filter((c) => c.class === 'fixed').every((c) => c.retestResultId)).toBe(true)

  // The Retesting view shows the fixed result.
  await page.goto(`/security/${b}?tab=retests`)
  await expect(page.getByText('Fixed', { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
