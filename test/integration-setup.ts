import { existsSync } from 'node:fs'
import { canConnect, ensureDatabase, runMigrations } from '../packages/database/src/index.ts'

/** Creates and migrates the dedicated integration-test database before any test runs. */
export default async function setup(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://audivra:audivra@127.0.0.1:5440/audivra_test'
  if (!url.includes('test'))
    throw new Error(`Refusing to run integration tests against a non-test database: ${url}`)
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const reachable = await canConnect(maintenance.toString())
  if (!reachable.ok)
    throw new Error(`Test database server unreachable (${reachable.error}). Run \`pnpm run setup\` first.`)
  await ensureDatabase(url)
  await runMigrations(url)
}
