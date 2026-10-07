import { z } from 'zod'
import { Category, EffortLevel, FindingType, ImpactLevel, Severity, VerificationStatus } from './enums.ts'

/**
 * Structured outputs produced by the AI roles. These are validated twice:
 * once by the Claude CLI (`--json-schema`) and again here with Zod before anything is persisted.
 */

const Confidence = z.number().min(0).max(1).describe('0..1. How certain you are, given the evidence.')
const EvidenceIds = z
  .array(z.string())
  .describe('IDs of recorded evidence (e.g. "EV-12") that support this. Only use IDs that exist.')

export const Opportunity = z.object({
  title: z.string().min(3).describe('Short name of the service/work item, e.g. "Conversion tracking setup".'),
  description: z.string().describe('What the work would involve and what it would improve.'),
  impact: z.enum(['high', 'medium', 'low']),
  effort: EffortLevel,
})
export type Opportunity = z.infer<typeof Opportunity>

export const BusinessUnderstanding = z.object({
  summary: z.string().describe('What the business does and what the website appears designed to achieve.'),
  businessType: z.string().describe('e.g. "B2C e-commerce", "Local service lead generation", "SaaS".'),
  likelyCustomers: z.string(),
  primaryConversion: z
    .string()
    .describe('The most likely primary conversion action, e.g. "WhatsApp enquiry".'),
  secondaryConversions: z.array(z.string()),
  confidence: Confidence,
  assumptions: z.array(z.string()).describe('Assumptions you made that are not directly proven.'),
  evidenceIds: EvidenceIds,
})
export type BusinessUnderstanding = z.infer<typeof BusinessUnderstanding>

export const Technology = z.object({
  name: z.string(),
  category: z.string().describe('e.g. "CMS", "Analytics", "CDN", "JS framework", "Tag manager".'),
  confidence: Confidence,
  evidenceIds: EvidenceIds,
})
export type Technology = z.infer<typeof Technology>

export const PageType = z.object({
  type: z.string().describe('e.g. "Homepage", "Product detail", "Service page", "Contact".'),
  exampleUrls: z.array(z.string()),
  notes: z.string(),
})
export type PageType = z.infer<typeof PageType>

const findingCore = {
  title: z.string().min(5).describe('Specific, factual headline. No hype.'),
  category: Category,
  severity: Severity,
  type: FindingType,
  description: z.string().describe('The problem, stated precisely.'),
  observed: z.string().describe('What was actually observed or measured, with concrete values.'),
  affectedUrls: z.array(z.string()),
  confidence: Confidence,
  evidenceIds: EvidenceIds,
  whyItMatters: z.string().describe('The mechanism connecting the issue to users or the business.'),
  businessImpact: z
    .string()
    .describe('Who is affected and what behaviour it could influence. No invented numbers.'),
  businessImpactLevel: ImpactLevel,
  recommendation: z.string().describe('Concrete, actionable fix an engineer can act on.'),
  effort: EffortLevel.describe('Rough effort to fix.'),
  opportunity: Opportunity.nullable().describe('Client-work opportunity this finding exposes, if any.'),
}

export const DraftFinding = z.object({
  id: z.string().describe('Your local ID for this finding, e.g. "D1", "D2". Unique within the draft.'),
  ...findingCore,
})
export type DraftFinding = z.infer<typeof DraftFinding>

export const AuditDraft = z.object({
  businessUnderstanding: BusinessUnderstanding,
  importantPageTypes: z.array(PageType),
  investigationSummary: z
    .string()
    .describe('Concise summary of what you investigated and how (not your private reasoning).'),
  pagesInspected: z.array(z.string()).describe('URLs you actually inspected.'),
  technologies: z.array(Technology),
  findings: z.array(DraftFinding),
  limitations: z.array(z.string()).describe('What you could not check or verify, and why.'),
  suggestedFurtherVerification: z.array(z.string()),
})
export type AuditDraft = z.infer<typeof AuditDraft>

export const ReviewResult = z.object({
  overallAssessment: z.string().describe('Short assessment of the draft quality and its main weaknesses.'),
  approvedFindings: z.array(z.object({ findingId: z.string(), note: z.string() })),
  rejectedFindings: z.array(z.object({ findingId: z.string(), reason: z.string() })),
  findingsNeedingVerification: z.array(
    z.object({ findingId: z.string(), concern: z.string(), suggestedCheck: z.string() }),
  ),
  severityAdjustments: z.array(
    z.object({ findingId: z.string(), from: Severity, to: Severity, reason: z.string() }),
  ),
  duplicates: z.array(z.object({ findingIds: z.array(z.string()), reason: z.string() })),
  missingAreas: z.array(
    z.object({
      area: z.string(),
      why: z.string(),
      suggestedCheck: z.string(),
      importance: z.enum(['high', 'medium', 'low']),
    }),
  ),
  priorityProblems: z.array(z.object({ description: z.string(), findingIds: z.array(z.string()) })),
  materialGaps: z
    .boolean()
    .describe('True only if a focused verification pass would materially change the audit.'),
})
export type ReviewResult = z.infer<typeof ReviewResult>

export const FinalFinding = z.object({
  id: z.string().describe('Final ID, e.g. "F1". Order findings by priority.'),
  sourceFindingIds: z
    .array(z.string())
    .min(1)
    .describe('Draft finding IDs this final finding is derived from. Never empty.'),
  ...findingCore,
  verificationStatus: VerificationStatus,
})
export type FinalFinding = z.infer<typeof FinalFinding>

export const FinalOpportunity = z.object({
  title: z.string(),
  description: z.string(),
  relatedFindingIds: z.array(z.string()).describe('Final finding IDs (F*) this opportunity addresses.'),
  impact: z.enum(['high', 'medium', 'low']),
  effort: EffortLevel,
})
export type FinalOpportunity = z.infer<typeof FinalOpportunity>

export const FinalAudit = z.object({
  executiveSummary: z
    .string()
    .describe('3–6 short paragraphs for a business owner. Plain language, evidence-based, no hype.'),
  businessUnderstanding: BusinessUnderstanding,
  importantPageTypes: z.array(PageType),
  technologies: z.array(Technology),
  findings: z.array(FinalFinding),
  opportunities: z.array(FinalOpportunity).describe('Prioritized, highest value first.'),
  limitations: z.array(z.string()),
  pagesInspected: z.array(z.string()),
})
export type FinalAudit = z.infer<typeof FinalAudit>

/** JSON Schema used for the Claude CLI `--json-schema` flag. */
export function toAgentJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-07', io: 'output' }) as Record<string, unknown>
  delete json.$schema
  return json
}
