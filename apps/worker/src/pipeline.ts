import { existsSync, readFileSync } from 'node:fs'
import { AuditContext, runBaseline, Workspace } from '@audivra/audit-core'
import {
  ClaudeCliProvider,
  fallbackFinal,
  runAuditor,
  runFinalizer,
  runReviewer,
  runRevision,
  type AgentProvider,
  type AuditTarget,
} from '@audivra/ai-runtime'
import { getConfig, type Logger } from '@audivra/config'
import { AuditDraft, ReviewResult, type FinalAudit, type FindingBrief } from '@audivra/contracts'
import {
  enqueueStage,
  getAuditRow,
  getPreviousSiteAudit,
  getStep,
  listEvents,
  listEvidence,
  listFindings,
  listSteps,
  listToolRuns,
  QUEUES,
  recordEvent,
  replaceFindings,
  updateAudit,
  updateStep,
  upsertPages,
  type AuditRow,
  type Db,
  type PgBoss,
  type QueueName,
} from '@audivra/database'
import { computeCoverage, toBrief } from '@audivra/insights'
import { getSystemStatus, stopAuditContainers } from '@audivra/tool-runtime'
import { presentAudit } from './present.ts'
import { executeStage, type StageDefinition } from './stage-runner.ts'

interface PipelineState {
  aiAvailable?: boolean
  aiReason?: string | null
  auditorSessionId?: string | null
  revised?: boolean
}

function pipelineState(audit: AuditRow): PipelineState {
  return (audit.options.pipeline as PipelineState | undefined) ?? {}
}

async function savePipelineState(ctx: AuditContext, audit: AuditRow, patch: PipelineState): Promise<void> {
  const next = { ...audit.options, pipeline: { ...pipelineState(audit), ...patch } }
  audit.options = next
  await updateAudit(ctx.db, ctx.auditId, { options: next })
}

function target(audit: AuditRow): AuditTarget {
  return { id: audit.id, url: audit.normalizedUrl, domain: audit.domain, clientName: audit.clientName }
}

