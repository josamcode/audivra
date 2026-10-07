import { getConfig } from '@audivra/config'
import type { AuditContext } from '@audivra/audit-core'
import {
  AuditDraft,
  FinalAudit,
  ReviewResult,
  toAgentJsonSchema,
  type ActivityEvent,
  type EvidenceItem,
  type FindingBrief,
  type SystemStatus,
} from '@audivra/contracts'
import { listEvidence, updateAgentRun } from '@audivra/database'
import { loadPrompt } from '../prompts.ts'
import type { AgentProvider } from '../provider.ts'
import {
  OutputValidationError,
  validateDraft,
  validateFinal,
  validateReview,
  type ValidationIssue,
} from '../validate.ts'
import {
  INVESTIGATOR_ALLOWED,
  INVESTIGATOR_DENIED,
  INVESTIGATOR_TOOLS,
  REVIEWER_ALLOWED,
  REVIEWER_TOOLS,
  runRole,
  type RoleRunOutcome,
} from './run-role.ts'

export class AiStageError extends Error {
  constructor(
    message: string,
    readonly agentRunId: string | null,
    readonly cancelled = false,
  ) {
    super(message)
    this.name = 'AiStageError'
  }
}

export interface AuditTarget {
  id: string
  url: string
  domain: string
  clientName: string | null
}

export function evidenceIndex(items: EvidenceItem[]): string {
  return items
    .map(
      (e) =>
        `${e.ref} [${e.type}] (${e.source}) ${e.title}${e.url ? ` — ${e.url}` : ''}${e.artifactPath ? ` — file: ${e.artifactPath}` : ''}`,
    )
    .join('\n')
}

