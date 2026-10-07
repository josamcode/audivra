import { getConfig } from '@audivra/config'
import type { AuditContext } from '@audivra/audit-core'
import {
  ArtifactPlan,
  ArtifactSpec,
  ReportPlan,
  toAgentJsonSchema,
  type Artifact,
  type AuditComparison,
  type CoverageItem,
  type EvidenceItem,
  type FindingItem,
} from '@audivra/contracts'
import { updateAgentRun } from '@audivra/database'
import {
  availableSystemData,
  catalogAsText,
  evidenceKind,
  sanitizeReportPlan,
  type AuditData,
  type PresentationContext,
} from '@audivra/insights'
import { loadPrompt } from '../prompts.ts'
import type { AgentProvider } from '../provider.ts'
import { runRole } from './run-role.ts'
import { AiStageError, type AuditTarget } from './index.ts'

/** Read-only workspace access for the planner (it may look at screenshots and evidence details). */
const PLANNER_TOOLS = ['Read', 'Glob', 'Grep']
const PLANNER_ALLOWED = ['Read(./**)', 'Glob', 'Grep', 'mcp__audit__list_evidence', 'mcp__audit__get_evidence']

const minutes = (n: number) => n * 60_000
const IMAGE_RE = /\.(png|jpe?g|webp)$/i
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function findingLines(findings: FindingItem[], mode: 'planner' | 'composer'): string {
  if (findings.length === 0) return '(no findings)'
  return findings
    .map((f) => {
      const head = `${f.ref} [${f.severity} · ${f.category} · ${f.type} · ${f.verificationStatus} · confidence ${f.confidence} · effort ${f.effort}] ${f.title}`
      const pages = f.affectedUrls.length ? `${f.affectedUrls.slice(0, 3).join(', ')}${f.affectedUrls.length > 3 ? ` (+${f.affectedUrls.length - 3} more)` : ''}` : '—'
      const detail =
        mode === 'planner'
          ? `   Observed: ${clip(oneLine(f.observed), 320)}`
          : `   Why it matters: ${clip(oneLine(f.whyItMatters), 260)}`
      return `${head}\n${detail}\n   Pages: ${pages} · Evidence: ${f.evidenceRefs.join(', ') || 'none'}`
    })
    .join('\n')
}

function evidenceLines(evidence: EvidenceItem[]): string {
  return evidence
    .map((e) => {
      const parts = [`${e.ref} [${evidenceKind(e)}] ${clip(e.title, 140)}`]
      if (e.url) parts.push(e.url)
      if (e.artifactPath) parts.push(`file: ${e.artifactPath}`)
      const viewport = typeof e.metadata.viewport === 'string' ? e.metadata.viewport : null
      if (viewport) parts.push(`viewport ${viewport}`)
      if (Array.isArray(e.metadata.regions) && e.metadata.regions.length) parts.push(`measured regions: ${e.metadata.regions.length}`)
      return parts.join(' — ')
    })
    .join('\n')
}

function opportunityLines(data: AuditData): string {
  const opportunities = data.row.summary?.opportunities ?? []
  if (opportunities.length === 0) return '(none)'
  return opportunities
    .map((o) => `- "${o.title}" — impact ${o.impact}, effort ${o.effort} — ${o.relatedFindingIds.join(', ') || 'no linked findings'}`)
    .join('\n')
}

function comparisonText(comparison: AuditComparison | null): string {
  if (!comparison) return 'None — this is the first finished audit of this site.'
  const s = comparison.summary
  const metrics = comparison.metrics
    .filter((m) => m.direction === 'improved' || m.direction === 'regressed')
    .map((m) => `${m.label}: ${m.direction} (${m.before} → ${m.after})`)
  return [
    `Previous audit ${comparison.previous.id} (${comparison.previous.createdAt.slice(0, 10)}).`,
    `Findings: ${s.new} new, ${s.resolved} resolved, ${s.regressed} regressed, ${s.improved} improved, ${s.unchanged} unchanged.`,
    metrics.length ? `Metric changes beyond lab noise: ${metrics.join('; ')}.` : 'No metric changed beyond lab noise.',
    `Comparable screenshot pairs: ${comparison.screenshots.length}.`,
  ].join('\n')
}

