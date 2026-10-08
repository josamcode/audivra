import { existsSync } from 'node:fs'
import type { PlaywrightTestConfig } from '@playwright/test'

if (existsSync('.env')) process.loadEnvFile('.env')

export const E2E_PORTS = { web: 4309, api: 4319, fixture: 4331 }
export const FIXTURE_URL = `http://127.0.0.1:${E2E_PORTS.fixture}`

const base = new URL(process.env.DATABASE_URL ?? 'postgres://audivra:audivra@127.0.0.1:5440/audivra')
base.pathname = '/audivra_e2e'
/** The dedicated E2E database (specs use it for platform-internal flows such as broker submissions). */
export const E2E_DATABASE_URL = base.toString()

/** Shared web-server setup: fixture site, single-process backend (API + worker) and the Vite UI. */
export function e2eServers(
  ai: 'claude' | 'off',
  extraEnv: Record<string, string> = {},
): PlaywrightTestConfig['webServer'] {
  const backendEnv = {
    DATABASE_URL: E2E_DATABASE_URL,
    SERVER_PORT: String(E2E_PORTS.api),
    AUDIVRA_AI: ai,
    AUDIVRA_DATA_DIR: '.local-data/e2e',
    E2E_RESET: '1',
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'warn',
    BASELINE_MAX_PAGES: '12',
    BASELINE_BROWSER_PAGES: '3',
    // ZAP and testssl take minutes per audit (and testssl needs HTTPS); the E2E fixture uses the fast scanners.
    BASELINE_SCANNERS: 'httpx,katana,pa11y',
    ...extraEnv,
  }
  return [
    {
      command: 'node fixtures/site/server.mjs',
      url: FIXTURE_URL,
      env: { FIXTURE_PORT: String(E2E_PORTS.fixture) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node node_modules/tsx/dist/cli.mjs e2e/backend.ts',
      url: `http://127.0.0.1:${E2E_PORTS.api}/api/health`,
      env: backendEnv,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @audivra/web dev',
      url: `http://127.0.0.1:${E2E_PORTS.web}`,
      env: { WEB_PORT: String(E2E_PORTS.web), SERVER_PORT: String(E2E_PORTS.api) },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ]
}
