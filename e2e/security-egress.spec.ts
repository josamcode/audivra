import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityEngagementDetail, SecurityExecutionDetail } from '@audivra/contracts'
import { createBoss, createDb, type DbHandle, type PgBoss } from '@audivra/database'
import { APPROVED_RUNTIMES, containerNameFor, createDurableBroker, egressNetworkName, gatewayNameFor, internalNetworkName, LOCAL_USER, runtimeImageRef, type CapabilityBroker } from '@audivra/security'
import { E2E_DATABASE_URL, FIXTURE_URL } from './env.ts'

/*
 * Controlled network egress on the deterministic stack. A networked isolated diagnostic is requested
 * through the capability broker (platform-internal; the UI cannot start anything) and followed in the
 * Executions view: running → succeeded, shown as scoped egress with its gateway decision counts and its
 * artifact, while an out-of-scope probe is denied and the execution-private gateway and networks are
 * removed. Skipped when Docker or the approved runtime image is not available.
 */

const run = promisify(execFile)
const state = async (type: 'container' | 'network', name: string) => {
  const args = type === 'container' ? ['inspect', '--type', 'container', '--format', '{{.State.Status}}', name] : ['network', 'inspect', '--format', '{{.Name}}', name]
  return run('docker', args, { windowsHide: true }).then(
    () => 'present',
    () => 'absent',
  )
}
const dockerReady = await run('docker', ['image', 'inspect', runtimeImageRef(APPROVED_RUNTIMES[0]!), '--format', '{{.Id}}'], { windowsHide: true }).then(
  () => true,
  () => false,
)

let handle: DbHandle
let boss: PgBoss
let broker: CapabilityBroker

test.skip(!dockerReady, 'Docker or the approved node-sandbox image is not available')

test.beforeAll(async () => {
  handle = createDb(E2E_DATABASE_URL, 2)
  boss = createBoss(E2E_DATABASE_URL)
  await boss.start()
  broker = createDurableBroker({ db: handle.db, boss })
})
test.afterAll(async () => {
  await boss?.stop({ graceful: false })
  await handle?.close()
})

async function readyEngagement(request: APIRequestContext, name: string): Promise<SecurityEngagementDetail> {
  const created = await request.post('/api/security/engagements', { data: { name, targetUrl: FIXTURE_URL, environment: 'staging' } })
  const { id } = (await created.json()) as SecurityEngagementDetail
  const authorized = await request.post(`/api/security/engagements/${id}/authorizations`, { data: { method: 'local-development' } })
  return ((await authorized.json()) as { engagement: SecurityEngagementDetail }).engagement
}

test('a networked capability reaches its target only through the gateway, and the UI shows scoped egress', async ({ page, request }) => {
  const engagement = await readyEngagement(request, 'E2E controlled egress')
  // One in-scope request (the fixture) and one out-of-scope probe (a different port), through the gateway.
  const outcome = await broker.submit({
    engagementId: engagement.id,
    capabilityId: 'diagnostic.egress-check',
    input: { target: `${FIXTURE_URL}/`, probes: [{ label: 'out-of-scope', url: 'http://127.0.0.1:4310/api/health' }], holdSeconds: 2 },
    actor: LOCAL_USER,
  })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  const id = outcome.executionId

  await page.goto(`/security/${engagement.id}?tab=executions`)
  const status = page.getByTestId('execution-status')
  await expect(status).toContainText('Running', { timeout: 30_000 })
  await expect(page.getByTestId('execution-network')).toContainText('Scoped egress', { timeout: 20_000 })
  await expect(status).toContainText('Succeeded', { timeout: 40_000 })

  const detail = page.locator('#execution-detail')
  await expect(page.getByTestId('execution-network')).toContainText('allowed')
  await expect(page.getByTestId('execution-network')).toContainText('denied')
  for (const type of ['execution.network-ready', 'execution.gateway-started', 'execution.network-summary']) {
    await expect(detail.getByText(type, { exact: true })).toBeVisible()
  }
  const artifact = detail.getByRole('link', { name: /egress-check\.txt/ })
  await expect(artifact).toBeVisible()
  const served = await request.get((await artifact.getAttribute('href'))!)
  expect(await served.text()).toContain('DENIED by gateway')

  // The private gateway and networks are gone; the API confirms the decisions and removals.
  const api = (await (await request.get(`/api/security/executions/${id}`)).json()) as SecurityExecutionDetail
  expect(api).toMatchObject({ status: 'succeeded', trusted: { isolation: { network: 'scoped-egress' } } })
  expect(api.exit!.runtime!.network).toMatchObject({ gateway: { removed: true }, decisions: { denied: expect.any(Number) } })
  expect(api.exit!.runtime!.network!.decisions!.denied).toBeGreaterThanOrEqual(1)
  expect([await state('container', containerNameFor(id)), await state('container', gatewayNameFor(id)), await state('network', internalNetworkName(id)), await state('network', egressNetworkName(id))]).toEqual([
    'absent',
    'absent',
    'absent',
    'absent',
  ])
})
