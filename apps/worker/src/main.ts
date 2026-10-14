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
import { createSecurityComparisonWorker } from './security-comparisons.ts'
import { createSecurityExecutionWorker } from './security-executions.ts'
import { createSecurityAttackPathWorker } from './security-attack-paths.ts'
import { createSecurityRetestWorker } from './security-retests.ts'
import { createSecurityReasoningWorker } from './security-reasoning.ts'
import { createSecurityVerificationWorker } from './security-verification.ts'

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

const boss = createBoss(config.DATABASE_URL, WORKER_INSTANCE)
boss.on('error', (error) => log.error({ err: error }, 'pg-boss error'))
await boss.start()
await ensureQueues(boss)

// Security executions left by a previous worker are reconciled first, so their orphaned owned processes
// are attributed to them; the general reaper below then closes every other leftover record.
// Phase 4: the Security Graph is projected after every execution settles, and reasoning runs it was
// waiting for are woken. Reasoning runs themselves are durable jobs on their own queue.
const securityReasoning = createSecurityReasoningWorker({ db, boss, log })
const securityComparisons = createSecurityComparisonWorker({ db, boss, log })
const securityVerification = createSecurityVerificationWorker({ db, boss, log })
const securityAttackPaths = createSecurityAttackPathWorker({ db, boss, log })
const securityRetests = createSecurityRetestWorker({ db, boss, log })
const securityExecutions = createSecurityExecutionWorker({ db, boss, log, onSettled: (id) => securityReasoning.executionSettled(id) })
await securityExecutions.recover()

const reaped = await reapStaleProcesses()
if (reaped.reaped || reaped.gone) {
  log.info(reaped, 'closed process records left by a previous worker (owned processes only)')
}

const interruptedJobs = await failInterruptedOnDemandRuns(db, ['journeys', 'changes', 'brief'])
if (interruptedJobs) log.warn({ interruptedJobs }, 'closed intelligence runs interrupted by a previous worker')

const interruptedBenchmarks = await failInterruptedBenchmarkRuns(db)
if (interruptedBenchmarks) log.warn({ interruptedBenchmarks }, 'closed benchmark runs interrupted by a previous worker')

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
await securityExecutions.start()
await securityReasoning.recover()
await securityReasoning.start()
await securityComparisons.start()
await securityVerification.start()
await securityAttackPaths.start()
await securityRetests.start()
log.info({ queues: [...handlers.map(([q]) => q), QUEUES.enrich, QUEUES.benchmark, QUEUES.securityExecution, QUEUES.securityReasoning, QUEUES.securityComparison], ai: config.AUDIVRA_AI }, 'worker ready')

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'worker shutting down')
  // Running security executions are interrupted (never left running or re-run); their owned processes are
  // terminated exactly. Audit stages are not graceful: pg-boss retries them after restart (heartbeat expiry).
  await securityReasoning.stop().catch((error) => log.error({ err: error }, 'security reasoning shutdown failed'))
  await securityComparisons.stop().catch((error) => log.error({ err: error }, 'security comparison shutdown failed'))
  await securityVerification.stop().catch((error) => log.error({ err: error }, 'security verification shutdown failed'))
  await securityAttackPaths.stop().catch((error) => log.error({ err: error }, 'security attack-path shutdown failed'))
  await securityRetests.stop().catch((error) => log.error({ err: error }, 'security retest shutdown failed'))
  await securityExecutions.shutdown().catch((error) => log.error({ err: error }, 'security execution shutdown failed'))
  // Only processes this worker started (ownership registry) are terminated.
  const killed = await killAllOwned()
  if (killed) log.info({ killed }, 'terminated owned processes')
  await flushProcessStore().catch(() => undefined)
  await boss.stop({ graceful: false }).catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
