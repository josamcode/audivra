import { expect, test } from '@playwright/test'
import { FIXTURE_URL } from './env.ts'

/*
 * Security engagement setup on the deterministic stack: create → authorize the local fixture → ready,
 * scope checks in the UI, the effective policy and the audit trail. Nothing here executes a capability,
 * and the UI offers no way to.
 */

test('a security engagement goes from draft to ready through the UI, with no way to run tests', async ({ page }) => {
  await page.goto('/security')
  await expect(page.getByRole('heading', { name: 'Security assessments' })).toBeVisible()
  await page.getByRole('link', { name: 'New engagement' }).first().click()

  await page.getByLabel('Name').fill('E2E fixture engagement')
  await page.getByLabel('Target URL').fill(FIXTURE_URL)
  // The environment is a deliberate choice: submitting without one is refused.
  await page.getByRole('button', { name: /create engagement/i }).click()
  await expect(page.getByText('Choose the environment')).toBeVisible()
  await page.getByRole('radio', { name: /^Staging/ }).click()
  await page.getByRole('button', { name: /create engagement/i }).click()

  await expect(page).toHaveURL(/\/security\/[0-9a-z]{10}$/)
  await expect(page.getByRole('heading', { name: 'E2E fixture engagement' })).toBeVisible()
  await expect(page.getByText('Not authorized').first()).toBeVisible()
  await expect(page.getByText('Configuration and readiness only')).toBeVisible()

  // Authorize the local fixture (loopback, this port only).
  await page.getByRole('tab', { name: 'Authorization' }).click()
  await expect(page.getByText('DNS TXT record')).toBeVisible()
  await expect(page.getByText('Not available yet').first()).toBeVisible()
  await page.getByRole('button', { name: 'Verify local target' }).click()
  await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible()

  // Scope checks: the fixture itself is in scope; another host name for the same server is not.
  await page.getByRole('tab', { name: 'Scope' }).click()
  const port = new URL(FIXTURE_URL).port
  await page.getByLabel('URL to check').fill(`http://localhost:${port}/`)
  await page.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(page.getByTestId('scope-check-result')).toContainText('Denied')
  await expect(page.getByTestId('scope-check-result')).toContainText('scope.host-not-listed')
  await page.getByLabel('URL to check').fill(`${FIXTURE_URL}/services`)
  await page.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(page.getByTestId('scope-check-result')).toContainText('scope.host-rule')
  await expect(page.getByTestId('scope-check-result')).toContainText('dns.addresses-in-scope')

  // Effective policy for staging.
  await page.getByRole('tab', { name: 'Policy' }).click()
  await expect(page.getByRole('radio', { name: /^Staging/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('row', { name: /Destructive or resource-intensive/ })).toContainText('Denied')

  // The audit trail records every step.
  await page.getByRole('tab', { name: 'Audit trail' }).click()
  for (const type of ['engagement.created', 'authorization.requested', 'authorization.changed', 'lifecycle.changed']) {
    await expect(page.getByText(type, { exact: true }).first()).toBeVisible()
  }

  // Phase 1 offers configuration only: no action anywhere runs a test or a capability.
  await expect(page.getByRole('button', { name: /\b(run|scan|attack|pentest|execute)\b/i })).toHaveCount(0)
  await page.getByRole('button', { name: 'Lifecycle', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /^Activate/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^Cancel engagement/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^\s*(run|scan|execute|attack|start)\b/i })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The list shows the engagement as ready.
  await page.goto('/security')
  await expect(page.getByRole('row', { name: /E2E fixture engagement/ })).toContainText('Ready')
})

test('Website Audits stay available alongside security engagements', async ({ page }) => {
  await page.goto('/audits')
  await expect(page.getByRole('heading', { name: 'Audits' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Security' })).toBeVisible()
  await page.goto('/audits/new')
  await expect(page.getByLabel('Website URL')).toBeVisible()
})
