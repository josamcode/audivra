import { z } from 'zod'
import { Category, Severity } from './enums.ts'
import { ValueUnit } from './artifacts.ts'
import { CoverageStatus } from './coverage.ts'

/** Brief finding identity used when comparing audits of the same site. */
export const FindingBrief = z.object({
  ref: z.string(),
  title: z.string(),
  severity: Severity,
  category: Category,
  issueKey: z.string().nullable(),
  affectedUrls: z.array(z.string()),
})
export type FindingBrief = z.infer<typeof FindingBrief>

export const FINDING_CHANGE_STATUSES = ['new', 'resolved', 'improved', 'regressed', 'unchanged'] as const
export const FindingChangeStatus = z.enum(FINDING_CHANGE_STATUSES)
export type FindingChangeStatus = z.infer<typeof FindingChangeStatus>

export const FindingChange = z.object({
  status: FindingChangeStatus,
  current: FindingBrief.nullable(),
  previous: FindingBrief.nullable(),
  matchedBy: z.enum(['issue-key', 'similarity']).nullable(),
  matchScore: z.number().nullable(),
})
export type FindingChange = z.infer<typeof FindingChange>

export const MetricChange = z.object({
  key: z.string(),
  label: z.string(),
  unit: ValueUnit,
  lowerIsBetter: z.boolean(),
  before: z.number().nullable(),
  after: z.number().nullable(),
  delta: z.number().nullable(),
  direction: z.enum(['improved', 'regressed', 'unchanged', 'new', 'missing']),
})
export type MetricChange = z.infer<typeof MetricChange>

export const ScreenshotPair = z.object({
  url: z.string(),
  viewport: z.string(),
  before: z.object({ auditId: z.string(), evidenceRef: z.string(), artifactPath: z.string(), date: z.string() }),
  after: z.object({ auditId: z.string(), evidenceRef: z.string(), artifactPath: z.string(), date: z.string() }),
})
export type ScreenshotPair = z.infer<typeof ScreenshotPair>

export const AuditRefSummary = z.object({
  id: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.string(),
  findingCount: z.number(),
})
export type AuditRefSummary = z.infer<typeof AuditRefSummary>

export const AuditComparison = z.object({
  siteKey: z.string(),
  current: AuditRefSummary,
  previous: AuditRefSummary,
  summary: z.object({
    new: z.number(),
    resolved: z.number(),
    improved: z.number(),
    regressed: z.number(),
    unchanged: z.number(),
  }),
  findings: z.array(FindingChange),
  metrics: z.array(MetricChange),
  technologies: z.object({ added: z.array(z.string()), removed: z.array(z.string()), unchanged: z.array(z.string()) }),
  coverage: z.array(z.object({ capability: z.string(), label: z.string(), before: CoverageStatus.nullable(), after: CoverageStatus.nullable() })),
  screenshots: z.array(ScreenshotPair),
})
export type AuditComparison = z.infer<typeof AuditComparison>

export const TrendSeries = z.object({
  key: z.string(),
  label: z.string(),
  unit: ValueUnit,
  lowerIsBetter: z.boolean(),
  points: z.array(z.object({ auditId: z.string(), at: z.string(), value: z.number() })),
})
export type TrendSeries = z.infer<typeof TrendSeries>

/** Minimum number of completed audits (real snapshots) before a trend line is drawn. */
export const MIN_TREND_POINTS = 2

export const SiteHistory = z.object({
  siteKey: z.string(),
  audits: z.array(
    AuditRefSummary.extend({
      severityCounts: z.record(z.string(), z.number()),
    }),
  ),
  /** Only series with at least MIN_TREND_POINTS real points are included. */
  series: z.array(TrendSeries),
})
export type SiteHistory = z.infer<typeof SiteHistory>
