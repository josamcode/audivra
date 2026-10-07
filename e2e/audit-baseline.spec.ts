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

test('visual report, exports and history for finished audits', async ({ page }) => {
  type AuditRow = { id: string; status: string; domain: string }
  const finished = async () =>
    ((await (await page.request.get('/api/audits')).json()) as AuditRow[]).filter((a) => a.status === 'completed' && a.domain.includes('4331'))
  const [first] = await finished()
  expect(first, 'the previous test leaves a finished fixture audit').toBeTruthy()
  const id = first!.id

  // Overview: summary tiles and an explicit coverage table (disabled scanners are listed, not hidden).
  await page.goto(`/audits/${id}`)
  await expect(page.getByText('First audit').first()).toBeVisible()
  await expect(page.getByText('Coverage').first()).toBeVisible()
  await expect(page.getByText(/Passive security scan \(ZAP\)/).first()).toBeVisible()

  // Visuals: deterministic, evidence-backed visuals exist without AI, each exportable as PNG.
  await page.goto(`/audits/${id}?tab=visuals`)
  await expect(page.getByText('Key measurements').first()).toBeVisible()
  await expect(page.getByText('Site structure').first()).toBeVisible()
  const png = await page.request.get(`/api/audits/${id}/visuals/A1.png`)
  expect(png.status()).toBe(200)
  expect(png.headers()['content-type']).toContain('image/png')

  // Pages: the crawled inventory.
  await page.goto(`/audits/${id}?tab=pages`)
  await expect(page.getByText('/services/implants').first()).toBeVisible()

  // Client report preview with its fixed structure.
  await page.goto(`/audits/${id}/report`)
  await expect(page.getByRole('heading', { name: 'Executive snapshot' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Technical appendix' })).toBeVisible()
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByText('Complete audit bundle (ZIP)').first()).toBeVisible()
  await page.keyboard.press('Escape')

  // Exports are generated from persisted data.
  const json = await page.request.get(`/api/audits/${id}/export/json`)
  expect(json.status()).toBe(200)
  expect(((await json.json()) as { schema: string }).schema).toBe('audivra.audit.v1')

  // A second audit of the same site turns the History tab into a comparison.
  const created = await page.request.post('/api/audits', { data: { url: FIXTURE_URL } })
  expect(created.ok()).toBe(true)
  const second = ((await created.json()) as { id: string }).id
  await expect
    .poll(async () => ((await (await page.request.get(`/api/audits/${second}`)).json()) as { status: string }).status, { timeout: 5 * 60_000 })
    .toBe('completed')
  await page.goto(`/audits/${second}?tab=history`)
  await expect(page.getByText('Measurements').first()).toBeVisible()
  await expect(page.getByText('Audits of this site').first()).toBeVisible()
  const comparison = await page.request.get(`/api/audits/${second}/comparison`)
  expect(comparison.status()).toBe(200)
  expect(((await comparison.json()) as { previous: { id: string } }).previous.id).toBe(id)
})

test('system page lists tool availability', async ({ page }) => {
  await page.goto('/system')
  await expect(page.getByText('Playwright', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Lighthouse/).first()).toBeVisible()
  await expect(page.getByText(/Nuclei/).first()).toBeVisible()
  await expect(page.getByText(/Disabled/i).first()).toBeVisible()
})
