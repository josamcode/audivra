process.env.AUDIVRA_SERVICE ??= 'worker'

import { getConfig, getLogger } from '@audivra/config'
import {
  canConnect,
  createBoss,
  ensureQueues,
  getDb,
  QUEUES,
  runMigrations,
  type StageJob,
} from '@audivra/database'
import { ClaudeCliProvider } from '@audivra/ai-runtime'
import { Pipeline } from './pipeline.ts'

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

const pipeline = new Pipeline(db, boss, log)

type Handler = (auditId: string) => Promise<void>
const handlers: [string, Handler, number][] = [
  [QUEUES.baseline, (id) => pipeline.handleBaseline(id), 2],
  [QUEUES.investigation, (id) => pipeline.handleInvestigation(id), 2],
  [QUEUES.review, (id) => pipeline.handleReview(id), 2],
  [QUEUES.revision, (id) => pipeline.handleRevision(id), 2],
  [QUEUES.finalize, (id) => pipeline.handleFinalize(id), 2],
]

for (const [queue, handler, concurrency] of handlers) {
  await boss.work<StageJob>(
    queue,
    { localConcurrency: concurrency, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const jobLog = log.child({ jobId: job.id, queue, auditId: job.data.auditId })
        jobLog.info('job started')
        try {
          await handler(job.data.auditId)
          jobLog.info('job finished')
        } catch (error) {
          // Stage handlers record failures themselves; anything reaching here is unexpected and retried by pg-boss.
          jobLog.error({ err: error }, 'job crashed')
          throw error
        }
      }
    },
  )
}
log.info({ queues: handlers.map(([q]) => q), ai: config.AUDIVRA_AI }, 'worker ready')

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'worker shutting down')
  // Not graceful: in-flight stages are retried by pg-boss after restart (heartbeat expiry).
  await ClaudeCliProvider.killAll()
  await boss.stop({ graceful: false }).catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
