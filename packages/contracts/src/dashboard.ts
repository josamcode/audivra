import { z } from 'zod'
import { AuditListItem, AuditStep, SeverityCounts } from './audit.ts'
import { AuditStage, AuditStatus, Category, EffortLevel, FindingType, ImpactLevel, Severity, VerificationStatus } from './enums.ts'
import { FindingChangeStatus } from './history.ts'

/**
 * Data for the Audits home screen. Everything is derived from persisted audits and final findings;
 * nothing is estimated. Benchmark audits are excluded unless explicitly included, and loopback /
 * private-network targets (fixtures, local dev servers) are never counted as websites.
 */

/** One finished AI audit of a site as a point in its severity history. */
export const SeverityPoint = z.object({
  auditId: z.string(),
  createdAt: z.string(),
  counts: SeverityCounts,
})
export type SeverityPoint = z.infer<typeof SeverityPoint>

/** Critical + high findings decide the direction; medium findings break ties. Low/info never do. */
export const TREND_DIRECTIONS = ['improving', 'stable', 'regressing'] as const
export const TrendDirection = z.enum(TREND_DIRECTIONS)
export type TrendDirection = z.infer<typeof TrendDirection>

export const AuditTrend = z.object({
  direction: TrendDirection,
  previousAuditId: z.string(),
  previousCreatedAt: z.string(),
  /** Up to five finished AI audits of the site, oldest first, ending with this audit. */
  history: z.array(SeverityPoint),
})
export type AuditTrend = z.infer<typeof AuditTrend>

export const DashboardAudit = AuditListItem.extend({
  aiEnabled: z.boolean(),
  /** Loopback / private-network target: listed, but never counted as a website or used for follow-ups. */
  local: z.boolean(),
  /** Null unless this is a finished AI audit with an earlier finished AI audit of the same site. */
  trend: AuditTrend.nullable(),
})
export type DashboardAudit = z.infer<typeof DashboardAudit>

export const ActiveAudit = DashboardAudit.extend({ steps: z.array(AuditStep) })
export type ActiveAudit = z.infer<typeof ActiveAudit>

export const DashboardSummary = z.object({
  totalAudits: z.number(),
  statusCounts: z.record(AuditStatus, z.number()),
  running: z.number(),
  queued: z.number(),
  /** Benchmark audits in progress while benchmark audits are hidden. */
  hiddenActive: z.number(),
  /** All benchmark audits, whether or not they are included. */
  benchmarkAudits: z.number(),
  /** Distinct public sites (site keys) audited. */
  websites: z.number(),
  /** Distinct local targets (loopback / private network) audited, excluded from `websites`. */
  localTargets: z.number(),
  /** Findings of the latest finished AI audit of each website. */
  latestFindings: z.object({ websites: z.number(), total: z.number(), severity: SeverityCounts }),
  /** Mean wall-clock duration of completed AI audits (local test runs excluded unless benchmarks are shown). */
  averageDurationMs: z.number().nullable(),
  timedAudits: z.number(),
})
export type DashboardSummary = z.infer<typeof DashboardSummary>

export const FOLLOW_UP_CHANGES = ['first-audit', 'new', 'unchanged', 'improved', 'regressed'] as const
export const FollowUpChange = z.enum(FOLLOW_UP_CHANGES)
export type FollowUpChange = z.infer<typeof FollowUpChange>

/** A finding from a website's latest audit that is worth attention, ranked deterministically. */
export const FollowUp = z.object({
  auditId: z.string(),
  auditCreatedAt: z.string(),
  siteKey: z.string(),
  domain: z.string(),
  ref: z.string(),
  title: z.string(),
  severity: Severity,
  category: Category,
  type: FindingType,
  verificationStatus: VerificationStatus,
  businessImpactLevel: ImpactLevel,
  effort: EffortLevel,
  /** Against the previous finished AI audit of the site ("first-audit" when there is none). */
  change: FollowUpChange,
  previousSeverity: Severity.nullable(),
  /** Number of the site's recent audits (including the latest) in which this issue was found. */
  seenIn: z.number(),
  auditsCompared: z.number(),
})
export type FollowUp = z.infer<typeof FollowUp>

/** A website whose latest audit still contains issues found in the audit before it. */
export const RepeatSite = z.object({
  siteKey: z.string(),
  domain: z.string(),
  latestAuditId: z.string(),
  audits: z.number(),
  /** Changes between the previous and the latest audit, info-level notes excluded. */
  changes: z.record(FindingChangeStatus, z.number()),
  direction: TrendDirection,
  /** Up to six finished AI audits, oldest first. */
  history: z.array(SeverityPoint),
})
export type RepeatSite = z.infer<typeof RepeatSite>

export const ACTIVITY_KINDS = ['created', 'started', 'completed', 'partial', 'failed', 'cancelled'] as const
export const ActivityKind = z.enum(ACTIVITY_KINDS)
export type ActivityKind = z.infer<typeof ActivityKind>

/** The latest state change of an audit (one item per audit). */
export const DashboardActivity = z.object({
  auditId: z.string(),
  kind: ActivityKind,
  at: z.string(),
  domain: z.string(),
  benchmark: z.boolean(),
  local: z.boolean(),
  aiEnabled: z.boolean(),
  findingCount: z.number(),
  stage: AuditStage,
  error: z.string().nullable(),
})
export type DashboardActivity = z.infer<typeof DashboardActivity>

export const Dashboard = z.object({
  generatedAt: z.string(),
  includesBenchmarks: z.boolean(),
  summary: DashboardSummary,
  active: z.array(ActiveAudit),
  /** Most recent audits in scope, newest first. */
  audits: z.array(DashboardAudit),
  followUps: z.array(FollowUp),
  repeatSites: z.array(RepeatSite),
  activity: z.array(DashboardActivity),
})
export type Dashboard = z.infer<typeof Dashboard>

/** Liveness of the local runtime: the database and the worker that runs audit stages. */
export const SystemHealth = z.object({
  checkedAt: z.string(),
  database: z.object({ ok: z.boolean(), latencyMs: z.number().nullable(), error: z.string().nullable() }),
  engine: z.object({
    /** running: a live worker consumes the audit queues · stopped: none has a recent heartbeat. */
    state: z.enum(['running', 'stopped', 'unknown']),
    workers: z.number(),
    activeJobs: z.number(),
    lastHeartbeatAt: z.string().nullable(),
  }),
})
export type SystemHealth = z.infer<typeof SystemHealth>
