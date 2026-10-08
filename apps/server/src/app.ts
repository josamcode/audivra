import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { LogController, type FastifyError } from 'fastify'
import { auditWorkspaceDir, getConfig, REPO_ROOT, resolveInside, type Logger } from '@audivra/config'
import { CreateAuditInput, getTemplate, normalizeTargetUrl, type AuditStage, type SystemHealth } from '@audivra/contracts'
import {
  createAuditRecord,
  enqueueStage,
  getAuditDetail,
  getAuditRow,
  getEvidence,
  listAgentRuns,
  listAudits,
  listEvents,
  listEvidence,
  listFindings,
  listPages,
  listSteps,
  listToolRuns,
  pingDb,
  QUEUES,
  recordEvent,
  updateAudit,
  updateStep,
  WORKER_INSTANCE,
  type Db,
  type PgBoss,
  type QueueName,
} from '@audivra/database'
import { getSystemStatus } from '@audivra/tool-runtime'
import { loadAuditData, loadDashboard } from '@audivra/insights'
import type { EventHub } from './events-hub.ts'
import { registerIntelligenceRoutes } from './routes-intelligence.ts'
import { registerV1Routes } from './routes-v1.ts'

export interface AppDeps {
  db: Db
  boss: PgBoss
  hub: EventHub | null
  log: Logger
  /** Serve the built web app (production `start`). */
  serveWeb?: boolean
}

const STAGE_QUEUES: Partial<Record<AuditStage, QueueName>> = {
  preparing: QUEUES.baseline,
  baseline: QUEUES.baseline,
  investigation: QUEUES.investigation,
  review: QUEUES.review,
  revision: QUEUES.revision,
  finalizing: QUEUES.finalize,
  presenting: QUEUES.present,
}

/** `send` rejects backslash separators (Windows), so relative file paths are converted to forward slashes. */
const toUrlPath = (relative: string) => relative.split(path.sep).join('/')

