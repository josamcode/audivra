import type { Logger } from '@audivra/config'
import { QUEUES, type Db, type PgBoss, type SecurityComparisonJob } from '@audivra/database'
import { ComparisonEngine, createDurableBroker, createRuntimeRegistry, type CapabilityRegistry, type Resolver } from '@audivra/security'

/*
 * Phase 5 Step 4 on the worker: a planned differential comparison is executed as a durable pg-boss job. The
 * job names the comparison and nothing else; its plan is loaded from the database. The engine resolves each
 * arm's session and runs it through the Capability Broker (which re-checks policy, scope and identity), so a
 * job payload can never carry configuration. A retry resumes from the persisted arm state — a completed arm
 * (including a state-changing one) is never re-executed.
 */

const COMPARISON_ID = /^cmp_[0-9a-z]{14}$/

export interface SecurityComparisonWorker {
  engine: ComparisonEngine
  start(): Promise<void>
  stop(): Promise<void>
}

export function createSecurityComparisonWorker(options: { db: Db; boss: PgBoss; log: Logger; registry?: CapabilityRegistry; resolver?: Resolver }): SecurityComparisonWorker {
  const { db, boss } = options
  const log = options.log.child({ component: 'security-comparisons' })
  const registry = options.registry ?? createRuntimeRegistry()
  const broker = createDurableBroker({ db, boss, registry, resolver: options.resolver, log })
  const engine = new ComparisonEngine({ db, broker, log })

  return {
    engine,
    async start() {
      await boss.work<SecurityComparisonJob>(QUEUES.securityComparison, { localConcurrency: 2, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const comparisonId = job.data?.comparisonId
          if (typeof comparisonId !== 'string' || !COMPARISON_ID.test(comparisonId)) {
            log.warn({ jobId: job.id }, 'ignoring a comparison job without a valid comparison id')
            continue
          }
          try {
            const comparison = await engine.run(comparisonId)
            log.info({ comparisonId, result: comparison.result, dimension: comparison.dimension }, 'differential comparison job finished')
          } catch (error) {
            log.error({ err: error, comparisonId }, 'differential comparison job failed')
            throw error
          }
        }
      })
    },
    async stop() {
      await boss.offWork(QUEUES.securityComparison).catch(() => undefined)
    },
  }
}
