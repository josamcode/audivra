import { defineConfig, devices } from '@playwright/test'
import { chromiumExecutable } from '@audivra/tool-runtime'
import { E2E_PORTS, e2eServers } from './e2e/env.ts'

/**
 * AI-agent smoke test: the full pipeline with the real local Claude Code runtime
 * (Auditor → Reviewer → optional verification pass → Finalizer) on the fixture site.
 * Run with `pnpm test:e2e:ai`. Requires an authenticated Claude Code CLI.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.ai\.spec\.ts/,
  timeout: 45 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-ai' }]],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORTS.web}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // The Chromium build Audivra itself uses (shared Playwright cache or the project-local .tools cache).
    launchOptions: { executablePath: chromiumExecutable() ?? undefined },
  },
  webServer: e2eServers('claude', { AUDITOR_TIMEOUT_MINUTES: '25' }),
})
