import type { Logger } from '@audivra/config'
import { QUEUES, type Db, type PgBoss, type SecurityRetestJob } from '@audivra/database'
import { createProviderRegistry, createProviderRouter, createReasoningAi, type ProviderRegistry } from '@audivra/ai-runtime'
import { ComparisonEngine, createDurableBroker, createRuntimeRegistry, RetestService, type CapabilityRegistry, type ReasoningAi, type Resolver } from '@audivra/security'

/*
 * Phase 6C on the worker: a retest replay runs as a durable pg-boss job. The job names only the retest case
 * and the target assessment; the case (its frozen reproduction, 6A checks and controls) is loaded from the
 * database, so the job carries no plan, capability or command. The replay reuses the SAME runtime as a
 * comparison — the capability broker, durable executions, evidence and classification — so a crash/restart is
 * recoverable and nothing bypasses policy. A provider failure (AI adaptation) never yields a fix.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export interface SecurityRetestWorker {
  service: RetestService
  retest(job: SecurityRetestJob): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export function createSecurityRetestWorker(options: {
  db: Db
  boss: PgBoss
  log: Logger
  registry?: CapabilityRegistry
  resolver?: Resolver
  providers?: ProviderRegistry
  /** Overrides the AI port entirely (null: adaptation off → unsupported adaptations stay blocked/cannot-reproduce). */
  ai?: ReasoningAi | null
}): SecurityRetestWorker {
  const { db, boss } = options
  const log = options.log.child({ component: 'security-retests' })
  const registry = options.registry ?? createRuntimeRegistry()
  const ai = options.ai !== undefined ? options.ai : createReasoningAi(createProviderRouter(options.providers ?? createProviderRegistry()))
  const broker = createDurableBroker({ db, boss, registry, resolver: options.resolver, log })
  const comparisonEngine = new ComparisonEngine({ db, broker, log })
  const service = new RetestService({ db, comparisonEngine, registry, ai: ai ?? undefined, log })
  const controller = new AbortController()

  async function retest(job: SecurityRetestJob) {
    const result = await service.runRetest(job.retestCaseId, job.targetEngagementId, { allowAdaptation: job.allowAdaptation, signal: controller.signal })
    log.info({ retestCaseId: job.retestCaseId, targetEngagementId: job.targetEngagementId, state: result.state }, 'retest replayed')
  }

  return {
    service,
    retest,
    async start() {
      await boss.work<SecurityRetestJob>(QUEUES.securityRetest, { localConcurrency: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const { retestCaseId, targetEngagementId } = job.data ?? {}
          if (typeof retestCaseId !== 'string' || typeof targetEngagementId !== 'string' || !ENGAGEMENT_ID.test(targetEngagementId)) {
            log.warn({ jobId: job.id }, 'ignoring a retest job without a valid case/target')
            continue
          }
          try {
            await retest(job.data)
          } catch (error) {
            log.error({ err: error, retestCaseId, targetEngagementId }, 'retest replay failed')
            throw error
          }
        }
      })
    },
    async stop() {
      controller.abort(new Error('Worker shutting down'))
      await boss.offWork(QUEUES.securityRetest).catch(() => undefined)
    },
  }
}