function businessText(data: AuditData): string {
  const b = data.row.summary?.businessUnderstanding
  if (!b) return '(not available)'
  return [
    `Type: ${b.businessType}${b.businessModel ? ` · Model: ${b.businessModel}` : ''}`,
    `Customers: ${b.likelyCustomers}`,
    `Primary conversion: ${b.primaryConversion}${b.secondaryConversions.length ? ` · Secondary: ${b.secondaryConversions.join(', ')}` : ''}`,
    `Confidence: ${b.confidence}`,
    `Summary: ${clip(oneLine(b.summary), 500)}`,
  ].join('\n')
}

function coverageLines(coverage: CoverageItem[]): string {
  return coverage.map((c) => `- ${c.label}: ${c.status}${c.reason ? ` — ${clip(c.reason, 140)}` : ''}`).join('\n') || '(not available)'
}

export interface PlannerResult {
  agentRunId: string
  specs: ArtifactSpec[]
  keptAsText: ArtifactPlan['keptAsText']
  issues: string[]
}

/** Artifact Planner: decides which insights deserve a visual and how (structured specs only). */
export async function runPlanner(
  ctx: AuditContext,
  provider: AgentProvider,
  input: { audit: AuditTarget; context: PresentationContext },
): Promise<PlannerResult> {
  const config = getConfig()
  const prompt = loadPrompt('planner-system')
  const { data } = input.context
  const userPrompt = `# Plan the visuals for the audit of ${input.audit.url}
Working directory (audit workspace, read-only for you): ${ctx.ws.root}

## Business
${businessText(data)}

## Final findings (only these IDs exist)
${findingLines(data.findings, 'planner')}

## Opportunities
${opportunityLines(data)}

## Evidence (only these IDs exist)
${evidenceLines(data.evidence)}

## Metric catalog — use these keys as \`metricKey\` (values shown for orientation; Audivra fills them in)
${catalogAsText(data.catalog) || '(empty)'}

## Data-backed types for this audit
${availableSystemData(input.context).map((l) => `- ${l}`).join('\n')}

## Previous audit of this site
${comparisonText(input.context.comparison)}

Return the artifact plan.`

  const outcome = await runRole(ctx, provider, {
    role: 'planner',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(ArtifactPlan),
    model: config.PRESENTER_MODEL ?? config.AUDITOR_MODEL,
    effort: config.PRESENTER_EFFORT ?? 'medium',
    maxTurns: 40,
    timeoutMs: minutes(15),
    tools: PLANNER_TOOLS,
    allowedTools: PLANNER_ALLOWED,
    mcp: { browser: false, audit: true },
    wrapUp: { prompt: 'Return your artifact plan now from what you have looked at.', maxTurns: 4, timeoutMs: minutes(5) },
  })
  const { result, agentRunId } = outcome
  if (result.status === 'cancelled') throw new AiStageError('Artifact Planner was cancelled', agentRunId, true)
  if (result.status !== 'completed') throw new AiStageError(`Artifact Planner failed: ${result.error ?? 'unknown error'}`, agentRunId)

  // Lenient parse: one malformed spec must not discard the whole plan.
  const issues: string[] = []
  const raw = result.output as { artifacts?: unknown; keptAsText?: unknown } | null
  const specs: ArtifactSpec[] = []
  for (const [i, candidate] of (Array.isArray(raw?.artifacts) ? raw.artifacts : []).entries()) {
    const parsed = ArtifactSpec.safeParse(candidate)
    if (parsed.success) specs.push(parsed.data)
    else issues.push(`artifact[${i}] rejected: ${parsed.error.issues.slice(0, 2).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`)
  }
  const kept = ArtifactPlan.shape.keptAsText.safeParse(raw?.keptAsText)
  await ctx.ws.writeJson('agent/artifact-plan.json', raw)
  return { agentRunId, specs: specs.slice(0, 12), keptAsText: kept.success ? kept.data : [], issues }
}

