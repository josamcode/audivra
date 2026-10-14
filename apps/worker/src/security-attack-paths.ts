import type { Logger } from '@audivra/config'
import { QUEUES, type Db, type PgBoss, type SecurityAttackPathJob } from '@audivra/database'
import { createProviderRegistry, createProviderRouter, createReasoningAi, type ProviderRegistry } from '@audivra/ai-runtime'
import { AttackPathService, type ReasoningAi } from '@audivra/security'

/*
 * Phase 6B on the worker: attack-path analysis runs as a durable pg-boss job. A job names only the
 * engagement; the analysis loads findings and the Security Graph and is deterministic + idempotent, so a
 * crash or restart simply re-runs it (paths advance by their stable key, never duplicating). The optional AI
 * proposer/explainer reaches Audivra only through the provider router; a provider failure leaves the
 * deterministic paths intact. No capability is executed.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export interface SecurityAttackPathWorker {
  service: AttackPathService
  analyze(engagementId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export function createSecurityAttackPathWorker(options: { db: Db; boss: PgBoss; log: Logger; providers?: ProviderRegistry; ai?: ReasoningAi | null }): SecurityAttackPathWorker {
  const { db, boss } = options
  const log = options.log.child({ component: 'security-attack-paths' })
  const ai = options.ai !== undefined ? options.ai : createReasoningAi(createProviderRouter(options.providers ?? createProviderRegistry()))
  const service = new AttackPathService({ db, ai: ai ?? undefined, log })
  const controller = new AbortController()

  async function analyze(engagementId: string) {
    const result = await service.drive(engagementId, { signal: controller.signal })
    log.info({ engagementId, ...result }, 'attack-path analysis driven')
  }

  return {
    service,
    analyze,
    async start() {
      await boss.work<SecurityAttackPathJob>(QUEUES.securityAttackPath, { localConcurrency: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const engagementId = job.data?.engagementId
          if (typeof engagementId !== 'string' || !ENGAGEMENT_ID.test(engagementId)) {
            log.warn({ jobId: job.id }, 'ignoring an attack-path job without a valid engagement id')
            continue
          }
          try {
            await analyze(engagementId)
          } catch (error) {
            log.error({ err: error, engagementId }, 'attack-path analysis failed')
            throw error
          }
        }
      })
    },
    async stop() {
      controller.abort(new Error('Worker shutting down'))
      await boss.offWork(QUEUES.securityAttackPath).catch(() => undefined)
    },
  }
}
