import { getConfig } from '@audivra/config'
import { ensureDatabase, runMigrations } from './migrate.ts'

const url = process.argv[2] ?? getConfig().DATABASE_URL
const created = await ensureDatabase(url)
if (created) console.warn(`Created database ${new URL(url).pathname.slice(1)}`)
await runMigrations(url)
console.warn('Migrations applied')
