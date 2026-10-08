import { getConfig } from '@audivra/config'
import type { AuditContext } from '@audivra/audit-core'
import {
  ChangeAnalysis,
  ClientBriefContent,
  JourneyAnalysis,
  toAgentJsonSchema,
  type AuditComparison,
  type ChangeReportItem,
  type ClientBriefContent as ClientBrief,
  type JourneyAnalysis as Analysis,
  type LimitationItem,
} from '@audivra/contracts'
import { updateAgentRun } from '@audivra/database'
import { changeFactIndex, changeFactsText, evidenceKind, type AuditData } from '@audivra/insights'
import { loadPrompt } from '../prompts.ts'
import type { AgentProvider } from '../provider.ts'
import { validateChangeAnalysis, validateClientBrief, validateJourneyAnalysis } from '../validate-intelligence.ts'
import { OutputValidationError, type ValidationIssue } from '../validate.ts'
import { AiStageError, evidenceIndex, focusLine, type AuditTarget } from './index.ts'
import { runRole } from './run-role.ts'

/*
 * On-demand roles over a finished audit. None of them browses the live site: they work from
 * persisted, validated audit data, so they are cheap and can be regenerated explicitly.
 */

const minutes = (n: number) => n * 60_000
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

async function finish<T>(
  ctx: AuditContext,
  outcome: { agentRunId: string; result: { status: string; error: string | null; output: unknown } },
  label: string,
  validate: (output: unknown) => { value: T; issues: ValidationIssue[] },
): Promise<{ agentRunId: string; value: T; issues: ValidationIssue[] }> {
  const { result, agentRunId } = outcome
  if (result.status === 'cancelled') throw new AiStageError(`${label} was cancelled`, agentRunId, true)
  if (result.status !== 'completed') throw new AiStageError(`${label} failed: ${result.error ?? 'unknown error'}`, agentRunId)
  try {
    const { value, issues } = validate(result.output)
    await updateAgentRun(ctx.db, agentRunId, { validation: { issues: issues.slice(0, 200), issueCount: issues.length } })
    return { agentRunId, value, issues }
  } catch (error) {
    if (error instanceof OutputValidationError) {
      await updateAgentRun(ctx.db, agentRunId, { status: 'failed', error: `Invalid output: ${error.issues.slice(0, 3).join('; ')}` })
      throw new AiStageError(`${label} returned invalid output: ${error.issues.slice(0, 3).join('; ')}`, agentRunId)
    }
    throw error
  }
}

function businessLines(data: AuditData): string {
  const b = data.row.summary?.businessUnderstanding
  if (!b) return '(not available)'
  return [
    `${b.summary}`,
    `Type: ${b.businessType}${b.businessModel ? ` · Model: ${b.businessModel}` : ''} · Customers: ${b.likelyCustomers}`,
    `Primary conversion: ${b.primaryConversion}${b.secondaryConversions.length ? ` · Secondary: ${b.secondaryConversions.join(', ')}` : ''}`,
    `Confidence: ${b.confidence}${b.assumptions.length ? ` · Assumptions: ${b.assumptions.join('; ')}` : ''}`,
  ].join('\n')
}

function findingLines(data: AuditData, detail: 'brief' | 'analysis'): string {
  if (data.findings.length === 0) return '(no findings)'
  return data.findings
    .map((f) => {
      const head = `${f.ref} [${f.severity} · ${f.category} · ${f.type} · ${f.verificationStatus} · ${f.businessImpactLevel} impact · effort ${f.effort}] ${f.title}`
      const lines = [head, `   Pages: ${f.affectedUrls.slice(0, 4).join(', ') || '—'} · Evidence: ${f.evidenceRefs.join(', ') || 'none'}${f.journeyRefs.length ? ` · Journeys: ${f.journeyRefs.join(', ')}` : ''}`]
      lines.push(`   Observed: ${clip(oneLine(f.observed), detail === 'brief' ? 360 : 220)}`)
      if (detail === 'brief') {
        lines.push(`   Why it matters: ${clip(oneLine(f.whyItMatters), 260)}`)
        lines.push(`   Recommendation: ${clip(oneLine(f.recommendation), 260)}`)
      }
      return lines.join('\n')
    })
    .join('\n')
}

