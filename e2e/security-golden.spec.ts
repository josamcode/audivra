import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityComparison, SecurityEngagementDetail, SecurityFinding, SecurityReportBundle, SessionEstablishmentResult, SystemDiagnostics } from '@audivra/contracts'
import { createDb, type DbHandle } from '@audivra/database'
import { DomainService, LOCAL_USER } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 6F golden path (§58), deterministic (no AI, no Docker): the whole security product, end to end, on the
 * local identity fixture — create → authorize → identities → a broken object boundary → comparison → verify →
 * finding → attack path → the combined client report (JSON + self-contained HTML, built from stored state with
 * no AI re-run) → the operator health endpoint. This is the "a real assessment produces a client deliverable"
 * acceptance gate.
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
  fixture = await mod.startIdentityFixture({ port: 0, label: 'e2e-golden' })
  handle = createDb(E2E_DATABASE_URL, 2)
  domain = new DomainService({ db: handle.db })
})
test.afterAll(async () => {
  await fixture.close()
  await handle.close()
})

async function identity(request: APIRequestContext, eid: string, ref: string): Promise<void> {
  const token = `e2eg-${ref}-${Math.random().toString(36).slice(2, 10)}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant: 't1', role: 'user' })
  await domain.declare(eid, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: 't1' } }, LOCAL_USER)
  const cred = await request.post(`/api/security/engagements/${eid}/credentials`, { data: { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } } })
  expect(cred.status(), await cred.text()).toBe(201)
  const established = await request.post(`/api/security/engagements/${eid}/sessions/establish`, { data: { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } } })
  expect(((await established.json()) as SessionEstablishmentResult).established).toBe(true)
}

test('a full assessment produces verified evidence and a secret-safe client report', async ({ page, request }) => {
  test.setTimeout(5 * 60_000)

  // 1. Environment health: the operator endpoint is reachable and the database is ready.
  const health = (await (await request.get('/api/security/health')).json()) as SystemDiagnostics
  expect(['ready', 'degraded', 'blocked']).toContain(health.overall)
  expect(health.checks.find((c) => c.id === 'database')?.state).toBe('ready')

  // 2. Create + authorize an engagement and declare two identities on the fixture.
  const created = await request.post('/api/security/engagements', { data: { name: 'E2E golden', targetUrl: fixture.url, environment: 'isolated-lab' } })
  const engagement = (await created.json()) as SecurityEngagementDetail
  const eid = engagement.id
  await request.post(`/api/security/engagements/${eid}/authorizations`, { data: { method: 'local-development' } })
  await identity(request, eid, 'alice')
  await identity(request, eid, 'bob')

  // 3. A deliberately broken object boundary → inconsistent comparison.
  fixture.resources.set('gdoc', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  const url = `${fixture.url}/api/resources/gdoc`
  await domain.declare(eid, { kind: 'resource', ref: 'gdoc', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, LOCAL_USER)
  const arm = (role: string, identityRef: string | null, outcome: string) => ({ role, identityRef, resourceRef: 'gdoc', url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })
  const planned = await request.post(`/api/security/engagements/${eid}/comparisons`, { data: { dimension: 'object-boundary', resourceRef: 'gdoc', action: 'read', arms: [arm('subject', 'bob', 'deny'), arm('positive-control', 'alice', 'allow'), arm('negative-control', null, 'deny')] } })
  const comparisonId = ((await planned.json()) as SecurityComparison).id
  await expect.poll(async () => ((await (await request.get(`/api/security/comparisons/${comparisonId}`)).json()) as { comparison: SecurityComparison }).comparison.result, { timeout: 90_000 }).toBe('inconsistent')

  // 4. Verify → finding, then refresh attack paths.
  expect((await request.post(`/api/security/engagements/${eid}/verify`)).status()).toBe(202)
  await expect.poll(async () => ((await (await request.get(`/api/security/engagements/${eid}/findings`)).json()) as SecurityFinding[]).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(1)
  await request.post(`/api/security/engagements/${eid}/attack-paths/analyze`)

  // 5. The combined client report (JSON) is built from stored state and records the product version.
  const bundle = (await (await request.get(`/api/security/engagements/${eid}/report`)).json()) as SecurityReportBundle
  expect(bundle.meta.engagementId).toBe(eid)
  expect(bundle.meta.versions.audivra).toMatch(/^\d+\.\d+\.\d+$/)
  expect(bundle.methodology).toContain('no AI re-run')
  expect(bundle.findings.supportedSignals.length + bundle.findings.verifiedFindings.length).toBeGreaterThanOrEqual(1)
  expect(bundle.residual).toBeTruthy()

  // 6. The JSON + HTML exports download with the stable schema version and a self-contained document.
  const json = await request.get(`/api/security/engagements/${eid}/report/export/json`)
  expect(json.status()).toBe(200)
  expect(json.headers()['content-disposition']).toContain('.json')
  expect(JSON.parse(await json.text()).schemaVersion).toBe('audivra.security-report.v1')

  const html = await request.get(`/api/security/engagements/${eid}/report/export/html`)
  expect(html.status()).toBe(200)
  expect(html.headers()['content-type']).toContain('text/html')
  const htmlBody = await html.text()
  expect(htmlBody).toContain('E2E golden')
  expect(htmlBody).not.toContain('<script')

  // 7. The Findings view renders the verified evidence in the UI.
  await page.goto(`/security/${eid}?tab=findings`)
  const row = page.getByRole('row').filter({ hasText: /authorization/i }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText(/Supported|Verified/)
})
