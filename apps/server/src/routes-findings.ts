import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, type FindingCategory, type FindingStatus, type VerificationState } from '@audivra/contracts'
import { enqueueSecurityVerification, type Db, type PgBoss } from '@audivra/database'
import { FindingReadService, FINDING_EXPORT_KINDS, generateFindingExport, SecurityRequestError, type FindingExportKind } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 6A: verified security findings, their candidates, coverage, the assessment report and exports. Every
 * read is built from persisted state only — no endpoint re-runs the AI or a capability, and no export
 * regenerates anything. The one write queues a verification pass for the worker (deterministic + idempotent);
 * the request carries no capability, input or command.
 */
export function registerFindingRoutes(app: App, deps: { db: Db; boss: PgBoss }): void {
  const read = new FindingReadService({ db: deps.db })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  // Queue a verification pass (candidate generation → verification → finding synthesis). No-op if one is queued.
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/verify', (request, reply) =>
    respond(reply, async () => ({ queued: (await enqueueSecurityVerification(deps.boss, request.params.id)) !== null }), 202),
  )

  app.get<{ Params: { id: string }; Querystring: { category?: FindingCategory; status?: FindingStatus; verificationState?: VerificationState } }>('/api/security/engagements/:id/findings', (request, reply) =>
    respond(reply, () => read.listFindings(request.params.id, { category: request.query.category, status: request.query.status, verificationState: request.query.verificationState })),
  )

  app.get<{ Params: { id: string }; Querystring: { status?: VerificationState } }>('/api/security/engagements/:id/findings/candidates', (request, reply) =>
    respond(reply, () => read.listCandidates(request.params.id, { status: request.query.status })),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/findings/coverage', (request, reply) => respond(reply, () => read.coverage(request.params.id)))

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/findings/report', (request, reply) => respond(reply, () => read.report(request.params.id)))

  // Exports: generated on demand from persisted findings (JSON or CSV); never re-runs the AI.
  app.get<{ Params: { id: string; kind: string } }>('/api/security/engagements/:id/findings/export/:kind', async (request, reply) => {
    const kind = request.params.kind as FindingExportKind
    if (!FINDING_EXPORT_KINDS.includes(kind)) return reply.status(400).send({ error: `Unknown export kind ${request.params.kind}` })
    try {
      const out = await generateFindingExport(read, request.params.id, kind)
      return reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="${out.filename}"`).send(out.body)
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  })

  app.get<{ Params: { findingId: string } }>('/api/security/findings/:findingId', (request, reply) => respond(reply, () => read.getFinding(request.params.findingId)))
}
