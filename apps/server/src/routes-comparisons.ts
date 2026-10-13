import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, type ComparisonDimension, type ComparisonResult } from '@audivra/contracts'
import { enqueueSecurityComparison, type Db, type PgBoss } from '@audivra/database'
import { ComparisonEngine, ComparisonService, createDurableBroker, LOCAL_USER, SecurityRequestError } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 5 Step 4: differential authorization / business-logic comparisons. The API validates and persists a
 * plan and queues it for the worker (which runs it through the Capability Broker); it proposes useful
 * comparisons deterministically; and it reads comparisons, their evidence, invariant evaluations and
 * authorization/business coverage. There is NO endpoint that runs an arbitrary request — a comparison only
 * ever runs the two reviewed identity-aware capabilities, decided by the broker.
 */
export function registerComparisonRoutes(app: App, deps: { db: Db; boss: PgBoss; log?: Logger }): void {
  const engine = new ComparisonEngine({ db: deps.db, broker: createDurableBroker({ db: deps.db, boss: deps.boss, log: deps.log }), log: deps.log })
  const service = new ComparisonService({ db: deps.db, engine, log: deps.log })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  // Plan + persist a comparison, then queue it for the worker to execute. The AI never reaches this path.
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/comparisons', (request, reply) =>
    respond(
      reply,
      async () => {
        const comparison = await service.plan(request.params.id, request.body, LOCAL_USER)
        if (comparison.status !== 'blocked') await enqueueSecurityComparison(deps.boss, comparison.id)
        return comparison
      },
      201,
    ),
  )

  // Deterministically propose a bounded, ranked set of useful comparisons (no AI, no execution).
  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/comparisons/propose', (request, reply) => respond(reply, () => service.propose(request.params.id)))

  app.get<{ Params: { id: string }; Querystring: { dimension?: ComparisonDimension; result?: ComparisonResult } }>('/api/security/engagements/:id/comparisons', (request, reply) =>
    respond(reply, () => service.list(request.params.id, { dimension: request.query.dimension, result: request.query.result })),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/comparisons/coverage', (request, reply) => respond(reply, () => service.coverage(request.params.id)))

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/comparisons/invariants', (request, reply) => respond(reply, () => service.invariants(request.params.id)))

  app.get<{ Params: { comparisonId: string } }>('/api/security/comparisons/:comparisonId', (request, reply) => respond(reply, () => service.get(request.params.comparisonId)))
}