function toolList(tools: SystemStatus, auditId: string): string {
  return tools.tools
    .map((t) => {
      // Container hints carry the audit ID so Audivra can stop exactly these containers later.
      const command = t.command?.replaceAll('<audit>', auditId)
      return `- ${t.name}: ${t.state}${t.version ? ` ${t.version}` : ''}${command && t.state === 'ready' ? ` — use: \`${command}\`` : ''}${t.state !== 'ready' && t.detail ? ` (${t.detail})` : ''}`
    })
    .join('\n')
}

function assertSucceeded(outcome: RoleRunOutcome, label: string): void {
  const { result, agentRunId } = outcome
  if (result.status === 'cancelled') throw new AiStageError(`${label} was cancelled`, agentRunId, true)
  if (result.status !== 'completed')
    throw new AiStageError(`${label} failed: ${result.error ?? 'unknown error'}`, agentRunId)
}

async function recordValidation(
  ctx: AuditContext,
  agentRunId: string,
  issues: ValidationIssue[],
  extra: Record<string, unknown> = {},
) {
  await updateAgentRun(ctx.db, agentRunId, {
    validation: { issues: issues.slice(0, 200), issueCount: issues.length, ...extra },
  })
  if (issues.length) {
    await ctx.event(
      'agent.note',
      `Output validation adjusted ${issues.length} item(s) (e.g. ${issues[0]!.message})`,
      { role: 'system' },
      'warn',
    )
  }
}

function validationFailure(error: unknown, agentRunId: string, label: string): never {
  if (error instanceof OutputValidationError) {
    throw new AiStageError(
      `${label} returned invalid output: ${error.issues.slice(0, 3).join('; ')}`,
      agentRunId,
    )
  }
  throw error
}

const minutes = (n: number) => n * 60_000

/** Safety ceilings for an investigation run (scaled for the shorter revision pass). */
function investigationLimits(scale = 1): Record<string, number> {
  const config = getConfig()
  return {
    browser: Math.round(config.AUDITOR_MAX_BROWSER_ACTIONS * scale),
    terminal: Math.round(config.AUDITOR_MAX_COMMANDS * scale),
    total: Math.round(config.AUDITOR_MAX_TOOL_CALLS * scale),
  }
}

const INVESTIGATION_WRAP_UP =
  'Do not investigate further. Using only the evidence you have already recorded and what you have already observed, return the complete structured audit draft now. Keep findings whose evidence is recorded, lower the confidence of anything you could not finish verifying, and list unfinished checks under limitations.'

export async function runAuditor(
  ctx: AuditContext,
  provider: AgentProvider,
  input: { audit: AuditTarget; baselineSummary: string; tools: SystemStatus; evidence: EvidenceItem[] },
): Promise<{ agentRunId: string; sessionId: string | null; draft: AuditDraft; issues: ValidationIssue[] }> {
  const config = getConfig()
  const prompt = loadPrompt('auditor-system')
  const budget = config.AUDITOR_TIMEOUT_MINUTES
  const deadline = new Date(Date.now() + minutes(budget * 0.8))
  const limits = investigationLimits()
  const userPrompt = `# Audit task

Target website: ${input.audit.url}
${input.audit.clientName ? `Client / project: ${input.audit.clientName}\n` : ''}Audit ID: ${input.audit.id}
Working directory (audit workspace): ${ctx.ws.root}

Time budget: about ${budget} minutes in total. Started at ${new Date().toISOString()}. Aim to have your structured output ready by ${deadline.toISOString()} — check \`date\` occasionally.
Safety ceilings (not targets — typical audits use a small fraction): ${limits.browser} browser actions, ${limits.terminal} terminal commands, ${limits.total} tool calls in total. If a ceiling or the time budget is reached, your tools are switched off and you will be asked to write up from the evidence already recorded — so record evidence as you go.

## What already happened
A deterministic baseline inspection ran before you. Its digest is below and its files are in \`baseline/\`, \`screenshots/\`, \`browser/\`, \`tools/\` and \`network/\`. Treat it as leads, not truth: verify material claims before relying on them.

## Available tools on this machine
${toolList(input.tools, input.audit.id)}
- Browser: MCP server \`browser\` (headless Chromium; isolated session)
- Evidence: MCP server \`audit\` (record_evidence, list_evidence, get_evidence, log_activity)

Passive only: Nuclei, ZAP active scans and any other active/offensive tooling are out of scope even if present.
The baseline already ran the ready scanners; read their reports in \`tools/\` before re-running anything. If you start a Docker container, keep the \`--name audivra-${input.audit.id}-…\` naming shown above: Audivra stops exactly those containers when the audit ends.

## Evidence recorded so far
${evidenceIndex(input.evidence)}

## Baseline digest
${input.baselineSummary}

## Your job
Understand the business, decide what matters, investigate with the browser, terminal and your own scripts, record evidence for everything you will rely on, and return the structured audit draft. Follow the safety rules strictly (no form submissions, purchases, account creation or active security testing).`

  const outcome = await runRole(ctx, provider, {
    role: 'auditor',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(AuditDraft),
    model: config.AUDITOR_MODEL,
    effort: config.AUDITOR_EFFORT,
    maxTurns: config.AUDITOR_MAX_TURNS,
    timeoutMs: minutes(budget),
    tools: INVESTIGATOR_TOOLS,
    allowedTools: INVESTIGATOR_ALLOWED,
    disallowedTools: INVESTIGATOR_DENIED,
    mcp: { browser: true, audit: true },
    toolCallLimits: limits,
    wrapUp: { prompt: INVESTIGATION_WRAP_UP, maxTurns: 8, timeoutMs: minutes(12) },
  })
  assertSucceeded(outcome, 'AI Auditor')
  const existing = new Set(await listRefs(ctx))
  try {
    const { draft, issues } = validateDraft(outcome.result.output, existing)
    await ctx.ws.writeJson('agent/draft.json', draft)
    await recordValidation(ctx, outcome.agentRunId, issues, { findings: draft.findings.length })
    return { agentRunId: outcome.agentRunId, sessionId: outcome.result.sessionId, draft, issues }
  } catch (error) {
    validationFailure(error, outcome.agentRunId, 'AI Auditor')
  }
}

async function listRefs(ctx: AuditContext): Promise<string[]> {
  return (await listEvidence(ctx.db, ctx.auditId)).map((e) => e.ref)
}

function activityDigest(events: ActivityEvent[]): string {
  const notes = events.filter((e) => e.type === 'agent.note').map((e) => `- ${e.message}`)
  const actions = events.filter((e) => e.type === 'agent.activity')
  const opened = [
    ...new Set(
      actions
        .filter((e) => e.message.startsWith('Browser: Opened'))
        .map((e) => e.message.replace('Browser: Opened ', '')),
    ),
  ]
  const scripts = actions
    .filter((e) => e.message.startsWith('Created script'))
    .map((e) => e.message.replace('Created script ', ''))
  const terminal = actions
    .filter((e) => e.message.startsWith('Terminal:'))
    .map((e) => `- ${e.message.slice(10, 200)}`)
  return [
    '### Auditor notes',
    notes.join('\n') || '- (none)',
    `### Pages opened in the browser (${opened.length})`,
    opened
      .slice(0, 60)
      .map((u) => `- ${u}`)
      .join('\n') || '- (none)',
    `### Scripts written (${scripts.length})`,
    scripts.map((s) => `- ${s}`).join('\n') || '- (none)',
    `### Terminal commands (${terminal.length}, first 40)`,
    terminal.slice(0, 40).join('\n') || '- (none)',
    `### Tool activity counts`,
    `browser ${actions.filter((e) => e.data?.kind === 'browser').length}, terminal ${terminal.length}, files ${actions.filter((e) => e.data?.kind === 'file').length}`,
  ].join('\n')
}

export async function runReviewer(
  ctx: AuditContext,
  provider: AgentProvider,
  input: {
    audit: AuditTarget
    draft: AuditDraft
    baselineSummary: string
    evidence: EvidenceItem[]
    activity: ActivityEvent[]
  },
): Promise<{ agentRunId: string; review: ReviewResult; issues: ValidationIssue[] }> {
  const config = getConfig()
  const prompt = loadPrompt('reviewer-system')
  const userPrompt = `# Review task

Target website: ${input.audit.url}${input.audit.clientName ? ` (client: ${input.audit.clientName})` : ''}
Working directory (audit workspace, read-only for you): ${ctx.ws.root}
The draft is also saved at agent/draft.json; the baseline digest at baseline/summary.md.

## Audit draft
\`\`\`json
${JSON.stringify(input.draft, null, 2)}
\`\`\`

## Evidence index (the only evidence that exists)
${evidenceIndex(input.evidence)}

## What the auditor did (activity summary)
${activityDigest(input.activity)}

## Baseline digest
${input.baselineSummary}

Review the draft adversarially and return your structured feedback.`

  const outcome = await runRole(ctx, provider, {
    role: 'reviewer',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(ReviewResult),
    model: config.REVIEWER_MODEL ?? config.AUDITOR_MODEL,
    effort: config.REVIEWER_EFFORT,
    maxTurns: 80,
    timeoutMs: minutes(25),
    tools: REVIEWER_TOOLS,
    allowedTools: REVIEWER_ALLOWED,
    mcp: { browser: false, audit: true },
    wrapUp: {
      prompt:
        'Return your structured review now from what you have checked. Findings you did not get to check go under findingsNeedingVerification only if they are high or critical; otherwise approve them with the note "not checked in depth".',
      maxTurns: 6,
      timeoutMs: minutes(8),
    },
  })
  assertSucceeded(outcome, 'AI Reviewer')
  try {
    const { review, issues } = validateReview(outcome.result.output, input.draft)
    await ctx.ws.writeJson('agent/review.json', review)
    await recordValidation(ctx, outcome.agentRunId, issues, {
      approved: review.approvedFindings.length,
      rejected: review.rejectedFindings.length,
      needsVerification: review.findingsNeedingVerification.length,
      materialGaps: review.materialGaps,
    })
    return { agentRunId: outcome.agentRunId, review, issues }
  } catch (error) {
    validationFailure(error, outcome.agentRunId, 'AI Reviewer')
  }
}

export async function runRevision(
  ctx: AuditContext,
  provider: AgentProvider,
  input: {
    audit: AuditTarget
    draft: AuditDraft
    review: ReviewResult
    auditorSessionId: string | null
    baselineSummary: string
    evidence: EvidenceItem[]
  },
): Promise<{ agentRunId: string; draft: AuditDraft; issues: ValidationIssue[] }> {
  const config = getConfig()
  const prompt = loadPrompt('auditor-system')
  const budget = Math.max(10, Math.round(config.AUDITOR_TIMEOUT_MINUTES / 2))
  const feedback = `## Reviewer feedback
\`\`\`json
${JSON.stringify(input.review, null, 2)}
\`\`\`

## Your task now: one focused verification pass
Time budget: about ${budget} minutes (started ${new Date().toISOString()}).
1. For each finding in \`findingsNeedingVerification\`, perform the suggested check (or a better one) with the browser/terminal/scripts and record evidence for what you find. Then confirm, correct, downgrade or drop the finding.
2. Investigate the \`missingAreas\` marked high importance (briefly, medium ones if time allows). Add findings only when evidence supports them.
3. Address severity adjustments, duplicates and unsupported claims the reviewer raised: fix the draft where the reviewer is right; keep your position where your evidence is stronger.
4. Return the COMPLETE revised draft in the same structured format. Keep IDs of retained findings unchanged; give new findings new IDs (continue numbering). Note anything you could not verify in limitations.
Do not repeat the whole audit — this is a focused pass.`

  const resume = input.auditorSessionId ?? undefined
  const userPrompt = resume
    ? `The reviewer has challenged your draft.\n\n${feedback}`
    : `# Verification pass for ${input.audit.url}
Working directory (audit workspace): ${ctx.ws.root}

## Your earlier draft
\`\`\`json
${JSON.stringify(input.draft, null, 2)}
\`\`\`

## Evidence recorded so far
${evidenceIndex(input.evidence)}

## Baseline digest
${input.baselineSummary}

${feedback}`

  const run = (resumeSessionId?: string) =>
    runRole(ctx, provider, {
      role: 'revision',
      prompt,
      userPrompt,
      jsonSchema: toAgentJsonSchema(AuditDraft),
      model: config.AUDITOR_MODEL,
      effort: config.AUDITOR_EFFORT,
      maxTurns: Math.round(config.AUDITOR_MAX_TURNS / 2),
      timeoutMs: minutes(budget),
      tools: INVESTIGATOR_TOOLS,
      allowedTools: INVESTIGATOR_ALLOWED,
      disallowedTools: INVESTIGATOR_DENIED,
      mcp: { browser: true, audit: true },
      resumeSessionId,
      toolCallLimits: investigationLimits(0.5),
      wrapUp: { prompt: INVESTIGATION_WRAP_UP, maxTurns: 8, timeoutMs: minutes(12) },
    })

  const outcome = await run(resume)
  assertSucceeded(outcome, 'Verification pass')
  const existing = new Set(await listRefs(ctx))
  try {
    const { draft, issues } = validateDraft(outcome.result.output, existing)
    await ctx.ws.writeJson('agent/draft-revised.json', draft)
    await recordValidation(ctx, outcome.agentRunId, issues, { findings: draft.findings.length })
    return { agentRunId: outcome.agentRunId, draft, issues }
  } catch (error) {
    validationFailure(error, outcome.agentRunId, 'Verification pass')
  }
}

function previousKeys(previous: FindingBrief[]): string {
  const keyed = previous.filter((f) => f.issueKey)
  if (keyed.length === 0) return 'None — this is the first audit of this site (or earlier audits had no keys). Create new keys.'
  return [
    'Reuse a key exactly when a final finding describes the same underlying issue:',
    ...keyed.map((f) => `- ${f.issueKey} — ${f.title} (${f.severity}, ${f.category})`),
  ].join('\n')
}

export async function runFinalizer(
  ctx: AuditContext,
  provider: AgentProvider,
  input: {
    audit: AuditTarget
    draft: AuditDraft
    review: ReviewResult | null
    revised: boolean
    evidence: EvidenceItem[]
    /** Findings of the previous audit of the same site (for stable issue keys). */
    previous?: FindingBrief[]
  },
): Promise<{ agentRunId: string; final: FinalAudit; issues: ValidationIssue[] }> {
  const config = getConfig()
  const prompt = loadPrompt('finalizer-system')
  const userPrompt = `# Finalize the audit of ${input.audit.url}${input.audit.clientName ? ` (client: ${input.audit.clientName})` : ''}

Revision pass happened: ${input.revised ? 'YES — the draft below is the revised draft and supersedes reviewer concerns it addressed.' : 'NO'}

## Draft
\`\`\`json
${JSON.stringify(input.draft, null, 2)}
\`\`\`

## Reviewer feedback
${input.review ? `\`\`\`json\n${JSON.stringify(input.review, null, 2)}\n\`\`\`` : 'No review is available (the review step failed or was skipped). Treat all findings as unreviewed.'}

## Evidence index (only these IDs exist)
${evidenceIndex(input.evidence)}

## Issue keys from the previous audit of this site
${previousKeys(input.previous ?? [])}

Produce the final structured audit.`

  const outcome = await runRole(ctx, provider, {
    role: 'finalizer',
    prompt,
    userPrompt,
    jsonSchema: toAgentJsonSchema(FinalAudit),
    model: config.FINALIZER_MODEL ?? config.AUDITOR_MODEL,
    effort: config.FINALIZER_EFFORT,
    maxTurns: 6,
    timeoutMs: minutes(20),
    tools: [],
    allowedTools: [],
    mcp: { browser: false, audit: false },
  })
  assertSucceeded(outcome, 'Finalizer')
  const existing = new Set(await listRefs(ctx))
  try {
    const { final, issues } = validateFinal(outcome.result.output, input.draft, input.review, existing)
    await ctx.ws.writeJson('final/audit.json', final)
    await recordValidation(ctx, outcome.agentRunId, issues, { findings: final.findings.length })
    return { agentRunId: outcome.agentRunId, final, issues }
  } catch (error) {
    validationFailure(error, outcome.agentRunId, 'Finalizer')
  }
}
