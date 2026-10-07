/**
 * Starts the worker and API server in one process for Playwright E2E runs, against a dedicated
 * database and data directory (configured by the Playwright config via environment variables).
 */
import { createDb, ensureDatabase, runMigrations } from '../packages/database/src/index.ts'

const url = process.env.DATABASE_URL ?? ''
if (!/e2e|test/.test(url)) throw new Error(`E2E backend refuses to run against a non-test database: ${url}`)
await ensureDatabase(url)

if (process.env.E2E_RESET === '1') {
  await runMigrations(url)
  const handle = createDb(url, 1)
  await handle.pool.query('truncate audits cascade')
  await handle.close()
}

await import('../apps/worker/src/main.ts')
await import('../apps/server/src/main.ts')
