import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, type PathState } from '@audivra/contracts'
import { enqueueSecurityAttackPath, type Db, type PgBoss } from '@audivra/database'
import { AttackPathReadService, ATTACK_PATH_EXPORT_KINDS, generateAttackPathExport, SecurityRequestError, type AttackPathExportKind } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 6B: evidence-backed attack paths, their steps, coverage, the report and exports. Every read is built
 * from persisted state only — no endpoint re-runs discovery, the AI or a capability, and there is no path
 * execution or arbitrary graph query. The one write queues a deterministic, idempotent analysis for the
 * worker; the request carries no capability, input or command.
 */
export function registerAttackPathRoutes(app: App, deps: { db: Db; boss: PgBoss }): void {
  const read = new AttackPathReadService({ db: deps.db })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  // Queue an attack-path analysis (discover → validate → synthesize). No-op while one is already queued.
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/attack-paths/analyze', (request, reply) =>
    respond(reply, async () => ({ queued: (await enqueueSecurityAttackPath(deps.boss, request.params.id)) !== null }), 202),
  )

  app.get<{ Params: { id: string }; Querystring: { state?: PathState; includeDominated?: string } }>('/api/security/engagements/:id/attack-paths', (request, reply) =>
    respond(reply, () => read.listPaths(request.params.id, { state: request.query.state, includeDominated: request.query.includeDominated === 'true' })),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/attack-paths/coverage', (request, reply) => respond(reply, () => read.coverage(request.params.id)))

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/attack-paths/report', (request, reply) => respond(reply, () => read.report(request.params.id)))

  app.get<{ Params: { id: string; kind: string } }>('/api/security/engagements/:id/attack-paths/export/:kind', async (request, reply) => {
    const kind = request.params.kind as AttackPathExportKind
    if (!ATTACK_PATH_EXPORT_KINDS.includes(kind)) return reply.status(400).send({ error: `Unknown export kind ${request.params.kind}` })
    try {
      const out = await generateAttackPathExport(read, request.params.id, kind)
      return reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="${out.filename}"`).send(out.body)
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  })

  app.get<{ Params: { pathId: string } }>('/api/security/attack-paths/:pathId', (request, reply) => respond(reply, () => read.getPath(request.params.pathId)))
}
