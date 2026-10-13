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
  await handle.pool.query('truncate security_engagements cascade')
  await handle.close()
}

// The deterministic E2E suite runs with AI off; for Phase 4 reasoning it adds a deterministic, rule-based
// provider (eligible only for security reasoning tasks) so the full loop is exercised end to end.
if (process.env.E2E_SCRIPTED_REASONING === '1') {
  const { registerAdditionalProvider, ScriptedReasoningProvider } = await import('../packages/ai-runtime/src/index.ts')
  registerAdditionalProvider(new ScriptedReasoningProvider())
}

await import('../apps/worker/src/main.ts')
await import('../apps/server/src/main.ts')
