import { expect, test } from '@playwright/test'
import { FIXTURE_URL } from './env.ts'

test('create an audit of the fixture site and inspect baseline evidence through the UI', async ({ page }) => {
  // First run (the E2E database starts empty): an empty state instead of empty panels, with System health.
  await page.goto('/audits')
  await expect(page.getByText('No audits yet')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Start first audit' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Recent audits' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Summary' })).toHaveCount(0)

  // Audits home → New audit
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

  // While it runs, the home screen leads with it under "Running now", with real stages (no percentage).
  await page.goto('/audits')
  const runningNow = page.locator('section', { has: page.getByRole('heading', { name: 'Running now' }) })
  await expect(runningNow).toBeVisible()
  await expect(runningNow.getByText('127.0.0.1:4331')).toBeVisible()
  await expect(runningNow.getByText('Baseline').first()).toBeVisible()
  await expect(runningNow).not.toContainText('%')
  await page.goto(auditUrl)

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
  await page.goto('/audits')
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

test('audits home: real summary, recent audits, system health and the benchmark toggle', async ({ page }) => {
  type Dashboard = { summary: { totalAudits: number; websites: number; localTargets: number }; audits: { id: string }[] }
  const dashboard = (await (await page.request.get('/api/dashboard')).json()) as Dashboard
  expect(dashboard.summary.totalAudits).toBeGreaterThanOrEqual(2)

  await page.goto('/audits')
  await expect(page.getByText('Track recent audits, site health, activity, and follow-up opportunities.')).toBeVisible()
  // Every number comes from the API; the fixture runs on 127.0.0.1, a local target, so no website is counted.
  const summary = page.getByRole('region', { name: 'Summary' })
  await expect(summary).toContainText(`Total audits${dashboard.summary.totalAudits}`)
  await expect(summary).toContainText('Websites audited0')
  await expect(summary).toContainText(`Excludes ${dashboard.summary.localTargets} local target`)
  await expect(summary).toContainText('All caught up')

  // Rows are local, baseline-only audits: tagged as such, with no invented findings or trend.
  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(dashboard.audits.length)
  await expect(rows.first()).toContainText('Local')
  await expect(rows.first()).toContainText('Baseline only')

  // Keyboard: a focused row opens with Enter.
  await rows.first().focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/audits/${dashboard.audits[0]!.id}`))
  await page.goBack()

  // Search filters the list; an unmatched query says so.
  await page.getByRole('textbox', { name: 'Search audits or websites' }).fill('no-such-site.example')
  await expect(page.getByText('No audits match')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(rows).toHaveCount(dashboard.audits.length)

  // Local targets never become business follow-ups; the runtime state is real.
  await expect(page.getByText('No follow-ups yet')).toBeVisible()
  const health = page.locator('section', { has: page.getByRole('heading', { name: 'System health' }) })
  await expect(health.getByText('Audit engine')).toBeVisible()
  await expect(health.getByText('Running', { exact: true })).toBeVisible()
  await expect(health.getByText('Healthy', { exact: true })).toBeVisible()

  // Benchmark audits are opt-in and the choice lives in the URL. With none recorded, turning it off hides it.
  await page.goto('/audits?benchmark=true')
  const toggle = page.getByRole('switch', { name: 'Show benchmark audits' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(page).not.toHaveURL(/benchmark/)
  await expect(toggle).toHaveCount(0)
})

test('system page lists tool availability', async ({ page }) => {
  await page.goto('/system')
  await expect(page.getByText('Playwright', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Lighthouse/).first()).toBeVisible()
  await expect(page.getByText(/Nuclei/).first()).toBeVisible()
  await expect(page.getByText(/Disabled/i).first()).toBeVisible()
})
