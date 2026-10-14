import type { Logger } from '@audivra/config'
import { QUEUES, type Db, type PgBoss, type SecurityResearchJob } from '@audivra/database'
import { createProviderRegistry, createProviderRouter, createReasoningAi, type ProviderRegistry } from '@audivra/ai-runtime'
import { createDurableBroker, GraphProjector, ResearchService, type ReasoningAi, type SpecialistEngine } from '@audivra/security'

/*
 * Phase 6E on the worker: the autonomous research loop runs as a durable pg-boss job. The job names only the
 * run; all loop state is loaded from the database, so a crash/restart resumes deterministically. The AI is
 * the Phase 3C router (advisory proposals only); a provider failure degrades the run, never completes it.
 */

const RUN_ID = /^rsr_[0-9a-z]{14}$/

export interface SecurityResearchWorker {
  service: ResearchService
  drive(runId: string): Promise<void>
  recover(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export function createSecurityResearchWorker(options: {
  db: Db
  boss: PgBoss
  log: Logger
  providers?: ProviderRegistry
  /** Override the AI port (null: deterministic-only loop) — tests inject a scripted provider. */
  ai?: ReasoningAi | null
  /** Inject specialist engines (tests pass the deterministic fake). */
  specialistEngines?: Partial<Record<'strix', SpecialistEngine>>
}): SecurityResearchWorker {
  const { db, boss } = options
  const log = options.log.child({ component: 'security-research' })
  const ai = options.ai !== undefined ? options.ai : createReasoningAi(createProviderRouter(options.providers ?? createProviderRegistry()))
  const broker = createDurableBroker({ db, boss, log })
  const service = new ResearchService({ db, broker, ai: ai ?? undefined, specialistEngines: options.specialistEngines, graphProjector: new GraphProjector({ db, log }), boss, log })
  const controller = new AbortController()

  async function drive(runId: string) {
    const run = await service.drive(runId, { signal: controller.signal })
    log.info({ runId, state: run.state, termination: run.terminationReason, iterations: run.usage.iterations }, 'research run driven')
  }

  return {
    service,
    drive,
    async recover() {
      const report = await service.recover()
      if (report.resumed) log.warn(report, 'resuming research runs left by a previous worker')
    },
    async start() {
      await boss.work<SecurityResearchJob>(QUEUES.securityResearch, { localConcurrency: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const runId = job.data?.runId
          if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
            log.warn({ jobId: job.id }, 'ignoring a research job without a valid run id')
            continue
          }
          try {
            await drive(runId)
          } catch (error) {
            log.error({ err: error, runId }, 'research run failed')
            throw error
          }
        }
      })
    },
    async stop() {
      controller.abort(new Error('Worker shutting down'))
      await boss.offWork(QUEUES.securityResearch).catch(() => undefined)
    },
  }
}
