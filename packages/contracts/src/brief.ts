import { z } from 'zod'
import { EnrichmentStatus } from './journeys.ts'

/**
 * Client Brief: prepares the user to talk to the client about this site, from the finalized audit
 * (business understanding, journeys, findings, evidence, opportunities, changes). It is not an email
 * generator and it never re-browses the site. All four modes come from one structured output.
 */

const FindingId = z.string().describe('A finding ID (F*) from the task message.')

export const BriefIssue = z.object({
  findingId: FindingId,
  headline: z.string().min(5).max(160).describe('The issue in plain words, specific to this site.'),
  why: z.string().max(300).describe('One sentence: why it matters for this business.'),
})
export type BriefIssue = z.infer<typeof BriefIssue>

export const BriefProof = z.object({
  text: z.string().min(5).max(240).describe('A concrete, checkable fact from the audit, e.g. "No conversion event was observed when the WhatsApp button was exercised".'),
  findingId: z.string().nullable(),
  evidenceId: z.string().nullable().describe('Evidence ID (EV-*) that shows it, when one exists.'),
})
export type BriefProof = z.infer<typeof BriefProof>

export const ClientBriefContent = z.object({
  businessSummary: z.string().max(400).describe('What the business does, in one or two sentences (state uncertainty).'),
  primaryConversion: z.string().max(160),
  primaryJourney: z
    .object({
      journeyId: z.string().describe('Journey ID (J*) from the task message.'),
      path: z.string().max(200).describe('Step labels joined with " → ".'),
      biggestFriction: z.string().max(240).describe('The most important problem on this journey, or that none was found.'),
    })
    .nullable(),
  quick: z.object({
    topIssues: z.array(BriefIssue).min(1).max(3),
    bestOpportunity: z
      .object({
        title: z.string().max(120),
        why: z.string().max(300),
        findingIds: z.array(z.string()),
      })
      .nullable(),
    proofPoints: z.array(BriefProof).max(4),
    suggestedOpener: z
      .string()
      .max(420)
      .describe('A professional, specific observation the user could open a conversation with. No hype, no promises, no numbers that are not in the audit.'),
  }),
  meeting: z.object({
    context: z.string().max(700).describe('Business context and what the site is for.'),
    journeys: z.array(z.object({ journeyId: z.string(), summary: z.string().max(240) })).max(3),
    topIssues: z.array(BriefIssue).max(5),
    sinceLastAudit: z.array(z.string().max(240)).max(5).describe('What changed since the previous audit. Empty when there is no previous audit.'),
    questions: z
      .array(z.object({ question: z.string().max(240), basis: z.string().max(240).describe('The uncertainty in the audit this question resolves.') }))
      .max(6),
    uncertainties: z.array(z.string().max(240)).max(5).describe('What the audit could not establish, stated plainly.'),
    opportunities: z.array(z.object({ title: z.string().max(120), why: z.string().max(300) })).max(4),
    proofToShow: z.array(BriefProof).max(5),
  }),
  talkingPoints: z.array(z.string().min(5).max(220)).min(3).max(8).describe('Short points to speak from, in the first person, not a script.'),
  technical: z.object({
    items: z
      .array(
        z.object({
          findingId: FindingId,
          title: z.string().max(140),
          evidence: z.string().max(240).describe('What the evidence shows, with concrete values.'),
          likelyCause: z.string().max(240).describe('The likely root cause, marked as likely when not proven.'),
          direction: z.string().max(300).describe('Recommended implementation direction.'),
          pages: z.array(z.string()).max(5),
          priority: z.enum(['now', 'next', 'later']),
        }),
      )
      .max(8),
  }),
})
export type ClientBriefContent = z.infer<typeof ClientBriefContent>

export const BRIEF_MODES = ['quick', 'meeting', 'talking-points', 'technical'] as const
export const BriefMode = z.enum(BRIEF_MODES)
export type BriefMode = z.infer<typeof BriefMode>

export const ClientBriefItem = z.object({
  id: z.string(),
  auditId: z.string(),
  content: ClientBriefContent,
  promptVersion: z.string(),
  createdAt: z.string(),
})
export type ClientBriefItem = z.infer<typeof ClientBriefItem>

