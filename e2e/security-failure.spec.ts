import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityEngagementDetail, SecurityReportBundle, SessionEstablishmentResult, SystemDiagnostics } from '@audivra/contracts'
import { createDb, type DbHandle } from '@audivra/database'
import { DomainService, LOCAL_USER } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 6F failure / degraded paths (§59), deterministic: the product fails closed and degrades gracefully
 * rather than crashing or over-claiming. Unknown engagements and export kinds get clean, explained errors; an
 * assessment that found nothing produces an honest empty report with residual uncertainty (never a false
 * "all clear"); a credential that cannot authenticate yields `established: false` (no bad session stored); and
 * missing OPTIONAL components (Docker, AI, specialist) degrade the health report without ever blocking.
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
  fixture = await mod.startIdentityFixture({ port: 0, label: 'e2e-failure' })
  handle = createDb(E2E_DATABASE_URL, 2)
  domain = new DomainService({ db: handle.db })
})
test.afterAll(async () => {
  await fixture.close()
  await handle.close()
})

async function authorizedEngagement(request: APIRequestContext, name: string): Promise<string> {
  const created = await request.post('/api/security/engagements', { data: { name, targetUrl: fixture.url, environment: 'isolated-lab' } })
  const engagement = (await created.json()) as SecurityEngagementDetail
  await request.post(`/api/security/engagements/${engagement.id}/authorizations`, { data: { method: 'local-development' } })
  return engagement.id
}

test('unknown engagements and export kinds return clean, explained errors — not crashes', async ({ request }) => {
  const missing = 'zzzznosuchengage'
  const report = await request.get(`/api/security/engagements/${missing}/report`)
  expect(report.status()).toBe(404)
  expect((await report.json()).error).toBeTruthy()

  const badKind = await request.get(`/api/security/engagements/${missing}/report/export/pdf`)
  expect(badKind.status()).toBe(400)
  expect((await badKind.json()).error).toBeTruthy()
})

test('an assessment that found nothing produces an honest empty report with residual uncertainty', async ({ request }) => {
  const eid = await authorizedEngagement(request, 'E2E empty')

  const bundle = (await (await request.get(`/api/security/engagements/${eid}/report`)).json()) as SecurityReportBundle
  expect(bundle.findings.verifiedFindings).toHaveLength(0)
  expect(bundle.findings.supportedSignals).toHaveLength(0)
  expect(bundle.attackPaths.verifiedPaths).toHaveLength(0)
  // The honesty guarantee: never a silent "all clear". Coverage is explicitly incomplete.
  expect(bundle.residual).toBeTruthy()
  expect(bundle.residual.notTested.length).toBeGreaterThan(0)

  // Even empty, the HTML export renders a valid self-contained document.
  const html = await request.get(`/api/security/engagements/${eid}/report/export/html`)
  expect(html.status()).toBe(200)
  const body = await html.text()
  expect(body).toContain('E2E empty')
  expect(body).not.toContain('<script')
})

test('a credential that cannot authenticate fails closed — no session is established', async ({ request }) => {
  const eid = await authorizedEngagement(request, 'E2E fail-closed')
  // A credential whose token the fixture does not recognize: /me will answer 401, so validation must fail.
  await domain.declare(eid, { kind: 'identity', ref: 'mallory', spec: { identityType: 'user', authMethod: 'api-token', credentialRef: 'mallory-cred', tenantRef: 't1' } }, LOCAL_USER)
  const cred = await request.post(`/api/security/engagements/${eid}/credentials`, { data: { ref: 'mallory-cred', identityRef: 'mallory', secret: { type: 'bearer-token', token: 'not-a-registered-token' } } })
  expect(cred.status(), await cred.text()).toBe(201)

  const established = await request.post(`/api/security/engagements/${eid}/sessions/establish`, { data: { identityRef: 'mallory', flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } } })
  expect(established.status()).toBe(201)
  expect(((await established.json()) as SessionEstablishmentResult).established).toBe(false)
})

test('missing optional components degrade the health report without ever blocking', async ({ request }) => {
  const health = (await (await request.get('/api/security/health')).json()) as SystemDiagnostics
  // The DB is up in E2E, so no REQUIRED check fails — the overall state is never "blocked".
  expect(['ready', 'degraded']).toContain(health.overall)
  // Optional components are reported as non-required checks, each with a consequence (what is lost), so an
  // operator understands exactly what an absent component costs rather than seeing a hard failure.
  for (const id of ['docker', 'ai-provider', 'specialist']) {
    const c = health.checks.find((x) => x.id === id)
    expect(c, `health should report the ${id} check`).toBeTruthy()
    expect(c!.required).toBe(false)
  }
})
