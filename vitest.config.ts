import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

if (existsSync('.env')) process.loadEnvFile('.env')
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://audivra:audivra@127.0.0.1:5440/audivra_test'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/test/**/*.test.{ts,tsx}',
            'apps/server/test/**/*.test.ts',
            'apps/worker/test/**/*.test.ts',
          ],
          exclude: ['**/*.integration.test.{ts,tsx}', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/**/*.integration.test.ts', 'apps/**/test/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          globalSetup: ['./test/integration-setup.ts'],
          // Integration tests run against a dedicated database and data directory, never the dev data.
          env: {
            DATABASE_URL: testDatabaseUrl,
            TEST_DATABASE_URL: testDatabaseUrl,
            AUDIVRA_DATA_DIR: '.local-data/test',
            LOG_LEVEL: 'warn',
            LOG_FORMAT: 'json',
            BASELINE_BROWSER_PAGES: '2',
            BASELINE_MAX_PAGES: '12',
            // Optional scanners have their own integration test; pipeline tests stay fast without them.
            BASELINE_SCANNERS: '',
          },
        },
      },
    ],
  },
})
