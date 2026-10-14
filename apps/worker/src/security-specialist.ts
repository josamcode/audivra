import type { Logger } from '@audivra/config'
import { QUEUES, type Db, type PgBoss, type SecuritySpecialistJob } from '@audivra/database'
import { createDurableBroker, GraphProjector, SpecialistRunService, StrixSpecialistEngine, type SpecialistEngine } from '@audivra/security'

/*
 * Phase 6D on the worker: a specialist run is a durable pg-boss job. The job names only the run; its config
 * (engine, mode, Audivra-built target set) is loaded from the database. The engine runs as an Audivra-owned
 * subprocess; a crash/restart is reconciled idempotently (never re-running finished external work). The real
 * Strix engine is inert unless explicitly enabled and set up; a deterministic fake can be injected for tests.
 */

const RUN_ID = /^spr_[0-9a-z]{14}$/

export interface SecuritySpecialistWorker {
  service: SpecialistRunService
  drive(runId: string): Promise<void>
  recover(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export function createSecuritySpecialistWorker(options: { db: Db; boss: PgBoss; log: Logger; engines?: Partial<Record<'strix', SpecialistEngine>> }): SecuritySpecialistWorker {
  const { db, boss } = options
  const log = options.log.child({ component: 'security-specialist' })
  const broker = createDurableBroker({ db, boss, log })
  const service = new SpecialistRunService({ db, broker, engines: options.engines ?? { strix: new StrixSpecialistEngine() }, boss, graphProjector: new GraphProjector({ db, log }), log })
  const controller = new AbortController()

  async function drive(runId: string) {
    const run = await service.drive(runId, { signal: controller.signal })
    log.info({ runId, state: run.state, completion: run.completion }, 'specialist run driven')
  }

  return {
    service,
    drive,
    async recover() {
      const report = await service.recover()
      if (report.reconciled) log.warn(report, 'reconciled specialist runs left by a previous worker')
    },
    async start() {
      await boss.work<SecuritySpecialistJob>(QUEUES.securitySpecialist, { localConcurrency: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const runId = job.data?.runId
          if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
            log.warn({ jobId: job.id }, 'ignoring a specialist job without a valid run id')
            continue
          }
          try {
            await drive(runId)
          } catch (error) {
            log.error({ err: error, runId }, 'specialist run failed')
            throw error
          }
        }
      })
    },
    async stop() {
      controller.abort(new Error('Worker shutting down'))
      await boss.offWork(QUEUES.securitySpecialist).catch(() => undefined)
    },
  }
}