export interface ComposerResult {
  agentRunId: string
  plan: ReportPlan | null
  issues: string[]
}

/** Report Composer: selects and frames the client narrative (validated against what exists). */
export async function runComposer(
  ctx: AuditContext,
  provider: AgentProvider,
  input: { audit: AuditTarget; data: AuditData; comparison: AuditComparison | null },
): Promise<ComposerResult> {
  const config = getConfig()
  const prompt = loadPrompt('composer-system')
  const { data } = input
  const images = data.evidence.filter((e) => e.artifactPath && IMAGE_RE.test(e.artifactPath))
  const artifactLines = (artifacts: Artifact[]) =>
    artifacts
      .map(
        (a) =>
          `${a.ref} [${a.type} · ${a.placement} · priority ${a.priority}] ${a.title} — answers: ${clip(a.question, 160)}${a.findingIds.length ? ` — supports ${a.findingIds.join(', ')}` : ''}`,
      )
      .join('\n') || '(none)'

  const userPrompt = `# Compose the client report for ${input.audit.url}${input.audit.clientName ? ` (client: ${input.audit.clientName})` : ''}

## Business understanding
${businessText(data)}

## Full analysis (finalizer's executive summary)
${data.row.summary?.executiveSummary ?? '(not available)'}

## Findings (only these IDs exist)
${findingLines(data.findings, 'composer')}

## Opportunities (copy titles exactly)
${opportunityLines(data)}

## Visual artifacts (only these refs exist)
${artifactLines(data.artifacts)}

## Screenshot evidence usable as proof (only these)
${images.map((e) => `${e.ref} ${clip(e.title, 120)}${e.url ? ` — ${e.url}` : ''}`).join('\n') || '(none)'}

## Coverage of this audit
${coverageLines(data.coverage)}

## Comparison with the previous audit
${comparisonText(input.comparison)}

Return the report plan.`

  const outcome = await runRole(ctx, provider, {
    role: 'composer',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(ReportPlan),
    model: config.PRESENTER_MODEL ?? config.AUDITOR_MODEL,
    effort: config.PRESENTER_EFFORT ?? 'medium',
    maxTurns: 6,
    timeoutMs: minutes(15),
    tools: [],
    allowedTools: [],
    mcp: { browser: false, audit: false },
  })
  const { result, agentRunId } = outcome
  if (result.status === 'cancelled') throw new AiStageError('Report Composer was cancelled', agentRunId, true)
  if (result.status !== 'completed') throw new AiStageError(`Report Composer failed: ${result.error ?? 'unknown error'}`, agentRunId)
  const parsed = ReportPlan.safeParse(result.output)
  if (!parsed.success) {
    const message = parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')
    await updateAgentRun(ctx.db, agentRunId, { validation: { issues: [message], issueCount: 1 } })
    throw new AiStageError(`Report Composer returned an invalid plan: ${message}`, agentRunId)
  }
  const { plan, issues } = sanitizeReportPlan(parsed.data, {
    findings: new Set(data.findings.map((f) => f.ref)),
    artifacts: new Set(data.artifacts.map((a) => a.ref)),
    images: new Set(images.map((e) => e.ref)),
    opportunityTitles: (data.row.summary?.opportunities ?? []).map((o) => o.title),
  })
  await updateAgentRun(ctx.db, agentRunId, {
    validation: { issues: issues.slice(0, 200), issueCount: issues.length, usable: plan !== null },
  })
  if (plan) await ctx.ws.writeJson('agent/report-plan.json', plan)
  return { agentRunId, plan, issues }
}
