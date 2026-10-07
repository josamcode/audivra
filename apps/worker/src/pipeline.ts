import { existsSync, readFileSync } from 'node:fs'
import { runBaseline, Workspace, type AuditContext } from '@audivra/audit-core'
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
import { AuditDraft, ReviewResult, type FinalAudit } from '@audivra/contracts'
import {
  enqueueStage,
  getAuditRow,
  listEvents,
  listEvidence,
  listSteps,
  QUEUES,
  recordEvent,
  replaceFindings,
  updateAudit,
  updateStep,
  upsertPages,
  type AuditRow,
  type Db,
  type PgBoss,
} from '@audivra/database'
import { getSystemStatus } from '@audivra/tool-runtime'
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

export class Pipeline {
  private readonly provider: AgentProvider

  constructor(
    private readonly db: Db,
    private readonly boss: PgBoss,
    private readonly log: Logger,
    provider?: AgentProvider,
  ) {
    this.provider = provider ?? new ClaudeCliProvider()
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
      })
      await updateAudit(ctx.db, ctx.auditId, { baseline: result.stats })
      return { kind: 'next', message: `${result.evidence.length} evidence items` }
    },
  }

  private readonly investigation: StageDefinition = {
    stage: 'investigation',
    label: 'AI investigation',
    run: async (ctx, audit) => {
      const { sessionId, draft } = await runAuditor(ctx, this.provider, {
        audit: target(audit),
        baselineSummary: baselineSummary(ctx),
        tools: await getSystemStatus(),
        evidence: await listEvidence(ctx.db, ctx.auditId),
      })
      await savePipelineState(ctx, audit, { auditorSessionId: sessionId })
      return { kind: 'next', message: `Draft with ${draft.findings.length} findings` }
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
          summary: { limitations: [state.aiReason ?? 'AI investigation did not run'] },
        })
        return { kind: 'done' }
      }
      const draft = latestDraft(ctx)
      if (!draft) throw new Error('No audit draft available to finalize')
      const review = readJson(ctx, 'agent/review.json', ReviewResult)
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
          })
        ).final
      } catch (error) {
        if (ctx.signal.aborted) throw error
        degraded = error instanceof Error ? error.message : String(error)
        final = fallbackFinal(draft, review)
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

  /** Job: preparation + baseline, then hand off to the AI stages (or finish without AI). */
  async handleBaseline(auditId: string): Promise<void> {
    const prep = await executeStage(this.db, this.log, auditId, this.preparing)
    if (!prep) return
    const base = await executeStage(this.db, this.log, auditId, this.baseline)
    if (!base) return
    const audit = await getAuditRow(this.db, auditId)
    const state = audit ? pipelineState(audit) : {}
    if (audit?.aiEnabled && state.aiAvailable) {
      await enqueueStage(this.boss, QUEUES.investigation, auditId)
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
    if (outcome) await enqueueStage(this.boss, QUEUES.review, auditId)
  }

  async handleReview(auditId: string): Promise<void> {
    const outcome = await executeStage(this.db, this.log, auditId, this.review)
    if (!outcome) return
    const reviewFile = new Workspace(auditId).abs('agent/review.json')
    const review =
      outcome.kind === 'next' && existsSync(reviewFile)
        ? ReviewResult.parse(JSON.parse(readFileSync(reviewFile, 'utf8')))
        : null
    const maxRevisions = getConfig().AUDIT_MAX_REVISIONS
    if (review && maxRevisions > 0 && needsVerificationPass(review)) {
      await enqueueStage(this.boss, QUEUES.revision, auditId)
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
    await enqueueStage(this.boss, QUEUES.finalize, auditId)
  }

  async handleRevision(auditId: string): Promise<void> {
    const outcome = await executeStage(this.db, this.log, auditId, this.revision)
    if (outcome) await enqueueStage(this.boss, QUEUES.finalize, auditId)
  }

  async handleFinalize(auditId: string): Promise<void> {
    const outcome = await executeStage(this.db, this.log, auditId, this.finalizing)
    if (!outcome) return
    const steps = await listSteps(this.db, auditId)
    const failed = steps.filter((s) => s.status === 'failed')
    const status = failed.length ? 'partial' : 'completed'
    await updateAudit(this.db, auditId, {
      status,
      stage: 'done',
      finishedAt: new Date(),
      error: failed[0]?.error ?? null,
    })
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
