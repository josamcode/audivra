import { AuditContext, Workspace } from '@audivra/audit-core'
import { runBriefWriter, runChangeAnalyst, runJourneyAnalyst, type AgentProvider } from '@audivra/ai-runtime'
import type { Logger } from '@audivra/config'
import type { AuditComparison, ChangeReportItem } from '@audivra/contracts'
import {
  getAuditRow,
  getChangeReport,
  recordEvent,
  replaceJourneys,
  saveChangeReport,
  saveClientBrief,
  setFindingJourneyRefs,
  type AuditRow,
  type Db,
  type EnrichJob,
} from '@audivra/database'
import { buildComparison, loadAuditData } from '@audivra/insights'
import { target } from './audit-target.ts'

/*
 * Intelligence jobs over a finished audit: journey analysis (for audits from before journeys),
 * Change Intelligence and the Client Brief. Each is one bounded AI run on persisted data.
 */

/** Interprets the deterministic comparison with the previous audit and stores the result. */
export async function analyzeChanges(
  ctx: AuditContext,
  provider: AgentProvider,
  audit: AuditRow,
  comparison: AuditComparison,
): Promise<ChangeReportItem> {
  const [current, previous] = await Promise.all([loadAuditData(ctx.db, audit.id), loadAuditData(ctx.db, comparison.previous.id)])
  if (!current || !previous) throw new Error('Audit data for the comparison could not be loaded')
  const { agentRunId, analysis, promptVersion, issues } = await runChangeAnalyst(ctx, provider, {
    audit: target(audit),
    comparison,
    current,
    previous,
  })
  await saveChangeReport(ctx.db, { auditId: audit.id, previousAuditId: comparison.previous.id, analysis, promptVersion, agentRunId })
  await ctx.event('changes.analyzed', `Change intelligence: ${analysis.headline}`, { insights: analysis.insights.length, adjusted: issues.length })
  const stored = await getChangeReport(ctx.db, audit.id, comparison.previous.id)
  if (!stored) throw new Error('Change intelligence was not stored')
  return stored
}

/** Identifies journeys for an audit that finished before journeys existed, and links its findings. */
export async function analyzeJourneys(ctx: AuditContext, provider: AgentProvider, audit: AuditRow): Promise<number> {
  const data = await loadAuditData(ctx.db, audit.id)
  if (!data) throw new Error('Audit data could not be loaded')
  const { agentRunId, analysis } = await runJourneyAnalyst(ctx, provider, { audit: target(audit), data })
  await replaceJourneys(
    ctx.db,
    audit.id,
    analysis.journeys.map((j) => ({
      ref: j.id,
      journeyKey: j.journeyKey,
      type: j.type,
      name: j.name,
      goal: j.goal,
      description: j.description,
      isPrimary: j.isPrimary,
      confidence: j.confidence,
      steps: j.steps,
      health: j.health,
    })),
    'analysis',
    agentRunId,
  )
  await setFindingJourneyRefs(ctx.db, audit.id, new Map(analysis.findingLinks.map((l) => [l.findingId, l.journeyIds])))
  await ctx.event(
    'journeys.recorded',
    analysis.journeys.length ? `Journey analysis: ${analysis.journeys.length} journey${analysis.journeys.length === 1 ? '' : 's'} identified` : 'Journey analysis found no supported journey',
    { count: analysis.journeys.length, source: 'analysis' },
  )
  return analysis.journeys.length
}

/** Generates (or regenerates) the Client Brief from the finalized audit. */
export async function writeClientBrief(ctx: AuditContext, provider: AgentProvider, audit: AuditRow): Promise<void> {
  const data = await loadAuditData(ctx.db, audit.id)
  if (!data) throw new Error('Audit data could not be loaded')
  const comparison = await buildComparison(ctx.db, audit.id)
  const changes = comparison ? await getChangeReport(ctx.db, audit.id, comparison.previous.id) : null
  const { agentRunId, brief, promptVersion } = await runBriefWriter(ctx, provider, { audit: target(audit), data, comparison, changes })
  await saveClientBrief(ctx.db, { auditId: audit.id, content: brief, promptVersion, agentRunId })
  await ctx.event('brief.generated', 'Client brief generated', { topIssues: brief.quick.topIssues.length })
}

/** Job handler for the enrich queue. Failures are recorded on the AI run and in the activity log. */
export async function handleEnrich(db: Db, log: Logger, provider: AgentProvider, job: EnrichJob): Promise<void> {
  const audit = await getAuditRow(db, job.auditId)
  if (!audit) return
  const ws = new Workspace(audit.id)
  await ws.init()
  const ctx = new AuditContext(audit.id, db, log.child({ auditId: audit.id, job: job.kind }), ws, new AbortController().signal)
  try {
    if (job.kind === 'journeys') await analyzeJourneys(ctx, provider, audit)
    else if (job.kind === 'brief') await writeClientBrief(ctx, provider, audit)
    else {
      const comparison = await buildComparison(db, audit.id)
      if (!comparison) throw new Error('There is no earlier finished audit of this site to compare with')
      await analyzeChanges(ctx, provider, audit, comparison)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn({ err: error, auditId: audit.id, kind: job.kind }, 'intelligence job failed')
    await recordEvent(db, { auditId: audit.id, type: 'agent.note', level: 'warn', message: `${label(job.kind)} failed: ${message.slice(0, 300)}`, data: { role: job.kind } })
  }
}

function label(kind: EnrichJob['kind']): string {
  return kind === 'journeys' ? 'Journey analysis' : kind === 'brief' ? 'Client brief' : 'Change intelligence'
}