function journeyLines(data: AuditData): string {
  if (data.journeys.length === 0) return '(no journeys recorded for this audit)'
  return data.journeys
    .map((j) => {
      const steps = j.steps.map((s) => `${s.label}${s.url ? ` <${s.url}>` : ''} [${s.status}${s.conversionType ? `, ${s.conversionType}` : ''}]${s.note ? ` — ${clip(oneLine(s.note), 160)}` : ''}${s.evidenceIds.length ? ` (${s.evidenceIds.join(', ')})` : ''}`)
      const health = j.health.map((h) => `${h.dimension}: ${h.status} — ${clip(oneLine(h.note), 160)}${h.findingIds.length ? ` (${h.findingIds.join(', ')})` : ''}`)
      return [
        `${j.ref}${j.isPrimary ? ' (primary)' : ''} ${j.name} [${j.type}] — goal: ${j.goal}`,
        ...steps.map((s, i) => `   ${i + 1}. ${s}`),
        health.length ? `   Health: ${health.join(' · ')}` : '   Health: not assessed',
        j.findingRefs.length ? `   Affected by: ${j.findingRefs.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')
}

function limitationLines(data: AuditData): string {
  const raw = data.row.summary?.limitations ?? []
  const items: LimitationItem[] = raw.map((l) => (typeof l === 'string' ? { kind: 'could-not-verify', text: l } : l))
  return items.map((l) => `- [${l.kind}] ${l.text}`).join('\n') || '(none recorded)'
}

/** Journey analysis for an audit that finished before journeys existed (no browsing; recorded material only). */
export async function runJourneyAnalyst(
  ctx: AuditContext,
  provider: AgentProvider,
  input: { audit: AuditTarget; data: AuditData },
): Promise<{ agentRunId: string; analysis: Analysis; issues: ValidationIssue[] }> {
  const config = getConfig()
  const prompt = loadPrompt('journey-analyst-system')
  const { data } = input
  const surfaces = data.evidence.filter((e) => ['conversion-surface', 'tracking'].includes(evidenceKind(e)))
  const pages = data.pages
    .slice(0, 80)
    .map((p) => `- ${p.url}${p.pageType ? ` [${p.pageType}]` : ''}${p.title ? ` — ${clip(p.title, 80)}` : ''}${p.inspectedInBrowser ? ' (inspected in browser)' : ''}`)
  const userPrompt = `# Identify the journeys of ${input.audit.url}${input.audit.clientName ? ` (client: ${input.audit.clientName})` : ''}
Working directory (audit workspace, read-only for you): ${ctx.ws.root}
The crawl's link structure is in baseline/link-graph.json; rendered DOM and browser reports in browser/; screenshots in screenshots/.
${focusLine(input.audit.template)}

## Business understanding
${businessLines(data)}

## Important page types
${(data.row.summary?.importantPageTypes ?? []).map((t) => `- ${t.type}: ${t.exampleUrls.slice(0, 3).join(', ')}${t.notes ? ` — ${clip(oneLine(t.notes), 140)}` : ''}`).join('\n') || '(not recorded)'}

## Pages (crawl inventory)
${pages.join('\n') || '(none)'}

## Conversion surfaces and tracking observations
${surfaces.map((e) => `- ${e.ref}: ${clip(oneLine(e.title), 140)} — ${clip(oneLine(e.summary), 300)}`).join('\n') || '(none recorded)'}

## Final findings (only these IDs exist)
${findingLines(data, 'analysis')}

## Evidence index (only these IDs exist)
${evidenceIndex(data.evidence)}

Return the journey analysis.`

  const outcome = await runRole(ctx, provider, {
    role: 'journeys',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(JourneyAnalysis),
    model: config.PRESENTER_MODEL ?? config.AUDITOR_MODEL,
    effort: config.PRESENTER_EFFORT ?? 'medium',
    maxTurns: 40,
    timeoutMs: minutes(15),
    tools: ['Read', 'Glob', 'Grep'],
    allowedTools: ['Read(./**)', 'Glob', 'Grep', 'mcp__audit__list_evidence', 'mcp__audit__get_evidence'],
    mcp: { browser: false, audit: true },
    wrapUp: { prompt: 'Return the journey analysis now from what you have looked at.', maxTurns: 4, timeoutMs: minutes(5) },
  })
  const existing = new Set(data.evidence.map((e) => e.ref))
  const findings = new Set(data.findings.map((f) => f.ref))
  const { agentRunId, value, issues } = await finish(ctx, outcome, 'Journey analysis', (output) => {
    const { analysis, issues } = validateJourneyAnalysis(output, existing, findings)
    return { value: analysis, issues }
  })
  await ctx.ws.writeJson('agent/journey-analysis.json', value)
  return { agentRunId, analysis: value, issues }
}

/** Change Intelligence: interprets the deterministic comparison (no tools, compact facts only). */
export async function runChangeAnalyst(
  ctx: AuditContext,
  provider: AgentProvider,
  input: { audit: AuditTarget; comparison: AuditComparison; current: AuditData; previous: AuditData },
): Promise<{ agentRunId: string; analysis: ChangeReportItem['analysis']; promptVersion: string; issues: ValidationIssue[] }> {
  const config = getConfig()
  const prompt = loadPrompt('change-analyst-system')
  const facts = changeFactsText({
    comparison: input.comparison,
    currentFindings: input.current.findings,
    previousFindings: input.previous.findings,
    currentJourneys: input.current.journeys,
    currentEvidence: input.current.evidence,
  })
  const userPrompt = `# What changed on ${input.audit.url} since the previous audit?
${focusLine(input.audit.template)}

## Business
${businessLines(input.current)}

## Deterministic comparison (the facts — do not contradict or extend them)
${facts}

Return the change interpretation.`
  const outcome = await runRole(ctx, provider, {
    role: 'changes',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(ChangeAnalysis),
    model: config.PRESENTER_MODEL ?? config.AUDITOR_MODEL,
    effort: config.PRESENTER_EFFORT ?? 'medium',
    maxTurns: 6,
    timeoutMs: minutes(10),
    tools: [],
    allowedTools: [],
    mcp: { browser: false, audit: false },
  })
  const index = changeFactIndex(input.comparison, input.current.evidence.map((e) => e.ref))
  const previousTitles = new Map(input.previous.findings.map((f) => [f.ref, f.title]))
  const { agentRunId, value, issues } = await finish(ctx, outcome, 'Change intelligence', (output) => {
    const { analysis, issues } = validateChangeAnalysis(output, index, previousTitles)
    return { value: analysis, issues }
  })
  await ctx.ws.writeJson('agent/change-intelligence.json', value)
  return { agentRunId, analysis: value, promptVersion: prompt.version, issues }
}

/** Client Brief from the finalized audit, its journeys and the change interpretation (no tools). */
export async function runBriefWriter(
  ctx: AuditContext,
  provider: AgentProvider,
  input: { audit: AuditTarget; data: AuditData; comparison: AuditComparison | null; changes: ChangeReportItem | null },
): Promise<{ agentRunId: string; brief: ClientBrief; promptVersion: string; issues: ValidationIssue[] }> {
  const config = getConfig()
  const prompt = loadPrompt('client-brief-system')
  const { data } = input
  const cited = new Set([...data.findings.flatMap((f) => f.evidenceRefs), ...data.journeys.flatMap((j) => j.evidenceRefs)])
  const evidence = data.evidence
    .filter((e) => cited.has(e.ref))
    .map((e) => `- ${e.ref}: ${clip(oneLine(e.title), 140)}${e.url ? ` — ${e.url}` : ''}`)
  const opportunities = (data.row.summary?.opportunities ?? [])
    .map((o) => `- "${o.title}" (impact ${o.impact}, effort ${o.effort}; ${o.relatedFindingIds.join(', ') || 'no linked findings'}) — ${clip(oneLine(o.why ?? o.description ?? ''), 220)}`)
    .join('\n')
  const changes = input.changes
    ? [`Headline: ${input.changes.analysis.headline}`, input.changes.analysis.summary, ...input.changes.analysis.insights.map((i) => `- [${i.kind} · ${i.importance} · ${i.basis}] ${i.title}: ${clip(oneLine(i.description), 260)}`)].join('\n')
    : input.comparison
      ? `No interpretation generated. Deterministic summary: ${input.comparison.summary.new} new, ${input.comparison.summary.regressed} regressed, ${input.comparison.summary.improved} improved, ${input.comparison.summary.unchanged} still present, ${input.comparison.summary.resolved} not found again (not found again ≠ fixed).`
      : 'None — this is the first audit of this site.'
  const coverageGaps = data.coverage.filter((c) => c.status !== 'ran' && c.status !== 'not-applicable').map((c) => `- ${c.label}: ${c.status}${c.reason ? ` — ${clip(c.reason, 140)}` : ''}`)
  const userPrompt = `# Prepare a client brief for ${input.audit.url}${input.audit.clientName ? ` (client: ${input.audit.clientName})` : ''}
${focusLine(input.audit.template)}

## Business understanding
${businessLines(data)}

## Journeys (only these IDs exist)
${journeyLines(data)}

## Findings (only these IDs exist; ordered by priority)
${findingLines(data, 'brief')}

## Opportunities
${opportunities || '(none)'}

## Since the previous audit
${changes}

## Limitations and uncertainty
${limitationLines(data)}
${coverageGaps.length ? `Checks that did not fully run:\n${coverageGaps.join('\n')}` : ''}

## Evidence cited by findings and journeys (only these IDs exist)
${evidence.join('\n') || '(none)'}

Return the client brief.`
  const outcome = await runRole(ctx, provider, {
    role: 'brief',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(ClientBriefContent),
    model: config.PRESENTER_MODEL ?? config.AUDITOR_MODEL,
    effort: config.PRESENTER_EFFORT ?? 'medium',
    maxTurns: 6,
    timeoutMs: minutes(10),
    tools: [],
    allowedTools: [],
    mcp: { browser: false, audit: false },
  })
  const refs = {
    findings: new Set(data.findings.map((f) => f.ref)),
    journeys: new Set(data.journeys.map((j) => j.ref)),
    evidence: new Set(data.evidence.map((e) => e.ref)),
  }
  const { agentRunId, value, issues } = await finish(ctx, outcome, 'Client brief', (output) => {
    const { brief, issues } = validateClientBrief(output, refs)
    return { value: brief, issues }
  })
  await ctx.ws.writeJson('agent/client-brief.json', value)
  return { agentRunId, brief: value, promptVersion: prompt.version, issues }
}
