import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { summarizeLighthouse, type AuditContext } from '@audivra/audit-core'
import { AiStageError, runComposer, runPlanner, type AgentProvider, type AuditTarget } from '@audivra/ai-runtime'
import type { ArtifactSpec, ArtifactType } from '@audivra/contracts'
import {
  listEvidence,
  replaceArtifacts,
  setPageTypes,
  updateAudit,
  type AuditRow,
  type NewArtifact,
} from '@audivra/database'
import {
  buildComparison,
  fallbackArtifactSpecs,
  loadAuditData,
  pagePath,
  presentationContext,
  resolveSpecs,
} from '@audivra/insights'

/** Fewer resolved planner visuals than this and the deterministic set fills the gaps. */
const MIN_PLANNED_ARTIFACTS = 2

export interface PresentResult {
  message: string
  /** Set when an AI step failed and a deterministic fallback was used. */
  degraded: string | null
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Presenting stage: makes the finished audit presentable without new AI investigation.
 *  1. indexes Lighthouse reports the auditor saved under tools/lighthouse/ as system evidence,
 *  2. labels the page inventory with the AI's page types,
 *  3. Artifact Planner → specs → resolver (grounding) → stored artifacts (deterministic fallback),
 *  4. Report Composer → validated report plan (default layout when unavailable).
 * Failures in 3–4 never lose findings: fallbacks keep the report complete and are reported honestly.
 */
export async function presentAudit(
  ctx: AuditContext,
  provider: AgentProvider,
  audit: AuditRow,
  options: { ai: boolean },
): Promise<PresentResult> {
  const ingested = await ingestAuditorLighthouse(ctx)
  await labelPageTypes(ctx, audit)

  const context = await presentationContext(ctx.db, ctx.auditId)
  if (!context) throw new Error('Audit data could not be loaded')
  const target: AuditTarget = { id: audit.id, url: audit.normalizedUrl, domain: audit.domain, clientName: audit.clientName }
  const hasFindings = context.data.findings.length > 0
  const problems: string[] = []

  // 3. Visual artifacts.
  let artifacts: NewArtifact[] = []
  let planned = 0
  if (options.ai && hasFindings) {
    try {
      const plan = await runPlanner(ctx, provider, { audit: target, context })
      const resolved = await resolveSpecs(plan.specs, context)
      planned = resolved.artifacts.length
      artifacts = resolved.artifacts.map((a) => ({ ...a, agentRunId: plan.agentRunId }))
      const issues = [...plan.issues, ...resolved.issues]
      await ctx.ws.writeJson('agent/artifact-resolution.json', { specs: plan.specs.length, resolved: planned, issues, keptAsText: plan.keptAsText })
      if (issues.length) {
        await ctx.event('agent.note', `Visual validation rejected or adjusted ${issues.length} item(s) (e.g. ${issues[0]})`, { role: 'system' }, 'warn')
      }
    } catch (error) {
      if (ctx.signal.aborted || (error instanceof AiStageError && error.cancelled)) throw error
      problems.push(`Artifact Planner unavailable (${errorText(error).slice(0, 200)}); deterministic visuals used`)
    }
  }
  if (artifacts.length < MIN_PLANNED_ARTIFACTS) {
    const have = new Set<ArtifactType>(artifacts.map((a) => a.type))
    const fallback: ArtifactSpec[] = fallbackArtifactSpecs(context).filter((s) => !have.has(s.type))
    const resolved = await resolveSpecs(fallback, context)
    artifacts = [...artifacts, ...resolved.artifacts.map((a) => ({ ...a, createdBy: 'system' as const }))]
  }
  const stored = await replaceArtifacts(ctx.db, ctx.auditId, artifacts)

  // 4. Report composition (on the stored artifacts, so refs are final).
  let composed = false
  await updateAudit(ctx.db, ctx.auditId, { reportPlan: null })
  if (options.ai && hasFindings) {
    try {
      const data = await loadAuditData(ctx.db, ctx.auditId)
      if (!data) throw new Error('Audit data could not be loaded')
      const { plan, issues } = await runComposer(ctx, provider, {
        audit: target,
        data,
        comparison: await buildComparison(ctx.db, ctx.auditId),
      })
      if (plan) {
        await updateAudit(ctx.db, ctx.auditId, { reportPlan: plan })
        composed = true
      } else problems.push(`Report plan unusable (${issues[0] ?? 'no valid references'}); default layout used`)
    } catch (error) {
      if (ctx.signal.aborted || (error instanceof AiStageError && error.cancelled)) throw error
      problems.push(`Report Composer unavailable (${errorText(error).slice(0, 200)}); default layout used`)
    }
  }

  for (const problem of problems) await ctx.event('agent.note', problem, { role: 'system' }, 'warn')
  const parts = [
    `${stored.length} visual${stored.length === 1 ? '' : 's'} (${planned} planned, ${stored.length - planned} deterministic)`,
    options.ai && hasFindings ? (composed ? 'report composed' : 'default report layout') : 'default report layout (no AI findings)',
  ]
  if (ingested) parts.push(`${ingested} auditor Lighthouse report(s) indexed`)
  return { message: parts.join(' · '), degraded: problems.length ? problems.join('; ') : null }
}

type LighthouseJson = Parameters<typeof summarizeLighthouse>[0] & {
  lighthouseVersion?: string
  finalUrl?: string
  requestedUrl?: string
  configSettings?: { formFactor?: string }
}

async function listJsonFiles(dir: string, depth = 0): Promise<string[]> {
  if (!existsSync(dir) || depth > 2) return []
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listJsonFiles(full, depth + 1)))
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full)
  }
  return out
}

