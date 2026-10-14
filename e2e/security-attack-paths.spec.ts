import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityAttackPath, SecurityComparison, SecurityEngagementDetail, SecurityFinding, SessionEstablishmentResult } from '@audivra/contracts'
import { createDb, type DbHandle } from '@audivra/database'
import { DomainService, LOCAL_USER } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 6B end to end, deterministic: two broken object boundaries for one principal become two verified
 * findings; the verification pass enqueues attack-path analysis, which discovers a same-principal correlation
 * path plus the single-finding impact paths. The Attack Paths view shows the route with every step's
 * verification state, its evidence and the correlated findings — and a false, unconnected correlation would
 * never appear as verified. Entirely on the multi-tenant identity fixture.
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
  fixture = await mod.startIdentityFixture({ port: 0, label: 'e2e-attack-paths' })
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
  const token = `e2e-${ref}-${Math.random().toString(36).slice(2, 10)}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role: 'user' })
  await declare(engagementId, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } })
  const cred = await request.post(`/api/security/engagements/${engagementId}/credentials`, { data: { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } } })
  expect(cred.status(), await cred.text()).toBe(201)
  const established = await request.post(`/api/security/engagements/${engagementId}/sessions/establish`, { data: { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } } })
  expect(((await established.json()) as SessionEstablishmentResult).established).toBe(true)
}
const arm = (role: string, identityRef: string | null, id: string, url: string, outcome: string) => ({ role, identityRef, resourceRef: id, url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })

async function brokenBoundary(request: APIRequestContext, eid: string, id: string): Promise<void> {
  fixture.resources.set(id, { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  const url = `${fixture.url}/api/resources/${id}`
  await declare(eid, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } })
  const planned = await request.post(`/api/security/engagements/${eid}/comparisons`, { data: { dimension: 'object-boundary', resourceRef: id, action: 'read', arms: [arm('subject', 'bob', id, url, 'deny'), arm('positive-control', 'alice', id, url, 'allow'), arm('negative-control', null, id, url, 'deny')] } })
  const comparisonId = ((await planned.json()) as SecurityComparison).id
  await expect.poll(async () => ((await (await request.get(`/api/security/comparisons/${comparisonId}`)).json()) as { comparison: SecurityComparison }).comparison.result, { timeout: 90_000 }).toBe('inconsistent')
}

test('two findings → verification → attack-path analysis → a correlation path shown in the Attack Paths view', async ({ page, request }) => {
  test.setTimeout(4 * 60_000)

  const created = await request.post('/api/security/engagements', { data: { name: 'E2E attack paths', targetUrl: fixture.url, environment: 'staging' } })
  const engagement = (await created.json()) as SecurityEngagementDetail
  await request.post(`/api/security/engagements/${engagement.id}/authorizations`, { data: { method: 'local-development' } })
  const eid = engagement.id

  await identity(request, eid, 'alice', 't1')
  await identity(request, eid, 'bob', 't1')
  await brokenBoundary(request, eid, 'doc1')
  await brokenBoundary(request, eid, 'doc2')

  // Verify → two findings. The pass auto-enqueues attack-path analysis; also trigger it explicitly.
  await request.post(`/api/security/engagements/${eid}/verify`)
  await expect.poll(async () => ((await (await request.get(`/api/security/engagements/${eid}/findings`)).json()) as SecurityFinding[]).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2)
  await request.post(`/api/security/engagements/${eid}/attack-paths/analyze`)

  const paths = await expect
    .poll(async () => ((await (await request.get(`/api/security/engagements/${eid}/attack-paths?includeDominated=true`)).json()) as SecurityAttackPath[]).length, { timeout: 90_000 })
    .toBeGreaterThanOrEqual(3)
  void paths

  const all = (await (await request.get(`/api/security/engagements/${eid}/attack-paths?includeDominated=true`)).json()) as SecurityAttackPath[]
  const chain = all.find((p) => p.findingIds.length >= 2)!
  expect(chain).toBeTruthy()
  expect(['verified', 'partially-verified', 'supported']).toContain(chain.state)
  // No path is a verified compromise unless every step is verified.
  expect(all.every((p) => p.state !== 'verified' || p.steps.every((s) => s.edgeVerification === 'verified'))).toBe(true)

  // The JSON export reads from persisted state.
  const exported = await request.get(`/api/security/engagements/${eid}/attack-paths/export/json`)
  expect(exported.status()).toBe(200)
  expect(JSON.parse(await exported.text()).schemaVersion).toBe('audivra.security-attack-paths.v1')

  // The Attack Paths view renders the path and its verification-coded steps.
  await page.goto(`/security/${eid}?tab=attack-paths`)
  const row = page.getByRole('row').filter({ hasText: /→/ }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  await expect(page.getByText('Start:', { exact: false })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/Findings correlated/i)).toBeVisible()
})
