import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityEngagementDetail, SecurityExecutionDetail, SecurityHypothesis } from '@audivra/contracts'
import { createBoss, createDb, type DbHandle, type PgBoss } from '@audivra/database'
import { createDurableBroker, findApprovedRuntime, LOCAL_USER, runtimeImageRef, type CapabilityBroker } from '@audivra/security'
import { E2E_DATABASE_URL } from './env.ts'

/*
 * Phase 4 end to end, deterministic: a security engagement → a sensor (httpx, through the scoped gateway)
 * produces observations → the Security Graph appears with an explicit unknown (a technology only one sensor
 * reported) → "Investigate" starts a bounded reasoning run on the worker (a deterministic, rule-based
 * provider stands in for the model) → a hypothesis is created → the planner's capabilities run through the
 * Capability Broker (katana first, which cannot corroborate it, then nuclei, which can) → new evidence
 * reaches the graph → the hypothesis becomes a confirmed signal. No deep active testing is involved.
 */

const run = promisify(execFile)
async function imageReady(runtimeId: string): Promise<boolean> {
  const runtime = findApprovedRuntime(runtimeId)
  if (!runtime) return false
  try {
    await run('docker', ['image', 'inspect', runtimeImageRef(runtime), '--format', '{{.Id}}'], { windowsHide: true, timeout: 60_000 })
    return true
  } catch {
    return false
  }
}

let handle: DbHandle
let boss: PgBoss
let broker: CapabilityBroker
let site: http.Server
let siteUrl: string
let sensorsReady = false

test.beforeAll(async () => {
  sensorsReady = (await imageReady('httpx')) && (await imageReady('katana')) && (await imageReady('nuclei'))
  handle = createDb(E2E_DATABASE_URL, 2)
  boss = createBoss(E2E_DATABASE_URL)
  await boss.start()
  broker = createDurableBroker({ db: handle.db, boss })
  // A small target whose Server header names its web server; nothing else about it is known up front.
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'nginx/1.18.0' })
    res.end(`<!doctype html><html><head><title>Reasoning fixture</title></head><body><a href="/about">About</a></body></html>`)
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  siteUrl = `http://127.0.0.1:${(site.address() as import('node:net').AddressInfo).port}/`
})

test.afterAll(async () => {
  await boss.stop({ graceful: false })
  await handle.close()
  site.close()
})

async function readyEngagement(request: APIRequestContext): Promise<SecurityEngagementDetail> {
  const created = await request.post('/api/security/engagements', { data: { name: 'E2E reasoning', targetUrl: siteUrl, environment: 'staging' } })
  expect(created.status()).toBe(201)
  const { id } = (await created.json()) as SecurityEngagementDetail
  const authorized = await request.post(`/api/security/engagements/${id}/authorizations`, { data: { method: 'local-development' } })
  const { engagement } = (await authorized.json()) as { engagement: SecurityEngagementDetail }
  expect(engagement.readiness.ready).toBe(true)
  return engagement
}

test('sensors → graph → hypothesis → useful capability → new evidence → hypothesis changes state', async ({ page, request }) => {
  test.skip(!sensorsReady, 'The pinned httpx, katana and nuclei images are needed (never pulled implicitly)')
  test.setTimeout(8 * 60_000)
  const engagement = await readyEngagement(request)

  // 1. A sensor runs through the broker (the platform-internal flow) and records observations.
  const outcome = await broker.submit({ engagementId: engagement.id, capabilityId: 'discovery.http-inspect', input: { url: siteUrl }, actor: LOCAL_USER })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  await expect
    .poll(async () => ((await (await request.get(`/api/security/executions/${outcome.executionId}`)).json()) as SecurityExecutionDetail).status, { timeout: 90_000 })
    .toBe('succeeded')

  // 2. The graph appears, with provenance and an explicit unknown.
  await page.goto(`/security/${engagement.id}?tab=graph`)
  const nginx = page.getByRole('row', { name: /Technology.*Nginx/i })
  await expect(nginx).toBeVisible({ timeout: 20_000 })
  await expect(nginx).toContainText('httpx')
  await expect(page.getByTestId('graph-unknowns')).toContainText(/Is Nginx really in use\? Only httpx reported it/i)
  await nginx.click()
  const entity = page.locator('#graph-entity')
  await expect(entity.getByTestId('graph-entity-status')).toContainText('1 sensor (httpx)')
  await expect(entity.getByTestId('graph-provenance')).toContainText('Sensor observation')
  await expect(entity.getByTestId('graph-provenance')).toContainText(/EV-\d+/)

  // 3. Investigate: a bounded run on the worker, through the provider router and the broker.
  await page.getByRole('tab', { name: 'Hypotheses' }).click()
  await expect(page.getByText('No hypotheses yet')).toBeVisible()
  await page.getByRole('button', { name: 'Investigate' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Investigate' }).click()

  const row = page.getByRole('row', { name: /Nginx is in use/i })
  await expect(row).toBeVisible({ timeout: 60_000 })
  await expect(row).toContainText(/Needs evidence|Confirmed signal/)

  // 4. New evidence arrives (katana could not corroborate it; nuclei's server-banner template did) and the
  //    hypothesis changes state deterministically.
  await expect(row).toContainText('Confirmed signal', { timeout: 6 * 60_000 })
  await row.click()
  const detail = page.locator('#hypothesis-detail')
  await expect(detail.getByTestId('hypothesis-checks')).toContainText(/Met — Reported independently by httpx and nuclei/)
  const actions = detail.getByTestId('hypothesis-actions')
  await expect(actions).toContainText('discovery.crawl')
  await expect(actions).toContainText('web.signal-scan')
  await expect(actions.getByText('Completed')).toHaveCount(2)
  await expect(detail.getByTestId('hypothesis-ranking')).toContainText('expected gain')
  await expect(page.getByTestId('reasoning-run')).toContainText('Every hypothesis is resolved', { timeout: 60_000 })

  // The graph now carries the corroboration, with both sensors' provenance.
  await page.getByRole('tab', { name: 'Graph' }).click()
  await page.getByRole('row', { name: /Technology.*Nginx/i }).click()
  await expect(page.locator('#graph-entity').getByTestId('graph-entity-status')).toContainText('2 sensors (httpx, nuclei)')

  // The broker stayed the execution authority: the reasoning run's executions are agent requests it decided.
  const hypotheses = (await (await request.get(`/api/security/engagements/${engagement.id}/hypotheses`)).json()) as SecurityHypothesis[]
  expect(hypotheses.map((h) => h.status)).toEqual(['confirmed-signal'])
  const executions = (await (await request.get(`/api/security/engagements/${engagement.id}/executions`)).json()) as { id: string; capabilityId: string; requestedBy: { kind: string } }[]
  expect(executions.filter((e) => e.requestedBy.kind === 'agent').map((e) => e.capabilityId).sort()).toEqual(['discovery.crawl', 'web.signal-scan'])

  // The audit trail tells the story concisely.
  await page.getByRole('tab', { name: 'Audit trail' }).click()
  for (const type of ['graph.entity-discovered', 'reasoning.started', 'hypothesis.proposed', 'reasoning.action-executed', 'hypothesis.updated', 'reasoning.completed']) {
    await expect(page.getByText(type, { exact: true }).first()).toBeVisible()
  }
})
