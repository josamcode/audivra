import { expect, test } from '@playwright/test'
import { FIXTURE_URL } from './env.ts'

/**
 * Full AI journey with the real local Claude Code runtime. Assertions are about structure and
 * evidence linkage (not exact wording), since the auditor decides its own investigation.
 */
test('AI audit of the fixture produces evidence-linked findings that open in the UI', async ({ page }) => {
  await page.goto('/audits/new')
  await page.getByLabel('Website URL').fill(FIXTURE_URL)
  await page.getByLabel(/client/i).fill('E2E AI fixture')
  await page.getByRole('button', { name: /start full audit/i }).click()
  await expect(page).toHaveURL(/\/audits\/[0-9a-z]{10}/)

  const auditId = new URL(page.url()).pathname.split('/').pop()!

  // Progress through the AI stages (server truth), then the live UI must reflect completion quickly.
  await expect(page.getByText(/AI investigation/).first()).toBeVisible()
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/audits/${auditId}`)).json()) as { status: string }).status,
      { timeout: 40 * 60_000, intervals: [10_000] },
    )
    .toMatch(/completed|partial|failed/)
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

  // Overview has an executive summary written by the finalizer.
  await expect(page.getByText(/Executive summary/i).first()).toBeVisible()

  // Findings table → open the top finding.
  await page.getByRole('tab', { name: /Findings/ }).click()
  const rows = page.locator('tbody tr')
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3)
  await rows.first().click()
  await expect(page.getByText('Problem', { exact: false }).first()).toBeVisible()
  await expect(page.getByText(/What was observed/i).first()).toBeVisible()

  // Linked evidence is shown in the drawer and opens in the evidence workspace.
  const chip = page.getByRole('button', { name: /EV-\d+/ }).first()
  await expect(chip).toBeVisible()
  await page.getByText('Open in evidence').click()
  await expect(page).toHaveURL(/tab=evidence/)
  await expect(page).toHaveURL(/ev=EV-\d+/)

  // Screenshots captured during the audit render.
  await page.getByRole('radio', { name: /Screenshots/ }).click()
  const thumb = page.locator('img[src*="/artifacts/"]').first()
  await expect(thumb).toBeVisible()
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100)

  // The activity log shows the AI roles at work.
  await page.getByRole('tab', { name: /Activity/ }).click()
  await expect(page.getByText(/AI Auditor finished/).first()).toBeVisible()
  await expect(page.getByText(/AI Reviewer finished/).first()).toBeVisible()
  await expect(page.getByText(/Finalizer finished/).first()).toBeVisible()
})
