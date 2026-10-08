import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SecurityEngagementDetail, SecurityExecutionDetail } from '@audivra/contracts'
import { createBoss, createDb, type DbHandle, type PgBoss } from '@audivra/database'
import { createDurableBroker, LOCAL_USER, submitRuntimeCheck, type CapabilityBroker } from '@audivra/security'
import { E2E_DATABASE_URL, FIXTURE_URL } from './env.ts'

/*
 * Durable security executions on the deterministic stack. The UI cannot start an execution; the spec
 * requests the harmless runtime check through the capability broker (the platform-internal flow the
 * `pnpm security:runtime-check` script uses), then follows it in the Executions view: queued → running →
 * succeeded with its artifact evidence, and a second one cancelled from the UI.
 */

let handle: DbHandle
let boss: PgBoss
let broker: CapabilityBroker

test.beforeAll(async () => {
  handle = createDb(E2E_DATABASE_URL, 2)
  boss = createBoss(E2E_DATABASE_URL)
  await boss.start()
  broker = createDurableBroker({ db: handle.db, boss })
})

test.afterAll(async () => {
  await boss.stop({ graceful: false })
  await handle.close()
})

async function readyEngagement(request: APIRequestContext, name: string): Promise<SecurityEngagementDetail> {
  const created = await request.post('/api/security/engagements', { data: { name, targetUrl: FIXTURE_URL, environment: 'staging' } })
  expect(created.status()).toBe(201)
  const { id } = (await created.json()) as SecurityEngagementDetail
  const authorized = await request.post(`/api/security/engagements/${id}/authorizations`, { data: { method: 'local-development' } })
  const { engagement } = (await authorized.json()) as { engagement: SecurityEngagementDetail }
  expect(engagement.readiness.ready).toBe(true)
  return engagement
}

async function requestRuntimeCheck(engagement: SecurityEngagementDetail, holdSeconds: number): Promise<string> {
  const outcome = await submitRuntimeCheck(broker, { engagementId: engagement.id, targetUrl: engagement.targetUrl, holdSeconds, actor: LOCAL_USER })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  return outcome.executionId
}

test('a harmless capability runs through the queue and worker, and its evidence is visible', async ({ page, request }) => {
  const engagement = await readyEngagement(request, 'E2E runtime check')
  await page.goto(`/security/${engagement.id}?tab=executions`)
  await expect(page.getByText('No executions yet')).toBeVisible()
  await expect(page.getByText(`pnpm security:runtime-check ${engagement.id}`)).toBeVisible()

  const executionId = await requestRuntimeCheck(engagement, 6)
  const queued = await request.get(`/api/security/executions/${executionId}`)
  expect(((await queued.json()) as SecurityExecutionDetail).status).toMatch(/queued|preparing|running/)

  await page.reload()
  const row = page.getByRole('row', { name: /Runtime check/ })
  await expect(row).toBeVisible()
  const status = page.getByTestId('execution-status')
  await expect(status).toContainText('Running', { timeout: 20_000 })
  await expect(page.locator('#execution-detail')).toContainText(executionId)
  await expect(status).toContainText('Succeeded', { timeout: 30_000 })
  await expect(row).toContainText('Succeeded')

  const detail = page.locator('#execution-detail')
  for (const type of ['execution.queued', 'execution.started', 'execution.cleanup-completed', 'execution.completed']) {
    await expect(detail.getByText(type, { exact: true })).toBeVisible()
  }
  await expect(detail.getByText('Runtime check passed', { exact: true })).toBeVisible()
  await expect(detail.getByText('Staging', { exact: true })).toBeVisible()
  const artifact = detail.getByRole('link', { name: /runtime-check\.txt/ })
  await expect(artifact).toBeVisible()
  const served = await request.get((await artifact.getAttribute('href'))!)
  expect(served.status()).toBe(200)
  expect(await served.text()).toContain(`execution:   ${executionId}`)

  // The Executions view inspects and cancels; it never starts anything.
  await expect(page.getByRole('button', { name: /\b(run|start|execute|scan)\b/i })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: 'Cancel execution' })).toHaveCount(0)

  // The run is part of the engagement's audit trail too.
  await page.getByRole('tab', { name: 'Audit trail' }).click()
  await expect(page.getByText('execution.completed', { exact: true }).first()).toBeVisible()
})

test('a running execution is cancelled from the Executions view', async ({ page, request }) => {
  const engagement = await readyEngagement(request, 'E2E cancellation')
  const executionId = await requestRuntimeCheck(engagement, 120)
  await page.goto(`/security/${engagement.id}?tab=executions`)
  const status = page.getByTestId('execution-status')
  await expect(status).toContainText('Running', { timeout: 20_000 })

  await page.getByRole('button', { name: 'Cancel execution' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Other executions and processes are not affected')
  await dialog.getByRole('button', { name: 'Cancel execution' }).click()
  await expect(status).toContainText(/Cancelling|Cancelled/)
  await expect(status).toContainText('Cancelled', { timeout: 30_000 })
  await expect(page.locator('#execution-detail').getByText('execution.cancelled', { exact: true })).toBeVisible()

  const detail = (await (await request.get(`/api/security/executions/${executionId}`)).json()) as SecurityExecutionDetail
  expect(detail).toMatchObject({ status: 'cancelled', failure: { kind: 'cancelled' }, exit: { processes: { started: 1 } } })
  expect(detail.exit!.processes.terminated).toBeGreaterThanOrEqual(1)
})
