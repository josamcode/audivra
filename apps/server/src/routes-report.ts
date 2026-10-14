import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, SECURITY_REPORT_EXPORT_KINDS, type SecurityReportAudience, type SecurityReportExportKind, type ToolVersionStatus } from '@audivra/contracts'
import { type Db } from '@audivra/database'
import { createSecurityReportService, generateSecurityReportExport, sensorRuntimeStatuses, SecurityRequestError } from '@audivra/security'
import { reasoningPromptVersions } from '@audivra/ai-runtime'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 6F — the combined client-facing Security Assessment report. Composed from stored per-area reports
 * with no AI re-run; records the exact Audivra/policy/prompt/tool versions; exports to JSON and self-contained
 * HTML. Secret-safe (built from redacted state, enforced by the canary export test).
 */
export function registerReportRoutes(app: App, deps: { db: Db }): void {
  const service = createSecurityReportService(deps.db)

  async function versions() {
    const tools: ToolVersionStatus[] = (await sensorRuntimeStatuses().catch(() => [])).map((t) => ({ name: t.name, approved: t.version ?? null, installed: t.state === 'ready' ? (t.version ?? null) : null, state: t.state === 'ready' ? 'ready' : t.state === 'unavailable' ? 'unavailable' : 'needs-setup', match: t.state === 'ready' }))
    return { promptVersions: reasoningPromptVersions(), tools }
  }

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  app.get<{ Params: { id: string }; Querystring: { previous?: string; audience?: SecurityReportAudience } }>('/api/security/engagements/:id/report', (request, reply) =>
    respond(reply, async () => service.build(request.params.id, { previousEngagementId: request.query.previous ?? null, ...(await versions()) })),
  )

  app.get<{ Params: { id: string; kind: string }; Querystring: { previous?: string; audience?: SecurityReportAudience } }>('/api/security/engagements/:id/report/export/:kind', async (request, reply) => {
    const kind = request.params.kind as SecurityReportExportKind
    if (!SECURITY_REPORT_EXPORT_KINDS.includes(kind)) return reply.status(400).send({ error: `Unknown report export kind ${request.params.kind}` })
    try {
      const out = await generateSecurityReportExport(service, request.params.id, kind, { previousEngagementId: request.query.previous ?? null, audience: request.query.audience, ...(await versions()) })
      return reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="${out.filename}"`).send(out.body)
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  })
}
