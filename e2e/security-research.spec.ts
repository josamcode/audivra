import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityFinding, SecurityResearchRun, SecurityEngagementDetail, SessionEstablishmentResult } from '@audivra/contracts'
import { createDb, type DbHandle } from '@audivra/database'
import { DomainService, LOCAL_USER } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 6E end to end, deterministic (scripted reasoning provider): an autonomous research run on a broken
 * authorization boundary selects a cheap comparison, verifies the signal into a finding, refreshes attack
 * paths and stops — all orchestrating the existing services, with the decision timeline visible in the UI.
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
  fixture = await mod.startIdentityFixture({ port: 0, label: 'e2e-research' })
  handle = createDb(E2E_DATABASE_URL, 2)
  domain = new DomainService({ db: handle.db })
})
test.afterAll(async () => {
  await fixture.close()
  await handle.close()
})

async function identity(request: APIRequestContext, eid: string, ref: string): Promise<void> {
  const token = `e2er-${ref}-${Math.random().toString(36).slice(2, 10)}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant: 't1', role: 'user' })
  await domain.declare(eid, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: 't1' } }, LOCAL_USER)
  const cred = await request.post(`/api/security/engagements/${eid}/credentials`, { data: { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } } })
  expect(cred.status(), await cred.text()).toBe(201)
  const established = await request.post(`/api/security/engagements/${eid}/sessions/establish`, { data: { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } } })
  expect(((await established.json()) as SessionEstablishmentResult).established).toBe(true)
}

test('an autonomous research run finds and verifies an authorization issue, then stops', async ({ page, request }) => {
  test.setTimeout(5 * 60_000)

  const created = await request.post('/api/security/engagements', { data: { name: 'E2E research', targetUrl: fixture.url, environment: 'isolated-lab' } })
  const engagement = (await created.json()) as SecurityEngagementDetail
  const eid = engagement.id
  await request.post(`/api/security/engagements/${eid}/authorizations`, { data: { method: 'local-development' } })
  await identity(request, eid, 'alice')
  await identity(request, eid, 'bob')
  fixture.resources.set('rdoc', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  await domain.declare(eid, { kind: 'resource', ref: 'rdoc', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: `${fixture.url}/api/resources/rdoc`, testData: 'test-owned' } }, LOCAL_USER)

  // Create + start an autonomous research run (investigate mode, authorization objective).
  const createdRun = await request.post(`/api/security/engagements/${eid}/research/runs`, { data: { mode: 'investigate', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} } })
  const run = (await createdRun.json()) as SecurityResearchRun
  const start = await request.post(`/api/security/research/runs/${run.id}/start`)
  expect(start.status(), await start.text()).toBe(202)

  // The durable worker drives the loop to a stop; it should surface a finding without a special runtime.
  const state = await expect
    .poll(async () => ((await (await request.get(`/api/security/research/runs/${run.id}`)).json()) as { run: SecurityResearchRun }).run.state, { timeout: 150_000 })
    .toBe('stopped')
  void state
  const detail = (await (await request.get(`/api/security/research/runs/${run.id}`)).json()) as { run: SecurityResearchRun; actions: unknown[]; timeline: unknown[] }
  expect(detail.run.terminationReason).toBeTruthy()
  expect(detail.timeline.length).toBeGreaterThan(0)

  await expect.poll(async () => ((await (await request.get(`/api/security/engagements/${eid}/findings`)).json()) as SecurityFinding[]).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1)

  // The Research view shows the run, its decision timeline and residual uncertainty.
  await page.goto(`/security/${eid}?tab=research`)
  const row = page.getByRole('row').filter({ hasText: /investigate-authorization/ }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  await expect(page.getByText('Decision timeline', { exact: false })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Residual uncertainty', { exact: true })).toBeVisible()
})
