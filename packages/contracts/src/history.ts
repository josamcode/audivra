import { z } from 'zod'
import { Category, Severity } from './enums.ts'
import { ValueUnit } from './artifacts.ts'
import { CoverageStatus } from './coverage.ts'
import { EnrichmentStatus, JourneyDimension, JourneyHealthStatus, JourneyType } from './journeys.ts'

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

/**
 * How a journey changed between two audits, matched by journey key (then by type and path).
 * Paths are step labels in order; health lists only dimensions whose status changed.
 */
export const JourneyChange = z.object({
  journeyKey: z.string(),
  name: z.string(),
  type: JourneyType,
  status: z.enum(['new', 'not-found-again', 'changed', 'unchanged']),
  currentRef: z.string().nullable(),
  previousRef: z.string().nullable(),
  primaryBefore: z.boolean().nullable(),
  primaryAfter: z.boolean().nullable(),
  pathBefore: z.array(z.string()).nullable(),
  pathAfter: z.array(z.string()).nullable(),
  pathChanged: z.boolean(),
  health: z.array(z.object({ dimension: JourneyDimension, before: JourneyHealthStatus, after: JourneyHealthStatus })),
  /** Steps whose status changed (by label): e.g. the WhatsApp step went from ok to blocked. */
  steps: z.array(z.object({ label: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
})
export type JourneyChange = z.infer<typeof JourneyChange>

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
  /** Tracking tools observed on page load (added/removed are by name). */
  tracking: z.object({ added: z.array(z.string()), removed: z.array(z.string()), unchanged: z.array(z.string()) }),
  journeys: z.array(JourneyChange),
  coverage: z.array(z.object({ capability: z.string(), label: z.string(), before: CoverageStatus.nullable(), after: CoverageStatus.nullable() })),
  screenshots: z.array(ScreenshotPair),
})
export type AuditComparison = z.infer<typeof AuditComparison>

/**
 * The history of one issue across a site's finished audits (oldest first). "not-found" is never
 * called fixed: it only means the issue was not reported in that audit.
 */
export const FindingTimeline = z.object({
  key: z.string(),
  title: z.string(),
  category: Category,
  /** Ref of the issue in the newest audit of the timeline, when it was reported there. */
  currentRef: z.string().nullable(),
  entries: z.array(
    z.object({
      auditId: z.string(),
      date: z.string(),
      status: z.enum(['detected', 'not-found', 'detected-again']),
      ref: z.string().nullable(),
      severity: Severity.nullable(),
    }),
  ),
})
export type FindingTimeline = z.infer<typeof FindingTimeline>

export const CHANGE_KINDS = [
  'regression',
  'improvement',
  'new-issue',
  'not-found-again',
  'persistent',
  'journey',
  'tracking',
  'metric',
  'technology',
  'coverage',
] as const
export const ChangeKind = z.enum(CHANGE_KINDS)
export type ChangeKind = z.infer<typeof ChangeKind>

/** How firmly a change and its explanation are established. */
export const CHANGE_BASES = ['verified', 'observed', 'correlated', 'likely'] as const
export const ChangeBasis = z.enum(CHANGE_BASES)
export type ChangeBasis = z.infer<typeof ChangeBasis>

export const ChangeInsight = z.object({
  kind: ChangeKind,
  importance: z.enum(['high', 'medium', 'low']),
  title: z.string().min(5).max(120).describe('Specific headline, e.g. "Homepage performance regressed on mobile".'),
  description: z
    .string()
    .max(700)
    .describe('What changed (with the before → after values from the facts) and why it matters for this business. Name a likely contributor only when evidence shows it, and say "likely"/"correlated".'),
  basis: ChangeBasis.describe('verified: both states measured and the cause shown · observed: the change itself is measured · correlated: a contributor co-occurs · likely: a reasoned interpretation.'),
  currentFindingIds: z.array(z.string()).describe('Findings of the current audit (F*) this is about.'),
  previousFindingIds: z.array(z.string()).describe('Findings of the previous audit (F*) this is about.'),
  journeyKeys: z.array(z.string()).describe('Journey keys this change affects.'),
  metricKeys: z.array(z.string()).describe('Metric keys from the facts (e.g. "lighthouse.lcp").'),
  evidenceIds: z.array(z.string()).describe('Evidence of the current audit (EV-*) that shows it.'),
})
export type ChangeInsight = z.infer<typeof ChangeInsight>

/** What the Change Intelligence interpreter returns: explanation only, never new facts. */
export const ChangeAnalysis = z.object({
  headline: z.string().min(5).max(160).describe('One line: the most important thing that changed since the previous audit.'),
  summary: z.string().max(700).describe('Two to four sentences for the site owner.'),
  insights: z.array(ChangeInsight).max(10).describe('Ordered by importance.'),
})
export type ChangeAnalysis = z.infer<typeof ChangeAnalysis>

export const ChangeReportItem = z.object({
  id: z.string(),
  auditId: z.string(),
  previousAuditId: z.string(),
  analysis: ChangeAnalysis,
  promptVersion: z.string(),
  createdAt: z.string(),
})
export type ChangeReportItem = z.infer<typeof ChangeReportItem>

/** Everything the "What changed" view needs: deterministic facts, the stored interpretation, timelines. */
export const AuditChanges = z.object({
  comparison: AuditComparison.nullable(),
  intelligence: ChangeReportItem.nullable(),
  timelines: z.array(FindingTimeline),
  status: EnrichmentStatus,
})
export type AuditChanges = z.infer<typeof AuditChanges>

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
