import { defineConfig, devices } from '@playwright/test'
import { E2E_PORTS, e2eServers } from './e2e/env.ts'

/**
 * Deterministic E2E suite: the real app (Vite UI + API + worker + PostgreSQL + Chromium baseline)
 * auditing the local fixture site with AI disabled. The AI journey lives in playwright.ai.config.ts.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  testIgnore: /.*\.ai\.spec\.ts/,
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORTS.web}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: e2eServers('off'),
})
