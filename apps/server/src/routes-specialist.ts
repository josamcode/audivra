import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, RequestSpecialistRunInput } from '@audivra/contracts'
import { type Db, type PgBoss } from '@audivra/database'
import { createDurableBroker, SecurityRequestError, SpecialistReadService, SpecialistRunService, StrixSpecialistEngine } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 6D — the specialist (Strix) API. Reads come from persisted state. Requesting a run only enqueues a
 * durable worker job after Audivra authorizes the Audivra-constructed target set. There is NO endpoint for
 * raw CLI flags, instructions, provider secrets or Docker options — the only input is a typed scope + mode.
 */
export function registerSpecialistRoutes(app: App, deps: { db: Db; boss: PgBoss; log?: Logger }): void {
  const read = new SpecialistReadService({ db: deps.db })
  const broker = createDurableBroker({ db: deps.db, boss: deps.boss, log: deps.log })
  const service = new SpecialistRunService({ db: deps.db, broker, engines: { strix: new StrixSpecialistEngine() }, boss: deps.boss, log: deps.log })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/specialist/availability', (request, reply) => respond(reply, () => service.availability()))

  // Request a specialist run (enqueues a durable job). The request carries only a typed scope + mode.
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/specialist/runs', (request, reply) =>
    respond(reply, () => service.request(request.params.id, RequestSpecialistRunInput.parse(request.body ?? {})), 202),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/specialist/runs', (request, reply) => respond(reply, () => read.listRuns(request.params.id)))

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/specialist/coverage', (request, reply) => respond(reply, () => read.coverage(request.params.id)))

  app.get<{ Params: { runId: string } }>('/api/security/specialist/runs/:runId', (request, reply) => respond(reply, () => read.getRun(request.params.runId)))

  app.post<{ Params: { runId: string } }>('/api/security/specialist/runs/:runId/cancel', (request, reply) => respond(reply, () => service.cancel(request.params.runId)))
}
