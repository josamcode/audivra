import type { Logger } from '@audivra/config'
import { QUEUES, type Db, type PgBoss, type SecurityVerificationJob } from '@audivra/database'
import { createProviderRegistry, createProviderRouter, createReasoningAi, type ProviderRegistry } from '@audivra/ai-runtime'
import { createRuntimeRegistry, GraphProjector, VerificationService, type CapabilityRegistry, type ReasoningAi } from '@audivra/security'

/*
 * Phase 6A on the worker: the verification boundary runs as a durable pg-boss job. A job names only the
 * engagement; the pass loads all stored knowledge and is deterministic + idempotent, so a crash or restart
 * simply re-runs it (candidates advance by issueKey, never duplicating). The independent verifier/prose/
 * reviewer reach Audivra only through the provider router; a provider failure blocks a candidate (it is
 * never promoted to verified), and the deterministic path runs fully even with the AI off.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export interface SecurityVerificationWorker {
  service: VerificationService
  /** Runs one verification pass directly (used by the E2E and by the closed loop). */
  verify(engagementId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export function createSecurityVerificationWorker(options: {
  db: Db
  boss: PgBoss
  log: Logger
  registry?: CapabilityRegistry
  providers?: ProviderRegistry
  /** Overrides the AI port entirely (null: AI off → deterministic verification only, findings are supported). */
  ai?: ReasoningAi | null
}): SecurityVerificationWorker {
  const { db, boss } = options
  const log = options.log.child({ component: 'security-verification' })
  const registry = options.registry ?? createRuntimeRegistry()
  const ai = options.ai !== undefined ? options.ai : createReasoningAi(createProviderRouter(options.providers ?? createProviderRegistry()))
  const projector = new GraphProjector({ db, log })
  const service = new VerificationService({ db, registry, ai: ai ?? undefined, graphProjector: projector, log })
  const controller = new AbortController()

  async function verify(engagementId: string) {
    const result = await service.drive(engagementId, { signal: controller.signal })
    log.info({ engagementId, ...result }, 'verification pass driven')
  }

  return {
    service,
    verify,
    async start() {
      await boss.work<SecurityVerificationJob>(QUEUES.securityVerification, { localConcurrency: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const engagementId = job.data?.engagementId
          if (typeof engagementId !== 'string' || !ENGAGEMENT_ID.test(engagementId)) {
            log.warn({ jobId: job.id }, 'ignoring a verification job without a valid engagement id')
            continue
          }
          try {
            await verify(engagementId)
          } catch (error) {
            log.error({ err: error, engagementId }, 'verification pass failed')
            throw error
          }
        }
      })
    },
    async stop() {
      controller.abort(new Error('Worker shutting down'))
      await boss.offWork(QUEUES.securityVerification).catch(() => undefined)
    },
  }
}
