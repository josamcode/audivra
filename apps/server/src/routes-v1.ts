import { createReadStream } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { promptVersions } from '@audivra/ai-runtime'
import { getConfig, type Logger } from '@audivra/config'
import { ExportKind, type OwnedProcessItem } from '@audivra/contracts'
import {
  enqueueStage,
  getAuditRow,
  listArtifacts,
  listBenchmarkRuns,
  processStore,
  QUEUES,
  recordEvent,
  startBenchmarkRun,
  updateAudit,
  updateStep,
  type Db,
  type PgBoss,
} from '@audivra/database'
import { buildComparison, buildSiteHistory, loadClientReport } from '@audivra/insights'
import { artifactImage, generateExport, listExports } from '@audivra/reporting'

interface Deps {
  db: Db
  boss: PgBoss
}

const FINISHED = new Set(['completed', 'partial'])

/** Visual artifacts, client report, comparison/history, exports, benchmarks and process transparency. */
type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

export function registerV1Routes(app: App, { db, boss }: Deps): void {
  app.get<{ Params: { id: string } }>('/api/audits/:id/visuals', async (request, reply) => {
    const row = await getAuditRow(db, request.params.id)
    if (!row) return reply.status(404).send({ error: 'Audit not found' })
    return listArtifacts(db, row.id)
  })

  app.get<{ Params: { id: string; file: string } }>('/api/audits/:id/visuals/:file', async (request, reply) => {
    const match = request.params.file.match(/^(A\d+)\.(png|svg)$/)
    if (!match) return reply.status(404).send({ error: 'Use <ref>.png or <ref>.svg' })
    const [, ref, format] = match as unknown as [string, string, 'png' | 'svg']
    try {
      const output = await artifactImage(db, request.params.id, ref, format)
      if (output === null) {
        return reply.status(404).send({ error: format === 'svg' ? 'This artifact type has no vector export' : 'Artifact not found' })
      }
      const download = (request.query as { download?: string }).download === '1'
      if (download) void reply.header('Content-Disposition', `attachment; filename="${ref}.${format}"`)
      return reply.type(format === 'png' ? 'image/png' : 'image/svg+xml; charset=utf-8').send(output)
    } catch (error) {
      request.log.warn({ err: error }, 'artifact render failed')
      return reply.status(503).send({ error: `Rendering failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  })

  /** Re-runs the presenting stage (Artifact Planner + Report Composer) for a finished audit. */
  app.post<{ Params: { id: string } }>('/api/audits/:id/present', async (request, reply) => {
    const row = await getAuditRow(db, request.params.id)
    if (!row) return reply.status(404).send({ error: 'Audit not found' })
    if (!FINISHED.has(row.status)) return reply.status(409).send({ error: 'The audit has not finished yet' })
    await updateStep(db, row.id, 'presenting', 'pending', { message: 'Queued', error: null })
    await updateAudit(db, row.id, { stage: 'presenting' })
    await recordEvent(db, { auditId: row.id, type: 'stage.started', message: 'Visual report generation queued', data: { stage: 'presenting' } })
    await enqueueStage(boss, QUEUES.present, row.id)
    return reply.status(202).send({ queued: true })
  })

  app.get<{ Params: { id: string } }>('/api/audits/:id/report', async (request, reply) => {
    const loaded = await loadClientReport(db, request.params.id)
    return loaded ? loaded.report : reply.status(404).send({ error: 'Audit not found' })
  })

  app.get<{ Params: { id: string }; Querystring: { with?: string } }>('/api/audits/:id/comparison', async (request, reply) => {
    const comparison = await buildComparison(db, request.params.id, request.query.with || undefined)
    return comparison ?? reply.status(404).send({ error: 'No earlier finished audit of this site to compare with' })
  })

  app.get<{ Params: { siteKey: string }; Querystring: { benchmark?: string } }>('/api/sites/:siteKey/history', async (request) =>
    buildSiteHistory(db, decodeURIComponent(request.params.siteKey).toLowerCase(), { benchmark: request.query.benchmark === '1' }),
  )

  app.get<{ Params: { id: string } }>('/api/audits/:id/exports', async (request, reply) => {
    const items = await listExports(db, request.params.id)
    return items ?? reply.status(404).send({ error: 'Audit not found' })
  })

  app.get<{ Params: { id: string; kind: string } }>('/api/audits/:id/export/:kind', async (request, reply) => {
    const kind = ExportKind.safeParse(request.params.kind)
    if (!kind.success) return reply.status(400).send({ error: 'Unknown export kind' })
    const row = await getAuditRow(db, request.params.id)
    if (!row) return reply.status(404).send({ error: 'Audit not found' })
    if (!FINISHED.has(row.status)) return reply.status(409).send({ error: 'Exports are available when the audit has finished' })
    try {
      const generated = await generateExport(db, row.id, kind.data)
      if (!generated) return reply.status(404).send({ error: 'Nothing to export for this audit' })
      void reply.header('Content-Disposition', `attachment; filename="${generated.filename}"`)
      return reply.type(generated.contentType).send(createReadStream(generated.file))
    } catch (error) {
      request.log.warn({ err: error, kind: kind.data }, 'export failed')
      return reply.status(503).send({ error: `Export failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  })

  app.get('/api/benchmarks', async () => listBenchmarkRuns(db))

  app.post('/api/benchmarks', async (_request, reply) => {
    const running = (await listBenchmarkRuns(db, 5)).find((r) => r.status === 'running')
    if (running) return reply.status(409).send({ error: 'A benchmark is already running', id: running.id })
    // The run row exists immediately (with the prompt versions it will measure); the worker fills it in.
    const id = await startBenchmarkRun(db, { model: getConfig().AUDITOR_MODEL ?? null, promptVersions: promptVersions() })
    const jobId = await boss.send(QUEUES.benchmark, { benchmarkRunId: id })
    return reply.status(202).send({ queued: true, id, jobId })
  })

  app.get('/api/system/processes', async (): Promise<OwnedProcessItem[]> => {
    const rows = await processStore.listRecent(db, 150)
    return rows.map((r) => ({
      id: r.id,
      pid: r.pid,
      tool: r.tool,
      auditId: r.auditId,
      status: r.status,
      command: r.command,
      containerName: r.containerName,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      exitCode: r.exitCode,
    }))
  })
}
