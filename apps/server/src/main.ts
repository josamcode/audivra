process.env.AUDIVRA_SERVICE ??= 'server'

import { getConfig, getLogger } from '@audivra/config'
import { canConnect, createBoss, ensureQueues, getDb, runMigrations } from '@audivra/database'
import { buildApp } from './app.ts'
import { EventHub } from './events-hub.ts'

const config = getConfig()
const log = getLogger()

const connection = await canConnect(config.DATABASE_URL)
if (!connection.ok) {
  log.fatal(
    { error: connection.error },
    'Cannot reach PostgreSQL. Run `pnpm run setup` (or start Docker) first.',
  )
  process.exit(1)
}
await runMigrations(config.DATABASE_URL)

const { db } = getDb()
const boss = createBoss(config.DATABASE_URL)
boss.on('error', (error) => log.error({ err: error }, 'pg-boss error'))
await boss.start()
await ensureQueues(boss)

const hub = new EventHub(config.DATABASE_URL, db, log.child({ component: 'events' }))
await hub.start()

const app = await buildApp({ db, boss, hub, log, serveWeb: process.argv.includes('--serve-web') })
await app.listen({ port: config.SERVER_PORT, host: '127.0.0.1' })
log.info(`API listening on http://127.0.0.1:${config.SERVER_PORT}`)

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'shutting down')
  await app.close().catch(() => undefined)
  await hub.stop()
  await boss.stop({ graceful: false }).catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