/** Lighthouse reports the auditor saved become system evidence, so their metrics can be charted. */
async function ingestAuditorLighthouse(ctx: AuditContext): Promise<number> {
  const dir = ctx.ws.abs('tools/lighthouse')
  const evidence = await listEvidence(ctx.db, ctx.auditId)
  const linked = new Set<string>()
  for (const item of evidence) {
    if (item.artifactPath) linked.add(item.artifactPath)
    if (typeof item.metadata.reportJson === 'string') linked.add(item.metadata.reportJson)
    if (typeof item.metadata.jsonPath === 'string') linked.add(item.metadata.jsonPath)
  }
  let count = 0
  for (const file of (await listJsonFiles(dir)).slice(0, 40)) {
    const relative = path.relative(ctx.ws.root, file).split(path.sep).join('/')
    if (linked.has(relative)) continue
    try {
      if ((await stat(file)).size > 40 * 1024 * 1024) continue
      const report = JSON.parse(await readFile(file, 'utf8')) as LighthouseJson
      if (!report.lighthouseVersion || !report.categories || !report.audits || (report as { runtimeError?: unknown }).runtimeError) continue
      const formFactor = report.configSettings?.formFactor === 'desktop' ? 'desktop' : 'mobile'
      const summary = summarizeLighthouse(report, formFactor, relative, null)
      const url = summary.url || report.finalUrl || report.requestedUrl || null
      if (!url) continue
      const s = summary
      await ctx.evidence({
        source: 'system',
        type: 'metric',
        title: `Lighthouse ${formFactor} (auditor run): performance ${s.scores.performance ?? '–'}, LCP ${s.metrics.lcpMs != null ? `${(s.metrics.lcpMs / 1000).toFixed(1)} s` : '–'} · ${pagePath(url)}`,
        summary: `Indexed from ${relative}. Performance ${s.scores.performance}, Accessibility ${s.scores.accessibility}, Best practices ${s.scores.bestPractices}, SEO ${s.scores.seo}. FCP ${s.metrics.fcpMs} ms, LCP ${s.metrics.lcpMs} ms, TBT ${s.metrics.tbtMs} ms, CLS ${s.metrics.cls}. Lab data.`,
        url,
        artifactPath: relative,
        metadata: { kind: 'lighthouse', ...s, url, reportJson: relative, ingestedFrom: 'auditor' },
      })
      linked.add(relative)
      count++
    } catch (error) {
      ctx.log.warn({ err: error, file: relative }, 'could not index Lighthouse report')
    }
  }
  return count
}

/** Labels crawled pages with the AI's important page types (example URLs → type). */
async function labelPageTypes(ctx: AuditContext, audit: AuditRow): Promise<void> {
  const types = audit.summary?.importantPageTypes ?? []
  const pairs = types.flatMap((t) => t.exampleUrls.filter((u) => /^https?:\/\//.test(u)).map((url) => ({ url, pageType: t.type.slice(0, 60) })))
  if (pairs.length) await setPageTypes(ctx.db, ctx.auditId, pairs)
}
