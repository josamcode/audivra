import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { getConfig } from '@audivra/config'
import * as schema from './schema.ts'

export type Db = NodePgDatabase<typeof schema>

export interface DbHandle {
  db: Db
  pool: pg.Pool
  url: string
  close(): Promise<void>
}

export function createDb(url: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max })
  pool.on('error', () => {
    // Idle client errors (e.g. database restart) are surfaced on the next query instead of crashing.
  })
  const db = drizzle(pool, { schema })
  return { db, pool, url, close: () => pool.end() }
}

let shared: DbHandle | undefined

/** Process-wide database handle using DATABASE_URL. */
export function getDb(): DbHandle {
  shared ??= createDb(getConfig().DATABASE_URL)
  return shared
}

export async function closeDb(): Promise<void> {
  if (shared) {
    const handle = shared
    shared = undefined
    await handle.close()
  }
}
