import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, AnalystDecisionInput, PlanRetestsInput, RequestRetestInput } from '@audivra/contracts'
import { enqueueSecurityRetest, type Db, type PgBoss } from '@audivra/database'
import {
  ComparisonEngine,
  createDurableBroker,
  createRuntimeRegistry,
  generateHistoryExport,
  HistoryReadService,
  HistoryService,
  HISTORY_EXPORT_KINDS,
  RetestService,
  SecurityRequestError,
  type HistoryExportKind,
} from '@audivra/security'
import { createProviderRegistry, createProviderRouter, createReasoningAi } from '@audivra/ai-runtime'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 6C — retesting and historical comparison. Reads are built from persisted state. The one capability-
 * bearing action (running a retest) only ENQUEUES a durable worker job carrying the retest-case id and the
 * target assessment — it runs no capability in the request path and never asserts a fix without evidence.
 * There is no arbitrary capability-execution endpoint.
 */
export function registerHistoryRoutes(app: App, deps: { db: Db; boss: PgBoss; log?: Logger }): void {
  const read = new HistoryReadService({ db: deps.db, log: deps.log })
  const history = new HistoryService({ db: deps.db, log: deps.log })
  const registry = createRuntimeRegistry()
  const ai = createReasoningAi(createProviderRouter(createProviderRegistry()))
  const broker = createDurableBroker({ db: deps.db, boss: deps.boss, registry, log: deps.log })
  const comparisonEngine = new ComparisonEngine({ db: deps.db, broker, log: deps.log })
  const retest = new RetestService({ db: deps.db, comparisonEngine, registry, ai, log: deps.log })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  // ── Retest cases & execution ───────────────────────────────────────────────────────────────────────

  // Build retest cases for the findings of a previous assessment (does not run them).
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/retests/plan', (request, reply) =>
    respond(reply, () => {
      const input = PlanRetestsInput.parse(request.body ?? {})
      return retest.planRetests(input.previousEngagementId, { eligibleOnly: input.eligibleOnly })
    }),
  )

  // Ensure a retest case for a finding and queue its replay against this (target) assessment.
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/retests', (request, reply) =>
    respond(
      reply,
      async () => {
        const input = RequestRetestInput.parse(request.body ?? {})
        const testCase = await retest.ensureCase(input.findingId)
        const targetEngagementId = input.targetEngagementId ?? request.params.id
        const queued = (await enqueueSecurityRetest(deps.boss, { retestCaseId: testCase.id, targetEngagementId, allowAdaptation: input.allowAdaptation })) !== null
        return { retestCaseId: testCase.id, eligibility: testCase.eligibility, queued }
      },
      202,
    ),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/retests/cases', (request, reply) => respond(reply, () => read.listRetestCases(request.params.id)))

  app.get<{ Params: { id: string }; Querystring: { issueKey?: string; findingId?: string } }>('/api/security/engagements/:id/retests/results', (request, reply) =>
    respond(reply, () => read.listRetestResults(request.params.id, { issueKey: request.query.issueKey, findingId: request.query.findingId })),
  )

  app.get<{ Params: { resultId: string } }>('/api/security/retests/:resultId', (request, reply) => respond(reply, () => read.getRetestResult(request.params.resultId)))

  // ── Finding lineage ────────────────────────────────────────────────────────────────────────────────

  app.get<{ Params: { findingId: string } }>('/api/security/findings/:findingId/history', (request, reply) => respond(reply, () => read.findingLineage(request.params.findingId)))

  // ── Assessment comparison ──────────────────────────────────────────────────────────────────────────

  // Compute + persist a comparison of a previous assessment against this (current) one.
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/history/compare', (request, reply) =>
    respond(reply, () => {
      const body = (request.body ?? {}) as { previousEngagementId?: string; persist?: boolean }
      if (!body.previousEngagementId) throw new SecurityRequestError(400, 'previousEngagementId is required')
      return history.compareAssessments(body.previousEngagementId, request.params.id, { persist: body.persist !== false })
    }),
  )

  app.get<{ Params: { id: string }; Querystring: { previous?: string } }>('/api/security/engagements/:id/history/comparison', (request, reply) =>
    respond(reply, () => {
      if (!request.query.previous) throw new SecurityRequestError(400, 'previous query parameter is required')
      return read.assessmentComparison(request.query.previous, request.params.id)
    }),
  )

  app.get<{ Params: { id: string }; Querystring: { previous?: string } }>('/api/security/engagements/:id/history/report', (request, reply) =>
    respond(reply, () => {
      if (!request.query.previous) throw new SecurityRequestError(400, 'previous query parameter is required')
      return read.report(request.query.previous, request.params.id)
    }),
  )

  app.get<{ Params: { id: string; kind: string }; Querystring: { previous?: string } }>('/api/security/engagements/:id/history/export/:kind', async (request, reply) => {
    const kind = request.params.kind as HistoryExportKind
    if (!HISTORY_EXPORT_KINDS.includes(kind)) return reply.status(400).send({ error: `Unknown export kind ${request.params.kind}` })
    if (!request.query.previous) return reply.status(400).send({ error: 'previous query parameter is required' })
    try {
      const out = await generateHistoryExport(read, request.query.previous, request.params.id, kind)
      return reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="${out.filename}"`).send(out.body)
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  })

  // ── Analyst decisions (manual overrides with an audit trail) ─────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/history/decisions', (request, reply) =>
    respond(reply, () => read.recordAnalystDecision(request.params.id, AnalystDecisionInput.parse(request.body ?? {})), 201),
  )

  app.get<{ Params: { id: string }; Querystring: { subjectRef?: string } }>('/api/security/engagements/:id/history/decisions', (request, reply) =>
    respond(reply, () => read.listAnalystDecisions(request.params.id, request.query.subjectRef)),
  )
}
