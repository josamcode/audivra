import type { Server } from 'node:http'
import { createDb, type DbHandle } from '../packages/database/src/index.ts'

/** Connects to the integration-test database (DATABASE_URL is pointed at it by vitest.config.ts). */
export function testDb(): DbHandle {
  const url = process.env.DATABASE_URL!
  if (!url.includes('test')) throw new Error('Integration tests must use the test database')
  return createDb(url, 5)
}

export async function resetDb(handle: DbHandle): Promise<void> {
  await handle.pool.query('truncate audits cascade')
}

export async function startFixture(): Promise<{ server: Server; url: string }> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../fixtures/site/server.mjs')) as {
    startFixtureServer(port: number): Promise<{ server: Server; url: string }>
  }
  return mod.startFixtureServer(0)
}
