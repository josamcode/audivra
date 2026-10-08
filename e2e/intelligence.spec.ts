import { expect, test, type Page } from '@playwright/test'
import { FIXTURE_URL } from './env.ts'

/*
 * Website intelligence features on the deterministic (AI-off) stack. Runs after audit-baseline.spec.ts,
 * which leaves finished fixture audits behind.
 */

type AuditRow = { id: string; status: string; domain: string; template: { key: string; version: number; name: string } | null }

async function finishedFixtureAudit(page: Page): Promise<string> {
  const audits = (await (await page.request.get('/api/audits')).json()) as AuditRow[]
  const finished = audits.filter((a) => a.status === 'completed' && a.domain.includes('4331'))
  expect(finished.length, 'audit-baseline.spec.ts leaves finished fixture audits').toBeGreaterThan(0)
  return finished.at(-1)!.id
}

test('the audit focus is chosen on New audit and stored with its version', async ({ page }) => {
  await page.goto('/audits/new')
  await expect(page.getByRole('combobox', { name: 'Audit focus' })).toContainText('General website')
  await page.getByRole('combobox', { name: 'Audit focus' }).click()
  await page.getByRole('option', { name: /Lead generation/ }).click()
  await expect(page.getByText(/Focus on forms, WhatsApp, calls/).first()).toBeVisible()
  await page.getByLabel('Website URL').fill(FIXTURE_URL)
  await page.getByRole('button', { name: /start full audit/i }).click()
  await expect(page).toHaveURL(/\/audits\/[0-9a-z]{10}/)
  const id = new URL(page.url()).pathname.split('/').at(-1)!

  await expect(page.getByText('Lead generation').first()).toBeVisible()
  const detail = (await (await page.request.get(`/api/audits/${id}`)).json()) as AuditRow
  expect(detail.template).toEqual({ key: 'lead-generation', version: 1, name: 'Lead generation' })
  // Not needed for the rest of the suite; stop it instead of running another baseline.
  await page.request.post(`/api/audits/${id}/cancel`)
})

test('journeys: an audit without them says so and explains why it cannot be analyzed', async ({ page }) => {
  const id = await finishedFixtureAudit(page)
  await page.goto(`/audits/${id}?tab=journeys`)
  await expect(page.getByText('Journey analysis not available for this audit.')).toBeVisible()
  // AI is off in this suite: the reason is shown instead of an action that cannot run.
  await expect(page.getByText(/without AI|AI is turned off/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Analyze journeys' })).toHaveCount(0)
})

test('evidence graph: stored links around one item, with details and re-centring', async ({ page }) => {
  const id = await finishedFixtureAudit(page)
  const evidence = (await (await page.request.get(`/api/audits/${id}/evidence`)).json()) as { ref: string; url: string | null }[]
  const withPage = evidence.find((e) => e.url?.startsWith('http'))!
  await page.goto(`/audits/${id}?tab=evidence&view=graph&focus=evidence:${withPage.ref}`)

  await expect(page.getByRole('heading', { name: 'Evidence graph' })).toBeVisible()
  await expect(page.getByTestId('evidence-graph-canvas')).toBeVisible()
  // The focus is selected first; its details are the evidence viewer.
  await expect(page.getByRole('button', { name: new RegExp(`^Evidence: .*\\(focus\\)$`) })).toBeVisible()

  // Selecting the page it was captured on shows that page, how it connects, and an action.
  await page.getByRole('button', { name: /^Page: / }).first().click()
  await expect(page.getByRole('heading', { name: 'Page', exact: true })).toBeVisible()
  await expect(page.getByText(/captured here/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Findings on this page' })).toBeVisible()

  // Re-centre on the page, then Reset returns to where the graph was opened.
  await page.getByRole('button', { name: 'Center graph here' }).click()
  await expect(page).toHaveURL(/focus=page/)
  await expect(page.getByRole('button', { name: /^Page: .*\(focus\)$/ })).toBeVisible()
  await page.getByRole('button', { name: 'Reset the graph' }).click()
  await expect(page).toHaveURL(new RegExp(`focus=evidence%3A${withPage.ref}|focus=evidence:${withPage.ref}`))

  // The API refuses focuses that do not exist rather than inventing a graph.
  expect((await page.request.get(`/api/audits/${id}/graph?focus=finding:F999`)).status()).toBe(404)
})

test('client view: the report as the client sees it, without internals or app chrome', async ({ page }) => {
  const id = await finishedFixtureAudit(page)
  await page.goto(`/audits/${id}`)
  await page.getByRole('link', { name: 'Client', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/audits/${id}/client$`))

  await expect(page.getByRole('heading', { name: 'Executive snapshot' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Technical appendix' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Report sections' })).toBeVisible()
  // No app sidebar or runtime status around the client-facing page.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  const text = (await page.locator('body').innerText()).toLowerCase()
  for (const internal of ['claude', 'prompt', 'session', 'turns', 'auditor:v', '.local-data', 'agent run', id]) {
    expect(text, `client view must not show "${internal}"`).not.toContain(internal.toLowerCase())
  }

  // The old report URL lands on the client view; Internal goes back to the working view.
  await page.goto(`/audits/${id}/report`)
  await expect(page).toHaveURL(new RegExp(`/audits/${id}/client$`))
  await page.getByRole('link', { name: 'Internal', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/audits/${id}$`))
})
