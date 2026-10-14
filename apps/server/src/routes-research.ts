import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, CreateResearchRunInput } from '@audivra/contracts'
import { type Db, type PgBoss } from '@audivra/database'
import { createDurableBroker, ResearchReadService, ResearchService, SecurityRequestError } from '@audivra/security'
import { createProviderRegistry, createProviderRouter, createReasoningAi } from '@audivra/ai-runtime'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 6E — the autonomous research-run API. Reads come from persisted state. Creating/starting a run only
 * enqueues a durable worker job; there is NO endpoint for arbitrary prompt execution, raw capabilities,
 * flags or budget beyond the typed mode/objective. The orchestrator owns no authority — the broker/policy do.
 */
export function registerResearchRoutes(app: App, deps: { db: Db; boss: PgBoss; log?: Logger }): void {
  const read = new ResearchReadService({ db: deps.db })
  const broker = createDurableBroker({ db: deps.db, boss: deps.boss, log: deps.log })
  const ai = createReasoningAi(createProviderRouter(createProviderRegistry()))
  const service = new ResearchService({ db: deps.db, broker, ai, boss: deps.boss, log: deps.log })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/research/runs', (request, reply) => respond(reply, () => service.create(request.params.id, CreateResearchRunInput.parse(request.body ?? {})), 201))

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/research/runs', (request, reply) => respond(reply, () => read.listRuns(request.params.id)))

  app.get<{ Params: { runId: string } }>('/api/security/research/runs/:runId', (request, reply) => respond(reply, () => read.getRun(request.params.runId)))

  app.post<{ Params: { runId: string } }>('/api/security/research/runs/:runId/start', (request, reply) => respond(reply, () => service.start(request.params.runId), 202))
  app.post<{ Params: { runId: string } }>('/api/security/research/runs/:runId/pause', (request, reply) => respond(reply, () => service.pause(request.params.runId)))
  app.post<{ Params: { runId: string } }>('/api/security/research/runs/:runId/resume', (request, reply) => respond(reply, () => service.resume(request.params.runId), 202))
  app.post<{ Params: { runId: string } }>('/api/security/research/runs/:runId/cancel', (request, reply) => respond(reply, () => service.cancel(request.params.runId)))
}
