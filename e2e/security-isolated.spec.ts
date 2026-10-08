import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityEngagementDetail, SecurityExecutionDetail } from '@audivra/contracts'
import { createBoss, createDb, type DbHandle, type PgBoss } from '@audivra/database'
import { APPROVED_RUNTIMES, containerNameFor, createDurableBroker, LOCAL_USER, runtimeImageRef, type CapabilityBroker } from '@audivra/security'
import { E2E_DATABASE_URL, FIXTURE_URL } from './env.ts'

/*
 * The isolated container runtime on the deterministic stack. The harmless isolated diagnostic is
 * requested through the capability broker (platform-internal; the UI cannot start anything) and followed
 * in the Executions view: running → succeeded, shown as an isolated container, its artifact visible, its
 * container removed. A second one is cancelled from the UI. Skipped when Docker or the approved runtime
 * image is not available on this machine.
 */

const run = promisify(execFile)
const containerState = async (name: string) => {
  try {
    return (await run('docker', ['inspect', '--type', 'container', '--format', '{{.State.Status}}', name], { windowsHide: true })).stdout.trim()
  } catch {
    return 'absent'
  }
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

async function requestIsolatedCheck(engagement: SecurityEngagementDetail, holdSeconds: number): Promise<string> {
  const outcome = await broker.submit({ engagementId: engagement.id, capabilityId: 'diagnostic.isolated-check', input: { target: engagement.targetUrl, holdSeconds }, actor: LOCAL_USER })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  return outcome.executionId
}

test('a harmless isolated capability runs in its own container, and its artifact is visible', async ({ page, request }) => {
  const engagement = await readyEngagement(request, 'E2E isolated runtime')
  const executionId = await requestIsolatedCheck(engagement, 6)
  await page.goto(`/security/${engagement.id}?tab=executions`)
  const status = page.getByTestId('execution-status')
  await expect(status).toContainText(/Queued|Preparing|Running/)
  await expect(status).toContainText('Running', { timeout: 20_000 })
  await expect.poll(() => containerState(containerNameFor(executionId)), { timeout: 20_000 }).toBe('running')
  await expect(page.getByTestId('execution-runtime')).toContainText('Isolated container · node-sandbox v1')
  await expect(page.getByTestId('execution-runtime')).toContainText('no network')

  await expect(status).toContainText('Succeeded', { timeout: 40_000 })
  const detail = page.locator('#execution-detail')
  await expect(page.getByTestId('execution-container')).toContainText('exited with code 0 · removed')
  for (const type of ['execution.container-created', 'execution.container-started', 'execution.container-exited', 'execution.container-removed', 'execution.completed']) {
    await expect(detail.getByText(type, { exact: true })).toBeVisible()
  }
  await expect(detail.getByText('Isolated runtime check passed', { exact: true })).toBeVisible()
  const artifact = detail.getByRole('link', { name: /isolated-check\.txt/ })
  await expect(artifact).toBeVisible()
  const served = await request.get((await artifact.getAttribute('href'))!)
  expect(await served.text()).toContain('root filesystem: read-only')
  expect(await containerState(containerNameFor(executionId))).toBe('absent')
  await expect(page.getByRole('button', { name: /\b(run|start|execute|scan)\b/i })).toHaveCount(0)
})

test('a running isolated execution is cancelled from the UI and its container removed', async ({ page, request }) => {
  const engagement = await readyEngagement(request, 'E2E isolated cancellation')
  const executionId = await requestIsolatedCheck(engagement, 120)
  await page.goto(`/security/${engagement.id}?tab=executions`)
  const status = page.getByTestId('execution-status')
  await expect(status).toContainText('Running', { timeout: 20_000 })
  await expect.poll(() => containerState(containerNameFor(executionId)), { timeout: 20_000 }).toBe('running')

  await page.getByRole('button', { name: 'Cancel execution' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel execution' }).click()
  await expect(status).toContainText('Cancelled', { timeout: 30_000 })
  await expect(page.getByTestId('execution-container')).toContainText('removed')
  expect(await containerState(containerNameFor(executionId))).toBe('absent')
  const detail = (await (await request.get(`/api/security/executions/${executionId}`)).json()) as SecurityExecutionDetail
  expect(detail).toMatchObject({ status: 'cancelled', trusted: { isolation: { mode: 'isolated-container', network: 'none' } }, exit: { runtime: { backend: 'isolated-container' } } })
})
