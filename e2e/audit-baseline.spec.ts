import { expect, test } from '@playwright/test'
import { FIXTURE_URL } from './env.ts'

test('create an audit of the fixture site and inspect baseline evidence through the UI', async ({ page }) => {
  // Audits list → New audit
  await page.goto('/')
  await page.getByRole('link', { name: 'New audit' }).first().click()
  await expect(page).toHaveURL(/\/audits\/new$/)

  // Validation feedback for a bad URL
  await page.getByLabel('Website URL').fill('not a url')
  await page.getByRole('button', { name: /start full audit/i }).click()
  await expect(page.getByText(/valid http\(s\) website URL/i)).toBeVisible()

  await page.getByLabel('Website URL').fill(FIXTURE_URL)
  await page.getByLabel(/client/i).fill('E2E fixture')
  await page.getByRole('button', { name: /start full audit/i }).click()
  await expect(page).toHaveURL(/\/audits\/[0-9a-z]{10}/)
  const auditUrl = page.url()

  // Live progress: the header shows the running stage, then completion (pushed over SSE).
  await expect(page.getByText(/Running|Queued/).first()).toBeVisible()
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 5 * 60_000 })
  await expect(page.getByText('Baseline-only audit (AI disabled)')).toBeVisible()

  // Evidence tab: baseline evidence for planted issues, including a real screenshot.
  await page.getByRole('tab', { name: /Evidence/ }).click()
  await expect(page.getByText(/Horizontal overflow on mobile/).first()).toBeVisible()
  await expect(page.getByText(/No analytics or ad tracking detected/).first()).toBeVisible()
  await page
    .getByText(/Mobile 390×844 · \//)
    .first()
    .click()
  const image = page.locator('img[src*="/artifacts/screenshots/"]').first()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(300)

  // Deep link to a specific evidence item survives reload.
  const ev = new URL(page.url()).searchParams.get('ev')
  expect(ev).toMatch(/^EV-\d+$/)
  await page.reload()
  await expect(page.locator('img[src*="/artifacts/screenshots/"]').first()).toBeVisible()

  // Findings: none for a baseline-only audit, with an honest empty state.
  await page.getByRole('tab', { name: /Findings/ }).click()
  await expect(page.getByText(/No findings — baseline-only audit/)).toBeVisible()

  // Activity timeline records what happened.
  await page.getByRole('tab', { name: /Activity/ }).click()
  await expect(page.getByText(/Baseline completed: \d+ pages crawled/)).toBeVisible()
  await expect(page.getByText(/lighthouse completed/i).first()).toBeVisible()

  // Persisted: the audit is listed after a fresh load.
  await page.goto('/')
  const row = page.getByRole('row', { name: /127\.0\.0\.1:4331/ }).first()
  await expect(row).toBeVisible()
  await expect(row.getByText('Completed')).toBeVisible()
  await row.click()
  await expect(page).toHaveURL(new RegExp(auditUrl.split('/audits/')[1]!.split('?')[0]!))
})

test('system page lists tool availability', async ({ page }) => {
  await page.goto('/system')
  await expect(page.getByText('Playwright', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Lighthouse/).first()).toBeVisible()
  await expect(page.getByText(/Nuclei/).first()).toBeVisible()
  await expect(page.getByText(/Disabled/i).first()).toBeVisible()
})
