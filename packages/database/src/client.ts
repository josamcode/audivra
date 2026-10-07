import { sql } from 'drizzle-orm'
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

/** Round-trip time of a trivial query in milliseconds; rejects when PostgreSQL does not answer in time. */
export async function pingDb(db: Db, timeoutMs = 3000): Promise<number> {
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No response from PostgreSQL within ${timeoutMs / 1000}s`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  return Math.round(performance.now() - started)
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