export const AuditBrief = z.object({ brief: ClientBriefItem.nullable(), status: EnrichmentStatus })
export type AuditBrief = z.infer<typeof AuditBrief>

export const BRIEF_MODE_LABELS: Record<BriefMode, string> = {
  quick: 'Quick brief',
  meeting: 'Meeting prep',
  'talking-points': 'Talking points',
  technical: 'Technical brief',
}

const PRIORITY_LABEL = { now: 'Now', next: 'Next', later: 'Later' } as const

/**
 * Plain-text (Markdown) rendering of one brief mode, for pasting into notes. References (F3, EV-12,
 * J1) are kept so every point can be traced back to the audit.
 */
export function briefText(content: ClientBriefContent, mode: BriefMode, site?: string): string {
  const out: string[] = []
  const section = (title: string) => out.push('', `## ${title}`)
  const proof = (p: BriefProof) => `- ${p.text}${[p.findingId, p.evidenceId].filter(Boolean).length ? ` (${[p.findingId, p.evidenceId].filter(Boolean).join(', ')})` : ''}`
  out.push(`# ${BRIEF_MODE_LABELS[mode]}${site ? ` — ${site}` : ''}`)

  if (mode === 'quick') {
    out.push('', content.businessSummary, '', `Primary conversion: ${content.primaryConversion}`)
    if (content.primaryJourney) {
      out.push(`Primary journey (${content.primaryJourney.journeyId}): ${content.primaryJourney.path}`, `Biggest friction: ${content.primaryJourney.biggestFriction}`)
    }
    section('Top issues')
    content.quick.topIssues.forEach((issue, index) => out.push(`${index + 1}. ${issue.headline} (${issue.findingId}) — ${issue.why}`))
    if (content.quick.bestOpportunity) {
      const best = content.quick.bestOpportunity
      section('Best opportunity')
      out.push(`${best.title}${best.findingIds.length ? ` (${best.findingIds.join(', ')})` : ''} — ${best.why}`)
    }
    if (content.quick.proofPoints.length) {
      section('Proof points')
      content.quick.proofPoints.forEach((p) => out.push(proof(p)))
    }
    section('Suggested opener')
    out.push(content.quick.suggestedOpener)
  } else if (mode === 'meeting') {
    section('Context')
    out.push(content.meeting.context)
    if (content.meeting.journeys.length) {
      section('Journeys')
      content.meeting.journeys.forEach((j) => out.push(`- ${j.journeyId}: ${j.summary}`))
    }
    if (content.meeting.topIssues.length) {
      section('Top issues')
      content.meeting.topIssues.forEach((issue, index) => out.push(`${index + 1}. ${issue.headline} (${issue.findingId}) — ${issue.why}`))
    }
    if (content.meeting.sinceLastAudit.length) {
      section('Since the last audit')
      content.meeting.sinceLastAudit.forEach((line) => out.push(`- ${line}`))
    }
    if (content.meeting.questions.length) {
      section('Questions to ask')
      content.meeting.questions.forEach((q) => out.push(`- ${q.question}`, `  Why: ${q.basis}`))
    }
    if (content.meeting.uncertainties.length) {
      section('What the audit could not establish')
      content.meeting.uncertainties.forEach((line) => out.push(`- ${line}`))
    }
    if (content.meeting.opportunities.length) {
      section('Opportunities')
      content.meeting.opportunities.forEach((o) => out.push(`- ${o.title} — ${o.why}`))
    }
    if (content.meeting.proofToShow.length) {
      section('Proof to show')
      content.meeting.proofToShow.forEach((p) => out.push(proof(p)))
    }
  } else if (mode === 'talking-points') {
    out.push('')
    content.talkingPoints.forEach((point) => out.push(`- ${point}`))
  } else {
    for (const item of content.technical.items) {
      section(`${item.findingId} · ${item.title} (${PRIORITY_LABEL[item.priority]})`)
      out.push(`Evidence: ${item.evidence}`, `Likely cause: ${item.likelyCause}`, `Direction: ${item.direction}`)
      if (item.pages.length) out.push(`Pages: ${item.pages.join(', ')}`)
    }
  }
  return `${out.join('\n').trim()}\n`
}
