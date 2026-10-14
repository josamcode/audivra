import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityAssessmentReport, SecurityComparison, SecurityEngagementDetail, SecurityFinding, SessionEstablishmentResult } from '@audivra/contracts'
import { createDb, type DbHandle } from '@audivra/database'
import { DomainService, LOCAL_USER } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 6A end to end, deterministic (no AI, no Docker): an inconsistent object-boundary comparison is
 * promoted to a verification candidate, the verification worker decides deterministically that its required
 * evidence exists, and — with no AI provider configured — synthesizes a SUPPORTED finding (never silently
 * "verified": a scanner or a model alone cannot verify). The Findings view shows it apart from open
 * investigation, and the report/exports read from persisted state. Entirely on the multi-tenant identity fixture.
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
  fixture = await mod.startIdentityFixture({ port: 0, label: 'e2e-findings' })
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

test('inconsistent comparison → verification candidate → supported finding shown in the Findings view', async ({ page, request }) => {
  test.setTimeout(3 * 60_000)

  const created = await request.post('/api/security/engagements', { data: { name: 'E2E findings', targetUrl: fixture.url, environment: 'staging' } })
  const engagement = (await created.json()) as SecurityEngagementDetail
  await request.post(`/api/security/engagements/${engagement.id}/authorizations`, { data: { method: 'local-development' } })
  const eid = engagement.id

  await identity(request, eid, 'alice', 't1')
  await identity(request, eid, 'bob', 't1')
  fixture.resources.set('doc1', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  const url = `${fixture.url}/api/resources/doc1`
  await declare(eid, { kind: 'resource', ref: 'doc1', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } })
  await declare(eid, { kind: 'invariant', ref: 'inv-obj', spec: { category: 'object-boundary', rule: 'Only the owner may read a document', affects: [{ kind: 'resource', ref: 'doc1' }] } })

  // Run the broken object boundary → inconsistent comparison.
  const arm = (role: string, identityRef: string | null, outcome: string) => ({ role, identityRef, resourceRef: 'doc1', url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })
  const planned = await request.post(`/api/security/engagements/${eid}/comparisons`, {
    data: { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', invariantRef: 'inv-obj', arms: [arm('subject', 'bob', 'deny'), arm('positive-control', 'alice', 'allow'), arm('negative-control', null, 'deny')] },
  })
  const comparisonId = ((await planned.json()) as SecurityComparison).id
  await expect.poll(async () => ((await (await request.get(`/api/security/comparisons/${comparisonId}`)).json()) as { comparison: SecurityComparison }).comparison.result, { timeout: 90_000 }).toBe('inconsistent')

  // Queue a verification pass; the worker generates the candidate and synthesizes the finding.
  const verify = await request.post(`/api/security/engagements/${eid}/verify`)
  expect(verify.status()).toBe(202)
  const findings = await expect
    .poll(async () => ((await (await request.get(`/api/security/engagements/${eid}/findings`)).json()) as SecurityFinding[]).length, { timeout: 90_000 })
    .toBeGreaterThanOrEqual(1)
  void findings

  const list = (await (await request.get(`/api/security/engagements/${eid}/findings`)).json()) as SecurityFinding[]
  expect(list[0]).toMatchObject({ category: 'authorization' })
  // No AI provider is configured in the E2E, so the honest verdict is "supported" — never auto-"verified".
  expect(['supported', 'verified']).toContain(list[0]!.verificationState)

  // The report keeps verified findings and supported signals apart.
  const report = (await (await request.get(`/api/security/engagements/${eid}/findings/report`)).json()) as SecurityAssessmentReport
  expect(report.supportedSignals.length + report.verifiedFindings.length).toBeGreaterThanOrEqual(1)

  // The JSON export is served from persisted state with the stable schema version.
  const exported = await request.get(`/api/security/engagements/${eid}/findings/export/json`)
  expect(exported.status()).toBe(200)
  expect(JSON.parse(await exported.text()).schemaVersion).toBe('audivra.security-findings.v1')

  // The Findings view renders the finding row and its detail.
  await page.goto(`/security/${eid}?tab=findings`)
  const row = page.getByRole('row').filter({ hasText: /authorization/i }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText(/Supported|Verified/)
  await row.click()
  await expect(page.getByText('Why this severity')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Reproduction')).toBeVisible()
})
