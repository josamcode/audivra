import { expect, test } from '@playwright/test'
import { FIXTURE_URL } from './env.ts'

test('the public landing page hands a website to the New audit flow', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /Know what your website needs\.\s*Know what to fix next\./,
  )
  // The landing page renders without the workspace chrome.
  await expect(page.locator('aside')).toHaveCount(0)

  const hero = page.locator('.lp-hero')
  // Same validation rule as the API, shown inline.
  await hero.getByRole('button', { name: 'Audit your website' }).click()
  await expect(hero.getByRole('alert')).toHaveText('Enter a website URL')
  await hero.getByLabel('Website URL').fill('not a url')
  await hero.getByLabel('Website URL').press('Enter')
  await expect(hero.getByRole('alert')).toHaveText(/valid http\(s\) website URL/)

  // A valid URL opens the existing New audit page, pre-filled; the audit only starts from there.
  await hero.getByLabel('Website URL').fill(FIXTURE_URL)
  await hero.getByRole('button', { name: 'Audit your website' }).click()
  await expect(page).toHaveURL(/\/audits\/new\?url=/)
  await expect(page.getByLabel('Website URL')).toHaveValue(FIXTURE_URL)
  await expect(page.getByRole('button', { name: /start full audit/i })).toBeVisible()
})

test('landing navigation reaches the workspace and in-page sections', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Platform' }).click()
  const mega = page.locator('#lp-mega-platform')
  await expect(mega).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(mega).toBeHidden()

  await page.locator('header').getByRole('link', { name: 'FAQ' }).click()
  await expect(page).toHaveURL(/#faq$/)
  const faq = page.locator('.lp-faq__item').nth(1)
  await faq.getByRole('button').click()
  await expect(faq).toHaveAttribute('data-open', 'true')

  await page.locator('header').getByRole('link', { name: 'Open app' }).click()
  await expect(page).toHaveURL(/\/audits$/)
  await expect(page.getByRole('heading', { name: 'Audits', exact: true })).toBeVisible()
})