export async function buildApp(deps: AppDeps) {
  const { db, boss, hub } = deps
  const app = Fastify({
    loggerInstance: deps.log.child({ component: 'http' }),
    logController: new LogController({ disableRequestLogging: true }),
  })

  await app.register(fastifyStatic, {
    root: path.join(REPO_ROOT, 'apps', 'web', 'dist'),
    serve: false,
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    void reply.status(status).send({ error: status >= 500 ? 'Internal server error' : error.message })
  })

  app.get('/api/health', async () => ({ ok: true }))

  app.get<{ Querystring: { refresh?: string } }>('/api/system/tools', async (request) =>
    getSystemStatus({ refresh: request.query.refresh === '1' }),
  )

  /** Liveness of the database and of the worker that consumes the audit queues (pg-boss instance registry). */
  app.get('/api/system/health', async (): Promise<SystemHealth> => {
    let database: SystemHealth['database']
    try {
      database = { ok: true, latencyMs: await pingDb(db), error: null }
    } catch (error) {
      database = { ok: false, latencyMs: null, error: error instanceof Error ? error.message : String(error) }
    }
    let engine: SystemHealth['engine'] = { state: 'unknown', workers: 0, activeJobs: 0, lastHeartbeatAt: null }
    if (database.ok) {
      try {
        const auditQueues = new Set<string>(Object.values(QUEUES))
        // The worker names its instance; its subscriptions only appear in the registry at the first heartbeat.
        const instances = (await boss.getInstances()).filter(
          (instance) => instance.name === WORKER_INSTANCE || instance.workers.some((worker) => auditQueues.has(worker.queue)),
        )
        const live = instances.filter((instance) => instance.live)
        const workers = live.flatMap((instance) => instance.workers.filter((worker) => auditQueues.has(worker.queue)))
        const lastHeartbeat = Math.max(0, ...instances.map((instance) => new Date(instance.heartbeatOn).getTime()))
        engine = {
          state: live.length ? 'running' : 'stopped',
          workers: live.length,
          activeJobs: workers.reduce((sum, worker) => sum + worker.active, 0),
          lastHeartbeatAt: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
        }
      } catch {
        // Registry unreadable: report "unknown" rather than guessing.
      }
    }
    return { checkedAt: new Date().toISOString(), database, engine }
  })

  app.get('/api/audits', async () => listAudits(db))

  /** Aggregates for the Audits home screen. Benchmark audits are excluded unless `?benchmark=1`. */
  app.get<{ Querystring: { benchmark?: string } }>('/api/dashboard', async (request) =>
    loadDashboard(db, { includeBenchmarks: request.query.benchmark === '1' }),
  )

  app.post('/api/audits', async (request, reply) => {
    const parsed = CreateAuditInput.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    }
    const target = normalizeTargetUrl(parsed.data.url)
    if (!target.ok) return reply.status(400).send({ error: target.error })
    const aiEnabled = getConfig().AUDIVRA_AI === 'claude'
    const template = getTemplate(parsed.data.template)
    const row = await createAuditRecord(db, {
      url: parsed.data.url,
      normalizedUrl: target.url,
      domain: target.domain,
      clientName: parsed.data.clientName ?? null,
      aiEnabled,
      template: { key: template.key, version: template.version },
    })
    await recordEvent(db, {
      auditId: row.id,
      type: 'audit.created',
      message: `Audit created for ${target.url} · focus: ${template.name}`,
      data: { url: target.url, aiEnabled, template: template.key },
    })
    await enqueueStage(boss, QUEUES.baseline, row.id)
    return reply.status(201).send(await getAuditDetail(db, row.id))
  })

  app.get<{ Params: { id: string } }>('/api/audits/:id', async (request, reply) => {
    const detail = await getAuditDetail(db, request.params.id)
    if (!detail) return reply.status(404).send({ error: 'Audit not found' })
    // Audits from before explicit coverage existed get it computed (and stored) on first read.
    if (detail.coverage.length === 0 && ['completed', 'partial', 'failed', 'cancelled'].includes(detail.status)) {
      const data = await loadAuditData(db, detail.id)
      if (data) detail.coverage = data.coverage
    }
    return detail
  })

  app.post<{ Params: { id: string } }>('/api/audits/:id/cancel', async (request, reply) => {
    const row = await getAuditRow(db, request.params.id)
    if (!row) return reply.status(404).send({ error: 'Audit not found' })
    if (row.status !== 'queued' && row.status !== 'running') {
      return reply.status(409).send({ error: `Audit is already ${row.status}` })
    }
    if (row.status === 'queued') {
      await updateAudit(db, row.id, { status: 'cancelled', cancelRequested: true, finishedAt: new Date() })
      await recordEvent(db, {
        auditId: row.id,
        type: 'audit.cancelled',
        message: 'Audit cancelled before it started',
      })
    } else {
      await updateAudit(db, row.id, { cancelRequested: true })
      await recordEvent(db, {
        auditId: row.id,
        type: 'audit.cancelled',
        level: 'warn',
        message: 'Cancellation requested',
      })
    }
    return getAuditDetail(db, row.id)
  })

  /** Re-runs an audit from its first failed stage, preserving everything collected so far. */
  app.post<{ Params: { id: string } }>('/api/audits/:id/retry', async (request, reply) => {
    const row = await getAuditRow(db, request.params.id)
    if (!row) return reply.status(404).send({ error: 'Audit not found' })
    if (row.status !== 'failed' && row.status !== 'partial') {
      return reply.status(409).send({ error: 'Only failed or partial audits can be retried' })
    }
    const steps = await listSteps(db, row.id)
    const failed = steps.find((s) => s.status === 'failed')
    const queue = failed ? STAGE_QUEUES[failed.stage] : undefined
    if (!failed || !queue) return reply.status(409).send({ error: 'No failed stage to retry' })
    const order = steps.map((s) => s.stage)
    for (const step of steps.slice(order.indexOf(failed.stage))) {
      await updateStep(db, row.id, step.stage, 'pending', { message: null, error: null })
    }
    await updateAudit(db, row.id, {
      status: 'running',
      stage: failed.stage,
      error: null,
      finishedAt: null,
      cancelRequested: false,
      aiEnabled: getConfig().AUDIVRA_AI === 'claude' || row.aiEnabled,
    })
    await recordEvent(db, {
      auditId: row.id,
      type: 'stage.started',
      message: `Retrying from ${failed.stage}`,
    })
    await enqueueStage(boss, queue, row.id)
    return getAuditDetail(db, row.id)
  })

  app.get<{ Params: { id: string } }>('/api/audits/:id/findings', async (request) =>
    listFindings(db, request.params.id),
  )

  app.get<{ Params: { id: string } }>('/api/audits/:id/evidence', async (request) => {
    const items = await listEvidence(db, request.params.id)
    // Keep the list light: large metadata is fetched per item.
    return items.map((item) => {
      const size = JSON.stringify(item.metadata).length
      return size > 4000 ? { ...item, metadata: { truncated: true, size } } : item
    })
  })

  app.get<{ Params: { id: string; ref: string } }>(
    '/api/audits/:id/evidence/:ref',
    async (request, reply) => {
      const item = await getEvidence(db, request.params.id, request.params.ref)
      return item ?? reply.status(404).send({ error: 'Evidence not found' })
    },
  )

  app.get<{ Params: { id: string } }>('/api/audits/:id/pages', async (request) =>
    listPages(db, request.params.id),
  )
  app.get<{ Params: { id: string } }>('/api/audits/:id/tool-runs', async (request) =>
    listToolRuns(db, request.params.id),
  )
  app.get<{ Params: { id: string } }>('/api/audits/:id/agent-runs', async (request) =>
    listAgentRuns(db, request.params.id),
  )
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/audits/:id/events',
    async (request) =>
      listEvents(db, request.params.id, {
        afterId: request.query.after ? Number(request.query.after) : undefined,
      }),
  )

  app.get<{ Params: { id: string; '*': string } }>('/api/audits/:id/artifacts/*', async (request, reply) => {
    let root: string
    try {
      root = auditWorkspaceDir(request.params.id)
    } catch {
      return reply.status(400).send({ error: 'Invalid audit id' })
    }
    const file = resolveInside(root, request.params['*'])
    if (!file || !existsSync(file)) return reply.status(404).send({ error: 'Artifact not found' })
    const download = (request.query as { download?: string }).download === '1'
    if (download) void reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`)
    return reply.sendFile(toUrlPath(path.relative(root, file)), root, { dotfiles: 'deny' })
  })

  /** Live activity stream. Replays events after Last-Event-ID / ?after= then streams new ones. */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/audits/:id/stream',
    async (request, reply) => {
      const row = await getAuditRow(db, request.params.id)
      if (!row) return reply.status(404).send({ error: 'Audit not found' })
      if (!hub) return reply.status(503).send({ error: 'Live events unavailable' })
      const header = request.headers['last-event-id']
      const after = Number((Array.isArray(header) ? header[0] : header) ?? request.query.after ?? 0) || 0

      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      const unsubscribe = hub.subscribe(row.id, after, (event) => {
        res.write(`id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`)
      })
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
      request.raw.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
    },
  )

  registerV1Routes(app, { db, boss })
  registerIntelligenceRoutes(app, { db, boss })

  if (deps.serveWeb && existsSync(path.join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html'))) {
    app.get('/*', async (request, reply) => {
      const urlPath = request.url.split('?')[0] ?? '/'
      const root = path.join(REPO_ROOT, 'apps', 'web', 'dist')
      const file = urlPath !== '/' ? resolveInside(root, urlPath.slice(1)) : null
      if (file && existsSync(file)) return reply.sendFile(toUrlPath(path.relative(root, file)))
      return reply.sendFile('index.html')
    })
  }

  return app
}
