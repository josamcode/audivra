import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createDb } from './client.ts'

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations')

/** Creates the target database if it does not exist (requires CREATEDB on the maintenance DB). */
export async function ensureDatabase(url: string): Promise<boolean> {
  const target = new URL(url)
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''))
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const client = new pg.Client({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [dbName])
    if (exists.rowCount) return false
    await client.query(`create database "${dbName.replace(/"/g, '""')}"`)
    return true
  } finally {
    await client.end()
  }
}

export async function runMigrations(url: string): Promise<void> {
  const handle = createDb(url, 1)
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await handle.close()
  }
}

export async function canConnect(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 })
  try {
    await client.connect()
    await client.query('select 1')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await client.end().catch(() => undefined)
  }
}
