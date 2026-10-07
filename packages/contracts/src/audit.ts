import { z } from 'zod'
import {
  AgentRole,
  AgentRunStatus,
  AuditStage,
  AuditStatus,
  Category,
  EvidenceSource,
  EvidenceType,
  FailureKind,
  FindingType,
  ImpactLevel,
  Severity,
  StepStatus,
  ToolRunStatus,
  VerificationStatus,
  EffortLevel,
} from './enums.ts'
import {
  BusinessUnderstanding,
  FinalOpportunity,
  PageType,
  Technology,
  Opportunity,
} from './agent-outputs.ts'
import { normalizeTargetUrl } from './url.ts'

export const CreateAuditInput = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'Enter a website URL')
    .refine((value) => normalizeTargetUrl(value).ok, { message: 'Enter a valid http(s) website URL' }),
  clientName: z.string().trim().max(120).optional(),
})
export type CreateAuditInput = z.infer<typeof CreateAuditInput>

export const SeverityCounts = z.object({
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  info: z.number(),
})
export type SeverityCounts = z.infer<typeof SeverityCounts>

export const AuditError = z.object({
  kind: FailureKind,
  message: z.string(),
  stage: AuditStage.optional(),
})
export type AuditError = z.infer<typeof AuditError>

export const AuditSummary = z.object({
  executiveSummary: z.string().optional(),
  businessUnderstanding: BusinessUnderstanding.optional(),
  importantPageTypes: z.array(PageType).optional(),
  technologies: z.array(Technology).optional(),
  opportunities: z.array(FinalOpportunity).optional(),
  limitations: z.array(z.string()).optional(),
  pagesInspected: z.array(z.string()).optional(),
})
export type AuditSummary = z.infer<typeof AuditSummary>

export const AuditListItem = z.object({
  id: z.string(),
  url: z.string(),
  domain: z.string(),
  clientName: z.string().nullable(),
  status: AuditStatus,
  stage: AuditStage,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  severityCounts: SeverityCounts,
  findingCount: z.number(),
})
export type AuditListItem = z.infer<typeof AuditListItem>

export const AuditStep = z.object({
  stage: AuditStage,
  status: StepStatus,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  message: z.string().nullable(),
  error: AuditError.nullable(),
})
export type AuditStep = z.infer<typeof AuditStep>

/** Deterministic baseline facts surfaced on the overview. */
export const BaselineStats = z.object({
  pagesDiscovered: z.number(),
  pagesCrawled: z.number(),
  pagesInspectedInBrowser: z.number(),
  brokenLinks: z.number(),
  consoleErrors: z.number(),
  networkFailures: z.number(),
  accessibilityViolations: z.number(),
  trackingDetected: z.array(z.string()),
  technologyHints: z.array(z.string()),
  languages: z.array(z.string()),
  lighthouse: z
    .object({
      url: z.string(),
      formFactor: z.string(),
      performance: z.number().nullable(),
      accessibility: z.number().nullable(),
      seo: z.number().nullable(),
      bestPractices: z.number().nullable(),
      lcpMs: z.number().nullable(),
      cls: z.number().nullable(),
      tbtMs: z.number().nullable(),
      totalBytes: z.number().nullable(),
    })
    .nullable(),
  skippedCapabilities: z.array(z.object({ capability: z.string(), reason: z.string() })),
})
export type BaselineStats = z.infer<typeof BaselineStats>

export const AuditDetail = AuditListItem.extend({
  normalizedUrl: z.string(),
  error: AuditError.nullable(),
  steps: z.array(AuditStep),
  summary: AuditSummary.nullable(),
  baseline: BaselineStats.nullable(),
  categoryCounts: z.record(z.string(), z.number()),
  evidenceCount: z.number(),
  aiEnabled: z.boolean(),
})
export type AuditDetail = z.infer<typeof AuditDetail>

export const EvidenceItem = z.object({
  id: z.string(),
  ref: z.string(),
  auditId: z.string(),
  source: EvidenceSource,
  type: EvidenceType,
  title: z.string(),
  summary: z.string(),
  url: z.string().nullable(),
  artifactPath: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export type EvidenceItem = z.infer<typeof EvidenceItem>

export const FindingItem = z.object({
  id: z.string(),
  ref: z.string(),
  auditId: z.string(),
  title: z.string(),
  category: Category,
  severity: Severity,
  type: FindingType,
  description: z.string(),
  observed: z.string(),
  affectedUrls: z.array(z.string()),
  confidence: z.number(),
  verificationStatus: VerificationStatus,
  whyItMatters: z.string(),
  businessImpact: z.string(),
  businessImpactLevel: ImpactLevel,
  recommendation: z.string(),
  effort: EffortLevel,
  opportunity: Opportunity.nullable(),
  evidenceRefs: z.array(z.string()),
  createdBy: z.string(),
  rank: z.number(),
})
export type FindingItem = z.infer<typeof FindingItem>

export const ActivityEvent = z.object({
  id: z.number(),
  auditId: z.string(),
  type: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
})
export type ActivityEvent = z.infer<typeof ActivityEvent>

export const ToolRunItem = z.object({
  id: z.string(),
  tool: z.string(),
  purpose: z.string(),
  status: ToolRunStatus,
  url: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  artifactPaths: z.array(z.string()),
})
export type ToolRunItem = z.infer<typeof ToolRunItem>

export const AgentRunItem = z.object({
  id: z.string(),
  role: AgentRole,
  provider: z.string(),
  model: z.string().nullable(),
  promptVersion: z.string(),
  status: AgentRunStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  numTurns: z.number().nullable(),
  costUsd: z.number().nullable(),
  error: z.string().nullable(),
  validation: z.record(z.string(), z.unknown()).nullable(),
  output: z.unknown().nullable(),
})
export type AgentRunItem = z.infer<typeof AgentRunItem>

export const PageItem = z.object({
  url: z.string(),
  status: z.number().nullable(),
  title: z.string().nullable(),
  depth: z.number(),
  source: z.string(),
  inspectedInBrowser: z.boolean(),
})
export type PageItem = z.infer<typeof PageItem>
