import { getConfig, type Logger } from '@audivra/config'
import { QUEUES, type Db, type PgBoss, type SecurityExecutionJob } from '@audivra/database'
import {
  createBossExecutionQueue,
  createDbExecutionStore,
  createDbSecurityStore,
  createRuntimeRegistry,
  createSecretVault,
  ExecutionRuntime,
  IsolatedContainerBackend,
  VaultAuthResolver,
  type ExecutionRuntimeOptions,
  type RecoveryReport,
} from '@audivra/security'

/*
 * Durable security executions on the existing pg-boss worker. A job names one execution and nothing
 * else; the runtime loads the trusted snapshot from the database, so neither a job payload nor the
 * request that led to it can change what runs. The work happens here, never in an API request.
 */

const EXECUTION_ID = /^sx_[0-9a-z]{14}$/

export interface SecurityExecutionWorker {
  runtime: ExecutionRuntime
  /** Reconciles executions left by a worker that is gone (call before `start`). */
  recover(): Promise<RecoveryReport>
  /** Starts consuming the execution queue. */
  start(): Promise<void>
  /** Interrupts running executions (their owned processes are terminated) and stops taking new ones. */
  shutdown(): Promise<void>
}

export function createSecurityExecutionWorker(options: {
  db: Db
  boss: PgBoss
  log: Logger
  /** Test seams (polling interval, grace period, backend…). */
  runtime?: Partial<ExecutionRuntimeOptions>
  /** Called after an execution job settles (Phase 4: project the graph, wake waiting reasoning runs). */
  onSettled?: (executionId: string) => Promise<void>
}): SecurityExecutionWorker {
  const { db, boss } = options
  const config = getConfig()
  const log = options.log.child({ component: 'security-executions' })
  const concurrency = options.runtime?.maxActive ?? config.SECURITY_EXECUTION_CONCURRENCY
  const runtime = new ExecutionRuntime({
    registry: createRuntimeRegistry(),
    store: createDbSecurityStore(db),
    executions: createDbExecutionStore(db),
    queue: createBossExecutionQueue(boss),
    // Capabilities declare their execution mode; the runtime picks the backend from the trusted snapshot.
    backends: { 'isolated-container': new IsolatedContainerBackend() },
    // Identity-aware executions resolve their session's material from the vault at the trusted boundary.
    authResolver: new VaultAuthResolver({ db, vault: createSecretVault(db, { log }) }),
    maxActive: concurrency,
    log,
    ...options.runtime,
  })
  return {
    runtime,
    async recover() {
      const report = await runtime.recover()
      if (report.requeued.length || report.reconciled.length) log.warn(report, 'reconciled security executions left by a previous worker')
      return report
    },
    async start() {
      await boss.work<SecurityExecutionJob>(QUEUES.securityExecution, { localConcurrency: concurrency, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const executionId = job.data?.executionId
          if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) {
            log.warn({ jobId: job.id }, 'ignoring a security execution job without a valid execution id')
            continue
          }
          const status = await runtime.run(executionId)
          log.info({ jobId: job.id, executionId, status }, 'security execution job finished')
          if (options.onSettled) await options.onSettled(executionId).catch((error: unknown) => log.error({ err: error, executionId }, 'post-execution hook failed'))
        }
      })
    },
    shutdown: () => runtime.shutdown(),
  }
}