function readJson<T>(ctx: AuditContext, relative: string, schema: { parse(v: unknown): T }): T | null {
  const file = ctx.ws.abs(relative)
  if (!existsSync(file)) return null
  return schema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

function baselineSummary(ctx: AuditContext): string {
  const file = ctx.ws.abs('baseline/summary.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : '(baseline digest unavailable)'
}

function latestDraft(ctx: AuditContext): AuditDraft | null {
  return (
    readJson(ctx, 'agent/draft-revised.json', AuditDraft) ?? readJson(ctx, 'agent/draft.json', AuditDraft)
  )
}

/** AI presentation (planner/composer) only when the audit used AI and AI is still enabled. */
function presentWithAi(audit: AuditRow): boolean {
  return audit.aiEnabled && pipelineState(audit).aiAvailable === true && getConfig().AUDIVRA_AI !== 'off'
}

/** Findings of the previous finished audit of the same site (stable issue keys across audits). */
async function previousFindings(db: Db, audit: AuditRow): Promise<FindingBrief[]> {
  const previous = await getPreviousSiteAudit(db, audit)
  return previous ? (await listFindings(db, previous.id)).map(toBrief) : []
}

export interface PipelineOptions {
  /** Run every stage in this process, one after another, instead of via the job queue (benchmark, CLI). */
  inline?: boolean
}

export class Pipeline {
  private readonly provider: AgentProvider
  private readonly inline: boolean

  constructor(
    private readonly db: Db,
    private readonly boss: PgBoss | null,
    private readonly log: Logger,
    provider?: AgentProvider,
    options: PipelineOptions = {},
  ) {
    this.provider = provider ?? new ClaudeCliProvider()
    this.inline = options.inline === true || boss === null
  }

  /** Hands an audit to its next stage: a durable job, or a direct call in inline mode. */
  private async next(queue: QueueName, auditId: string): Promise<void> {
    if (!this.inline && this.boss) {
      await enqueueStage(this.boss, queue, auditId)
      return
    }
    switch (queue) {
      case QUEUES.investigation:
        return this.handleInvestigation(auditId)
      case QUEUES.review:
        return this.handleReview(auditId)
      case QUEUES.revision:
        return this.handleRevision(auditId)
      case QUEUES.finalize:
        return this.handleFinalize(auditId)
      case QUEUES.present:
        return this.handlePresent(auditId)
      default:
        throw new Error(`No inline handler for ${queue}`)
    }
  }

  private readonly preparing: StageDefinition = {
    stage: 'preparing',
    label: 'Preparation',
    run: async (ctx, audit) => {
      const tools = await getSystemStatus({ refresh: true })
      await ctx.ws.writeJson('tools/registry.json', tools)
      let aiAvailable = false
      let aiReason: string | null
      if (!audit.aiEnabled) aiReason = 'AI disabled (AUDIVRA_AI=off): baseline-only audit'
      else {
        const availability = await this.provider.isAvailable()
        aiAvailable = availability.available
        aiReason = availability.reason
      }
      await savePipelineState(ctx, audit, { aiAvailable, aiReason })
      const ready = tools.tools.filter((t) => t.state === 'ready').length
      return {
        kind: 'next',
        message: `${ready}/${tools.tools.length} tools ready; AI ${aiAvailable ? 'available' : `unavailable (${aiReason})`}`,
      }
    },
  }

  private readonly baseline: StageDefinition = {
    stage: 'baseline',
    label: 'Baseline inspection',
    run: async (ctx, audit) => {
      const config = getConfig()
      const result = await runBaseline(ctx, {
        url: audit.normalizedUrl,
        maxPages: config.BASELINE_MAX_PAGES,
        maxLinkChecks: config.BASELINE_MAX_LINK_CHECKS,
        browserPages: config.BASELINE_BROWSER_PAGES,
        tools: await getSystemStatus(),
        scanners: config.BASELINE_SCANNERS.split(',').map((s) => s.trim()).filter(Boolean),
      })
      await updateAudit(ctx.db, ctx.auditId, { baseline: result.stats })
      return { kind: 'next', message: `${result.evidence.length} evidence items` }
    },
  }

  private readonly investigation: StageDefinition = {
    stage: 'investigation',
    label: 'AI investigation',
    run: async (ctx, audit) => {
      try {
        const { sessionId, draft } = await runAuditor(ctx, this.provider, {
          audit: target(audit),
          baselineSummary: baselineSummary(ctx),
          tools: await getSystemStatus(),
          evidence: await listEvidence(ctx.db, ctx.auditId),
        })
        await savePipelineState(ctx, audit, { auditorSessionId: sessionId })
        return { kind: 'next', message: `Draft with ${draft.findings.length} findings` }
      } finally {
        // Containers the auditor started (audit-scoped names) never outlive the stage.
        await stopAuditContainers(ctx.auditId).catch(() => undefined)
      }
    },
  }

  private readonly review: StageDefinition = {
    stage: 'review',
    label: 'AI review',
    run: async (ctx, audit) => {
      const draft = latestDraft(ctx)
      if (!draft) throw new Error('No auditor draft to review')
      await ctx.event('review.started', 'Reviewer is challenging the draft', {
        findings: draft.findings.length,
      })
      try {
        const { review } = await runReviewer(ctx, this.provider, {
          audit: target(audit),
          draft,
          baselineSummary: baselineSummary(ctx),
          evidence: await listEvidence(ctx.db, ctx.auditId),
          activity: await listEvents(ctx.db, ctx.auditId),
        })
        await ctx.event(
          'review.completed',
          `Review: ${review.approvedFindings.length} approved, ${review.rejectedFindings.length} rejected, ${review.findingsNeedingVerification.length} need verification, ${review.missingAreas.length} missing area(s)`,
          {
            approved: review.approvedFindings.length,
            rejected: review.rejectedFindings.length,
            needsVerification: review.findingsNeedingVerification.length,
            materialGaps: review.materialGaps,
          },
        )
        return { kind: 'next', message: review.materialGaps ? 'Material gaps found' : 'No material gaps' }
      } catch (error) {
        if (ctx.signal.aborted) throw error
        return {
          kind: 'degraded',
          message: `Review unavailable: ${error instanceof Error ? error.message : String(error)}`,
          error: {
            kind: 'ai',
            message: error instanceof Error ? error.message : String(error),
            stage: 'review',
          },
        }
      }
    },
  }

  private readonly revision: StageDefinition = {
    stage: 'revision',
    label: 'Verification pass',
    run: async (ctx, audit) => {
      const draft = readJson(ctx, 'agent/draft.json', AuditDraft)
      const review = readJson(ctx, 'agent/review.json', ReviewResult)
      if (!draft || !review) throw new Error('Draft or review missing for the verification pass')
      try {
        const { draft: revised } = await runRevision(ctx, this.provider, {
          audit: target(audit),
          draft,
          review,
          auditorSessionId: pipelineState(audit).auditorSessionId ?? null,
          baselineSummary: baselineSummary(ctx),
          evidence: await listEvidence(ctx.db, ctx.auditId),
        })
        await savePipelineState(ctx, audit, { revised: true })
        return { kind: 'next', message: `Revised draft with ${revised.findings.length} findings` }
      } catch (error) {
        if (ctx.signal.aborted) throw error
        return {
          kind: 'degraded',
          message: `Verification pass failed; the reviewed draft is used: ${error instanceof Error ? error.message : String(error)}`,
          error: {
            kind: 'ai',
            message: error instanceof Error ? error.message : String(error),
            stage: 'revision',
          },
        }
      } finally {
        await stopAuditContainers(ctx.auditId).catch(() => undefined)
      }
    },
  }

  private readonly finalizing: StageDefinition = {
    stage: 'finalizing',
    label: 'Finalization',
    run: async (ctx, audit) => {
      const state = pipelineState(audit)
      if (!audit.aiEnabled || !state.aiAvailable) {
        await updateAudit(ctx.db, ctx.auditId, {
          summary: { limitations: [{ kind: 'environment', text: state.aiReason ?? 'AI investigation did not run' }] },
        })
        return { kind: 'done' }
      }
      const draft = latestDraft(ctx)
      if (!draft) throw new Error('No audit draft available to finalize')
      const review = readJson(ctx, 'agent/review.json', ReviewResult)
      const previous = await previousFindings(ctx.db, audit)
      let final: FinalAudit
      let degraded: string | null = null
      try {
        final = (
          await runFinalizer(ctx, this.provider, {
            audit: target(audit),
            draft,
            review,
            revised: state.revised === true,
            evidence: await listEvidence(ctx.db, ctx.auditId),
            previous,
          })
        ).final
      } catch (error) {
        if (ctx.signal.aborted) throw error
        degraded = error instanceof Error ? error.message : String(error)
        final = fallbackFinal(draft, review, previous)
        await ctx.ws.writeJson('final/audit.json', final)
        await ctx.event(
          'agent.note',
          'Finalizer unavailable; findings assembled deterministically from the reviewed draft',
          { role: 'system' },
          'warn',
        )
      }
      await persistFinal(ctx, final)
      if (degraded) {
        return {
          kind: 'degraded',
          message: `Finalizer failed; used reviewed draft: ${degraded}`,
          error: { kind: 'ai', message: degraded, stage: 'finalizing' },
        }
      }
      return { kind: 'done' }
    },
  }

  private readonly presenting: StageDefinition = {
    stage: 'presenting',
    label: 'Visual report',
    run: async (ctx, audit) => {
      const result = await presentAudit(ctx, this.provider, audit, { ai: presentWithAi(audit) })
      return { kind: 'next', message: result.message }
    },
  }

  /** Job: preparation + baseline, then hand off to the AI stages (or finish without AI). */
  async handleBaseline(auditId: string): Promise<void> {
    const prep = await executeStage(this.db, this.log, auditId, this.preparing)
    if (!prep) return
    const base = await executeStage(this.db, this.log, auditId, this.baseline)
    if (!base) return
    await this.refreshCoverage(auditId)
    const audit = await getAuditRow(this.db, auditId)
    const state = audit ? pipelineState(audit) : {}
    if (audit?.aiEnabled && state.aiAvailable) {
      await this.next(QUEUES.investigation, auditId)
      return
    }
    const reason = state.aiReason ?? 'AI unavailable'
    for (const stage of ['investigation', 'review', 'revision'] as const) {
      await updateStep(this.db, auditId, stage, 'skipped', { message: reason })
    }
    if (audit?.aiEnabled) {
      // AI was requested but is not usable: say so instead of pretending the audit is complete.
      await updateStep(this.db, auditId, 'investigation', 'failed', {
        message: reason,
        error: {
          kind: 'required-capability',
          message: `Claude runtime unavailable: ${reason}`,
          stage: 'investigation',
        },
      })
    }
    await this.handleFinalize(auditId)
  }

  async handleInvestigation(auditId: string): Promise<void> {
    const outcome = await executeStage(this.db, this.log, auditId, this.investigation)
    if (outcome) await this.next(QUEUES.review, auditId)
    else await this.presentAfterFailure(auditId)
  }

  async handleReview(auditId: string): Promise<void> {
    const outcome = await executeStage(this.db, this.log, auditId, this.review)
    if (!outcome) {
      await this.presentAfterFailure(auditId)
      return
    }
    const reviewFile = new Workspace(auditId).abs('agent/review.json')
    const review =
      outcome.kind === 'next' && existsSync(reviewFile)
        ? ReviewResult.parse(JSON.parse(readFileSync(reviewFile, 'utf8')))
        : null
    const maxRevisions = getConfig().AUDIT_MAX_REVISIONS
    if (review && maxRevisions > 0 && needsVerificationPass(review)) {
      await this.next(QUEUES.revision, auditId)
      return
    }
    await updateStep(this.db, auditId, 'revision', 'skipped', {
      message:
        outcome.kind === 'degraded'
          ? 'Skipped: review unavailable'
          : maxRevisions === 0
            ? 'Revision disabled'
            : 'Reviewer found nothing that needs verification',
    })
    await this.next(QUEUES.finalize, auditId)
  }

  async handleRevision(auditId: string): Promise<void> {
    const outcome = await executeStage(this.db, this.log, auditId, this.revision)
    if (outcome) await this.next(QUEUES.finalize, auditId)
    else await this.presentAfterFailure(auditId)
  }

  async handleFinalize(auditId: string): Promise<void> {
    const outcome = await executeStage(this.db, this.log, auditId, this.finalizing)
    if (outcome) await this.next(QUEUES.present, auditId)
    else await this.presentAfterFailure(auditId)
  }

  /**
   * Job: the presenting stage. During a run it ends the pipeline; for an already finished audit
   * (POST /api/audits/:id/present) it regenerates visuals and the report plan without changing the
   * audit's findings or status.
   */
  async handlePresent(auditId: string): Promise<void> {
    const audit = await getAuditRow(this.db, auditId)
    if (!audit) return
    if (audit.status === 'completed' || audit.status === 'partial') {
      // Regeneration is requested by resetting the step (POST /api/audits/:id/present); a duplicate
      // delivery of an already-completed job does not re-run the AI.
      if ((await getStep(this.db, auditId, 'presenting'))?.status === 'completed') return
      await this.regeneratePresentation(auditId)
      return
    }
    const outcome = await executeStage(this.db, this.log, auditId, this.presenting)
    if (outcome) await this.completeAudit(auditId)
    else await this.refreshCoverage(auditId)
  }

  /** After a stage failure left the audit partial: still produce deterministic visuals and coverage. */
  private async presentAfterFailure(auditId: string): Promise<void> {
    const audit = await getAuditRow(this.db, auditId)
    if (audit?.status === 'partial') await this.regeneratePresentation(auditId)
  }

  private async regeneratePresentation(auditId: string): Promise<void> {
    const audit = await getAuditRow(this.db, auditId)
    if (!audit) return
    const ws = new Workspace(auditId)
    await ws.init()
    const ctx = new AuditContext(auditId, this.db, this.log.child({ auditId, stage: 'presenting' }), ws, new AbortController().signal)
    await updateStep(this.db, auditId, 'presenting', 'running', { message: null, error: null })
    await updateAudit(this.db, auditId, { stage: 'presenting' })
    await ctx.event('stage.started', 'Visual report started', { stage: 'presenting' })
    try {
      const result = await presentAudit(ctx, this.provider, audit, { ai: presentWithAi(audit) })
      await updateStep(this.db, auditId, 'presenting', 'completed', { message: result.message })
      await ctx.event('stage.completed', 'Visual report completed', { stage: 'presenting' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.error({ err: error, auditId }, 'visual report generation failed')
      await updateStep(this.db, auditId, 'presenting', 'failed', {
        message,
        error: { kind: 'internal', message: message.slice(0, 1000), stage: 'presenting' },
      })
      await ctx.event('stage.failed', `Visual report failed: ${message.slice(0, 300)}`, { stage: 'presenting' }, 'error')
    } finally {
      await updateAudit(this.db, auditId, { stage: 'done' })
      await this.refreshCoverage(auditId)
    }
  }

  private async completeAudit(auditId: string): Promise<void> {
    const steps = await listSteps(this.db, auditId)
    const failed = steps.filter((s) => s.status === 'failed')
    const status = failed.length ? 'partial' : 'completed'
    await updateAudit(this.db, auditId, {
      status,
      stage: 'done',
      finishedAt: new Date(),
      error: failed[0]?.error ?? null,
    })
    await this.refreshCoverage(auditId)
    await recordEvent(this.db, {
      auditId,
      type: 'audit.completed',
      level: status === 'completed' ? 'info' : 'warn',
      message:
        status === 'completed'
          ? 'Audit completed'
          : `Audit completed with issues: ${failed.map((s) => s.stage).join(', ')} did not complete normally`,
      data: { status },
    })
  }

  /** Recomputes and stores the explicit coverage table (every capability with a status and reason). */
  private async refreshCoverage(auditId: string): Promise<void> {
    try {
      const audit = await getAuditRow(this.db, auditId)
      if (!audit) return
      const [toolRuns, steps, evidence] = await Promise.all([
        listToolRuns(this.db, auditId),
        listSteps(this.db, auditId),
        listEvidence(this.db, auditId),
      ])
      const coverage = computeCoverage({ targetUrl: audit.normalizedUrl, toolRuns, steps, baseline: audit.baseline ?? null, evidence })
      await updateAudit(this.db, auditId, { coverage })
    } catch (error) {
      this.log.warn({ err: error, auditId }, 'coverage computation failed')
    }
  }
}

/**
 * The verification pass runs when the reviewer reports material gaps, asks for any finding to be
 * verified, or names a high-importance area the auditor missed.
 */
export function needsVerificationPass(review: ReviewResult): boolean {
  return (
    review.materialGaps ||
    review.findingsNeedingVerification.length > 0 ||
    review.missingAreas.some((area) => area.importance === 'high')
  )
}

/** Persists the final audit: findings (with evidence links), summary and AI-inspected pages. */
async function persistFinal(ctx: AuditContext, final: FinalAudit): Promise<void> {
  const evidence = await listEvidence(ctx.db, ctx.auditId)
  const idByRef = new Map(evidence.map((e) => [e.ref, e.id]))
  await replaceFindings(
    ctx.db,
    ctx.auditId,
    final.findings.map((f, index) => ({
      ref: f.id,
      rank: index + 1,
      issueKey: f.issueKey,
      title: f.title,
      category: f.category,
      severity: f.severity,
      type: f.type,
      description: f.description,
      observed: f.observed,
      affectedUrls: f.affectedUrls,
      confidence: f.confidence,
      verificationStatus: f.verificationStatus,
      whyItMatters: f.whyItMatters,
      businessImpact: f.businessImpact,
      businessImpactLevel: f.businessImpactLevel,
      recommendation: f.recommendation,
      effort: f.effort,
      opportunity: f.opportunity,
      createdBy: 'ai-auditor',
      sourceRefs: f.sourceFindingIds,
      evidenceIds: f.evidenceIds.map((ref) => idByRef.get(ref)).filter((id): id is string => !!id),
    })),
  )
  for (const f of final.findings) {
    await recordEvent(ctx.db, {
      auditId: ctx.auditId,
      type: 'finding.created',
      message: `${f.id} · ${f.severity.toUpperCase()} · ${f.title}`,
      data: { ref: f.id, severity: f.severity, category: f.category },
    })
  }
  await updateAudit(ctx.db, ctx.auditId, {
    summary: {
      executiveSummary: final.executiveSummary,
      businessUnderstanding: final.businessUnderstanding,
      importantPageTypes: final.importantPageTypes,
      technologies: final.technologies,
      opportunities: final.opportunities,
      limitations: final.limitations,
      pagesInspected: final.pagesInspected,
    },
  })
  const inspected = final.pagesInspected.filter((u) => /^https?:\/\//.test(u)).slice(0, 200)
  await upsertPages(
    ctx.db,
    ctx.auditId,
    inspected.map((url) => ({
      url,
      status: null,
      title: null,
      depth: 0,
      source: 'ai',
      inspectedInBrowser: true,
    })),
  )
}
