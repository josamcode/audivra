process.env.AUDIVRA_SERVICE ??= 'worker'

import { getConfig, getLogger } from '@audivra/config'
import {
  canConnect,
  createBoss,
  ensureQueues,
  failInterruptedBenchmarkRuns,
  failInterruptedOnDemandRuns,
  getDb,
  processStore,
  QUEUES,
  runMigrations,
  type EnrichJob,
  type StageJob,
  WORKER_INSTANCE,
} from '@audivra/database'
import { flushProcessStore, killAllOwned, reapStaleProcesses, setProcessStore } from '@audivra/tool-runtime'
import { runBenchmark } from './benchmark.ts'
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

// Process ownership: every process this worker starts is recorded, and only those are ever terminated.
setProcessStore({
  insert: (record) => processStore.insert(db, record),
  finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
  listStale: (ownerId) => processStore.listStale(db, ownerId),
})
const reaped = await reapStaleProcesses()
if (reaped.reaped || reaped.gone) {
  log.info(reaped, 'closed process records left by a previous worker (owned processes only)')
}

const interruptedJobs = await failInterruptedOnDemandRuns(db, ['journeys', 'changes', 'brief'])
if (interruptedJobs) log.warn({ interruptedJobs }, 'closed intelligence runs interrupted by a previous worker')

const interruptedBenchmarks = await failInterruptedBenchmarkRuns(db)
if (interruptedBenchmarks) log.warn({ interruptedBenchmarks }, 'closed benchmark runs interrupted by a previous worker')

const boss = createBoss(config.DATABASE_URL, WORKER_INSTANCE)
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
  [QUEUES.present, (id) => pipeline.handlePresent(id), 2],
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

await boss.work<EnrichJob>(QUEUES.enrich, { localConcurrency: 2, pollingIntervalSeconds: 1 }, async (jobs) => {
  for (const job of jobs) {
    const jobLog = log.child({ jobId: job.id, queue: QUEUES.enrich, auditId: job.data.auditId, kind: job.data.kind })
    jobLog.info('intelligence job started')
    await pipeline.handleEnrich(job.data)
    jobLog.info('intelligence job finished')
  }
})

await boss.work<{ benchmarkRunId?: string }>(
  QUEUES.benchmark,
  { localConcurrency: 1, pollingIntervalSeconds: 2 },
  async (jobs) => {
    for (const job of jobs) {
      const jobLog = log.child({ jobId: job.id, queue: QUEUES.benchmark })
      jobLog.info('benchmark started')
      await runBenchmark({ db, boss, log: jobLog, runId: job.data?.benchmarkRunId })
      jobLog.info('benchmark finished')
    }
  },
)
log.info({ queues: [...handlers.map(([q]) => q), QUEUES.enrich, QUEUES.benchmark], ai: config.AUDIVRA_AI }, 'worker ready')

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'worker shutting down')
  // Not graceful: in-flight stages are retried by pg-boss after restart (heartbeat expiry).
  // Only processes this worker started (ownership registry) are terminated.
  const killed = await killAllOwned()
  if (killed) log.info({ killed }, 'terminated owned processes')
  await flushProcessStore().catch(() => undefined)
  await boss.stop({ graceful: false }).catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
