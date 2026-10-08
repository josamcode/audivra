import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { getConfig, type Logger } from '@audivra/config'
import type { AuditBrief, AuditChanges, AuditJourneys, EnrichmentStatus } from '@audivra/contracts'
import {
  enqueueEnrich,
  getAuditRow,
  getChangeReport,
  getClientBrief,
  hasPendingEnrichJob,
  latestAgentRun,
  listFindings,
  listJourneys,
  type AuditRow,
  type Db,
  type EnrichKind,
  type PgBoss,
} from '@audivra/database'
import { buildAuditTimelines, buildComparison, buildEvidenceGraph, loadGraphInput } from '@audivra/insights'

interface Deps {
  db: Db
  boss: PgBoss
}

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

const finished = (audit: AuditRow) => audit.status === 'completed' || audit.status === 'partial'

/**
 * Whether an on-demand intelligence job can run for this audit and whether one is in flight. A job
 * counts as running from the moment it is queued until its AI run ends.
 */
async function enrichmentStatus(
  db: Db,
  audit: AuditRow,
  kind: EnrichKind,
  result: { createdAt: string } | null,
  extra?: { unavailable: string | null },
): Promise<EnrichmentStatus> {
  const [pending, latest] = await Promise.all([hasPendingEnrichJob(db, audit.id, kind), latestAgentRun(db, audit.id, kind)])
  const running = pending || latest?.status === 'running'
  const failedAfterResult =
    latest?.status === 'failed' && (!result || (latest.finishedAt ?? latest.startedAt).getTime() > new Date(result.createdAt).getTime())
  let reason: string | null = null
  if (!finished(audit)) reason = 'Available once the audit has finished.'
  else if (!audit.aiEnabled) reason = 'This audit ran without AI (baseline only).'
  else if (getConfig().AUDIVRA_AI !== 'claude') reason = 'AI is turned off (AUDIVRA_AI=off).'
  else if (extra?.unavailable) reason = extra.unavailable
  return {
    running,
    lastError: failedAfterResult ? (latest?.error ?? 'The last attempt failed') : null,
    lastCompletedAt: latest?.status === 'completed' && latest.finishedAt ? latest.finishedAt.toISOString() : null,
    available: reason === null,
    reason,
  }
}

export function registerIntelligenceRoutes(app: App, { db, boss }: Deps): void {
  /** Journeys of an audit with the state of journey analysis (for audits from before journeys). */
  app.get<{ Params: { id: string } }>('/api/audits/:id/journeys', async (request, reply): Promise<AuditJourneys | void> => {
    const audit = await getAuditRow(db, request.params.id)
    if (!audit) return reply.status(404).send({ error: 'Audit not found' })
    const journeys = await listJourneys(db, audit.id)
    const findings = journeys.length ? [] : await listFindings(db, audit.id)
    const status = await enrichmentStatus(db, audit, 'journeys', journeys[0] ?? null, {
      unavailable: !journeys.length && findings.length === 0 ? 'Journey analysis needs the findings of an AI audit.' : null,
    })
    return { journeys, status }
  })

  app.post<{ Params: { id: string } }>('/api/audits/:id/journeys', async (request, reply) => {
    return queue(request.params.id, 'journeys', reply)
  })

  /** Evidence graph around one node: finding:F3, evidence:EV-12, journey:J1, page:<url>, artifact:A2. */
  app.get<{ Params: { id: string }; Querystring: { focus?: string; depth?: string } }>('/api/audits/:id/graph', async (request, reply) => {
    const audit = await getAuditRow(db, request.params.id)
    if (!audit) return reply.status(404).send({ error: 'Audit not found' })
    if (!request.query.focus) return reply.status(400).send({ error: 'focus is required, e.g. ?focus=finding:F1' })
    const depth = Number(request.query.depth ?? 2)
    const graph = buildEvidenceGraph(await loadGraphInput(db, audit.id), request.query.focus, Number.isFinite(depth) ? depth : 2)
    return graph ?? reply.status(404).send({ error: `Nothing to show for ${request.query.focus}` })
  })

  /** What changed: the deterministic comparison, the stored interpretation and per-issue timelines. */
  app.get<{ Params: { id: string } }>('/api/audits/:id/changes', async (request, reply): Promise<AuditChanges | void> => {
    const audit = await getAuditRow(db, request.params.id)
    if (!audit) return reply.status(404).send({ error: 'Audit not found' })
    const comparison = await buildComparison(db, audit.id)
    const [intelligence, timelines] = await Promise.all([
      comparison ? getChangeReport(db, audit.id, comparison.previous.id) : Promise.resolve(null),
      buildAuditTimelines(db, audit.id),
    ])
    const status = await enrichmentStatus(db, audit, 'changes', intelligence, {
      unavailable: comparison ? null : 'There is no earlier finished audit of this site to compare with.',
    })
    return { comparison, intelligence, timelines, status }
  })

  app.post<{ Params: { id: string } }>('/api/audits/:id/changes', async (request, reply) => {
    return queue(request.params.id, 'changes', reply)
  })

  app.get<{ Params: { id: string } }>('/api/audits/:id/brief', async (request, reply): Promise<AuditBrief | void> => {
    const audit = await getAuditRow(db, request.params.id)
    if (!audit) return reply.status(404).send({ error: 'Audit not found' })
    const brief = await getClientBrief(db, audit.id)
    const findings = brief ? [] : await listFindings(db, audit.id)
    const status = await enrichmentStatus(db, audit, 'brief', brief, {
      unavailable: !brief && findings.length === 0 ? 'A client brief needs the findings of an AI audit.' : null,
    })
    return { brief, status }
  })

  app.post<{ Params: { id: string } }>('/api/audits/:id/brief', async (request, reply) => {
    return queue(request.params.id, 'brief', reply)
  })

  async function queue(auditId: string, kind: EnrichKind, reply: { status(code: number): { send(body: unknown): unknown } }) {
    const audit = await getAuditRow(db, auditId)
    if (!audit) return reply.status(404).send({ error: 'Audit not found' })
    const comparison = kind === 'changes' ? await buildComparison(db, audit.id) : null
    const status = await enrichmentStatus(db, audit, kind, null, {
      unavailable: kind === 'changes' && !comparison ? 'There is no earlier finished audit of this site to compare with.' : null,
    })
    if (!status.available) return reply.status(409).send({ error: status.reason })
    if (status.running) return reply.status(202).send({ queued: false, running: true })
    await enqueueEnrich(boss, { auditId: audit.id, kind })
    return reply.status(202).send({ queued: true, running: true })
  }
}
