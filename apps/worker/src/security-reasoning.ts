import { randomUUID } from 'node:crypto'
import type { Logger } from '@audivra/config'
import { enqueueSecurityReasoning, getSecurityExecutionRow, QUEUES, type Db, type PgBoss, type SecurityReasoningJob } from '@audivra/database'
import { createProviderRegistry, createProviderRouter, createReasoningAi, type ProviderRegistry } from '@audivra/ai-runtime'
import { createDurableBroker, createRuntimeRegistry, GraphProjector, ReasoningEngine, type CapabilityRegistry, type ReasoningAi, type Resolver } from '@audivra/security'

/*
 * Phase 4 on the worker: the Security Graph is projected after every security execution settles, and
 * reasoning runs are driven as durable pg-boss jobs. A job names a run and nothing else; the run's stage,
 * budget and knowledge are loaded from the database, so a restart, a lost AI session or a provider change
 * resumes it where it stopped. The AI reaches Audivra only through the provider router; every action it
 * proposes goes through the Capability Broker like any other request.
 */

const RUN_ID = /^rr_[0-9a-z]{14}$/

export interface SecurityReasoningWorker {
  engine: ReasoningEngine
  projector: GraphProjector
  /** Hook for the execution worker: project the graph and wake runs waiting on this execution. */
  executionSettled(executionId: string): Promise<void>
  /** Requeues runs left by a previous worker (call before `start`). */
  recover(): Promise<string[]>
  start(): Promise<void>
  stop(): Promise<void>
}

export function createSecurityReasoningWorker(options: {
  db: Db
  boss: PgBoss
  log: Logger
  /** Capabilities the planner may use and the broker accepts (default: the runtime registry). */
  registry?: CapabilityRegistry
  /** AI providers (default: the configured registry). Tests and the E2E inject deterministic ones. */
  providers?: ProviderRegistry
  /** Overrides the AI port entirely (null: AI off). */
  ai?: ReasoningAi | null
  resolver?: Resolver
}): SecurityReasoningWorker {
  const { db, boss } = options
  const log = options.log.child({ component: 'security-reasoning' })
  const registry = options.registry ?? createRuntimeRegistry()
  const broker = createDurableBroker({ db, boss, registry, resolver: options.resolver, log })
  const ai = options.ai !== undefined ? options.ai : createReasoningAi(createProviderRouter(options.providers ?? createProviderRegistry()))
  const projector = new GraphProjector({ db, log })
  const enqueue = async (runId: string) => {
    await enqueueSecurityReasoning(boss, runId)
  }
  const engine = new ReasoningEngine({ db, broker, ai, registry, projector, log, ownerId: `worker-${process.pid}-${randomUUID().slice(0, 8)}`, enqueue })
  const controller = new AbortController()

  async function drive(runId: string) {
    // Keep driving while the run is immediately resumable (its executions settled while it was being parked).
    for (let i = 0; i < 20 && !controller.signal.aborted; i++) {
      const run = await engine.drive(runId, { signal: controller.signal })
      if (!run || run.status !== 'waiting' || !(await engine.readyToResume(runId))) {
        if (run) log.info({ runId, status: run.status, stage: run.stage, stopReason: run.stopReason }, 'reasoning run driven')
        return
      }
    }
  }

  return {
    engine,
    projector,
    async executionSettled(executionId) {
      const execution = await getSecurityExecutionRow(db, executionId)
      if (!execution) return
      try {
        await projector.project(execution.engagementId)
      } catch (error) {
        // Projection is deterministic and repeatable: a failure here is retried by the next one.
        log.error({ err: error, executionId }, 'security graph projection failed')
      }
      for (const runId of await engine.executionSettled(executionId)) await enqueue(runId)
    },
    async recover() {
      const ids = await engine.recover()
      for (const id of ids) await enqueue(id)
      if (ids.length) log.warn({ runs: ids }, 'requeued reasoning runs left by a previous worker')
      return ids
    },
    async start() {
      await boss.work<SecurityReasoningJob>(QUEUES.securityReasoning, { localConcurrency: 2, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const runId = job.data?.runId
          if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
            log.warn({ jobId: job.id }, 'ignoring a reasoning job without a valid run id')
            continue
          }
          await drive(runId)
        }
      })
    },
    async stop() {
      // Running drives stop at their next stage boundary; the run keeps its persisted stage for the next worker.
      controller.abort(new Error('Worker shutting down'))
      await boss.offWork(QUEUES.securityReasoning).catch(() => undefined)
    },
  }
}
