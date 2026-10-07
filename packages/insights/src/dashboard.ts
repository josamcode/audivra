import {
  AUDIT_STATUSES,
  SEVERITIES,
  SEVERITY_RANK,
  type ActiveAudit,
  type AuditStatus,
  type AuditStep,
  type AuditTrend,
  type Category,
  type Dashboard,
  type DashboardActivity,
  type DashboardAudit,
  type DashboardSummary,
  type FindingChangeStatus,
  type FollowUp,
  type FollowUpChange,
  type ImpactLevel,
  type RepeatSite,
  type Severity,
  type SeverityCounts,
  type SeverityPoint,
  type FindingType,
  type TrendDirection,
} from '@audivra/contracts'
import {
  auditGroupStats,
  listAuditBriefs,
  listFindingSignals,
  listFinishedAiAudits,
  listSteps,
  type AuditBrief,
  type AuditGroupStat,
  type Db,
  type FindingSignal,
  type FinishedAiAudit,
} from '@audivra/database'
import { matchFindings, summarize } from './compare.ts'

/*
 * Aggregates for the Audits home screen. Pure functions over light rows (no finding prose, evidence
 * or artifacts), so every number on the screen can be traced to persisted audits and findings.
 */

const LOCAL_SUFFIXES = ['.localhost', '.local', '.test', '.internal', '.home.arpa']

/**
 * Loopback, private-network and reserved local names: fixture sites and dev servers. They are listed
 * as audits but never counted as websites or used for business follow-ups.
 */
export function isLocalTarget(siteKey: string): boolean {
  let host = siteKey.trim().toLowerCase()
  host = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '')
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

const isFinished = (status: AuditStatus) => status === 'completed' || status === 'partial'
const isActive = (status: AuditStatus) => status === 'queued' || status === 'running'

function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
}

/**
 * Direction of an audit against the previous one of the same site: critical + high findings decide,
 * medium findings break ties. Low and info findings never change the direction.
 */
export function severityDirection(current: SeverityCounts, previous: SeverityCounts): TrendDirection {
  const diff = current.critical + current.high - (previous.critical + previous.high) || current.medium - previous.medium
  return diff < 0 ? 'improving' : diff > 0 ? 'regressing' : 'stable'
}

const point = (audit: FinishedAiAudit): SeverityPoint => ({ auditId: audit.id, createdAt: audit.createdAt, counts: audit.severityCounts })

/** Benchmark audits form their own history, as in comparisons. */
const historyKey = (siteKey: string, benchmark: boolean) => `${benchmark ? 'benchmark' : 'normal'}|${siteKey}`

/** Finished AI audits per site (and benchmark flag), oldest first. */
export function groupHistory(history: FinishedAiAudit[]): Map<string, FinishedAiAudit[]> {
  const groups = new Map<string, FinishedAiAudit[]>()
  for (const audit of history) {
    const key = historyKey(audit.siteKey, audit.benchmark)
    const list = groups.get(key)
    if (list) list.push(audit)
    else groups.set(key, [audit])
  }
  for (const list of groups.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return groups
}

/** Trend of a finished AI audit against the previous finished AI audit of its site; null when there is none. */
export function auditTrend(
  audit: Pick<AuditBrief, 'id' | 'status' | 'aiEnabled'>,
  siteHistory: FinishedAiAudit[] | undefined,
): AuditTrend | null {
  if (!siteHistory || !audit.aiEnabled || !isFinished(audit.status)) return null
  const index = siteHistory.findIndex((entry) => entry.id === audit.id)
  if (index <= 0) return null
  const current = siteHistory[index]!
  const previous = siteHistory[index - 1]!
  return {
    direction: severityDirection(current.severityCounts, previous.severityCounts),
    previousAuditId: previous.id,
    previousCreatedAt: previous.createdAt,
    history: siteHistory.slice(Math.max(0, index - 4), index + 1).map(point),
  }
}

export function summarizeAudits(
  stats: AuditGroupStat[],
  history: FinishedAiAudit[],
  includeBenchmarks: boolean,
): DashboardSummary {
  const statusCounts = Object.fromEntries(AUDIT_STATUSES.map((status) => [status, 0])) as Record<AuditStatus, number>
  const websites = new Set<string>()
  const localTargets = new Set<string>()
  let total = 0
  let hiddenActive = 0
  let benchmarkAudits = 0
  let timed = 0
  let durationMs = 0
  for (const stat of stats) {
    if (stat.benchmark) benchmarkAudits += stat.count
    if (stat.benchmark && !includeBenchmarks) {
      if (isActive(stat.status)) hiddenActive += stat.count
      continue
    }
    total += stat.count
    statusCounts[stat.status] += stat.count
    const local = isLocalTarget(stat.siteKey)
    if (local) localTargets.add(stat.siteKey)
    else if (!stat.benchmark) websites.add(stat.siteKey)
    // Baseline-only runs and (unless benchmarks are shown) local test runs would skew the average.
    if (stat.status === 'completed' && stat.aiEnabled && (includeBenchmarks || !local)) {
      timed += stat.timed
      durationMs += stat.durationMs
    }
  }

  const latest = new Map<string, FinishedAiAudit>()
  for (const audit of history) {
    if (audit.benchmark || isLocalTarget(audit.siteKey)) continue
    const current = latest.get(audit.siteKey)
    if (!current || audit.createdAt > current.createdAt) latest.set(audit.siteKey, audit)
  }
  const severity = emptyCounts()
  for (const audit of latest.values()) for (const level of SEVERITIES) severity[level] += audit.severityCounts[level]

  return {
    totalAudits: total,
    statusCounts,
    running: statusCounts.running,
    queued: statusCounts.queued,
    hiddenActive,
    benchmarkAudits,
    websites: websites.size,
    localTargets: localTargets.size,
    latestFindings: { websites: latest.size, total: SEVERITIES.reduce((sum, level) => sum + severity[level], 0), severity },
    averageDurationMs: timed ? Math.round(durationMs / timed) : null,
    timedAudits: timed,
  }
}

/** How many recent audits of a site are compared for recurrence (the latest included). */
export const FOLLOW_UP_WINDOW = 5

/** Recent finished AI audits of each public website: the audits whose findings follow-ups and repeat issues need. */
export function followUpAuditIds(history: FinishedAiAudit[]): string[] {
  const ids: string[] = []
  for (const [key, audits] of groupHistory(history)) {
    if (key.startsWith('benchmark|') || isLocalTarget(audits[0]!.siteKey)) continue
    ids.push(...audits.slice(-FOLLOW_UP_WINDOW).map((audit) => audit.id))
  }
  return ids
}

interface SiteAnalysis {
  siteKey: string
  domain: string
  audits: FinishedAiAudit[]
  latest: FinishedAiAudit
  /** Issues of the latest audit (info-level notes excluded). */
  issues: FindingSignal[]
  /** Change of each latest issue against the previous audit. */
  changes: Map<string, { status: FindingChangeStatus; previousSeverity: Severity | null }>
  summary: Record<FindingChangeStatus, number> | null
  seenIn: Map<string, number>
  compared: number
}

/** Matches the latest audit of every public website against its recent audits (issue keys first, then similarity). */
export function analyzeSites(history: FinishedAiAudit[], findings: FindingSignal[]): SiteAnalysis[] {
  const byAudit = new Map<string, FindingSignal[]>()
  for (const finding of findings) {
    if (finding.severity === 'info') continue
    const list = byAudit.get(finding.auditId)
    if (list) list.push(finding)
    else byAudit.set(finding.auditId, [finding])
  }
  const analyses: SiteAnalysis[] = []
  for (const [key, audits] of groupHistory(history)) {
    if (key.startsWith('benchmark|') || isLocalTarget(audits[0]!.siteKey)) continue
    const window = audits.slice(-FOLLOW_UP_WINDOW)
    const latest = window.at(-1)!
    const issues = byAudit.get(latest.id) ?? []
    const changes: SiteAnalysis['changes'] = new Map()
    const seenIn = new Map(issues.map((issue) => [issue.ref, 1]))
    let summary: SiteAnalysis['summary'] = null
    for (const [index, earlier] of window.slice(0, -1).entries()) {
      const matched = matchFindings(issues, byAudit.get(earlier.id) ?? [])
      for (const change of matched) {
        if (change.current && change.previous) seenIn.set(change.current.ref, (seenIn.get(change.current.ref) ?? 1) + 1)
      }
      if (index === window.length - 2) {
        summary = summarize(matched)
        for (const change of matched) {
          if (change.current) changes.set(change.current.ref, { status: change.status, previousSeverity: change.previous?.severity ?? null })
        }
      }
    }
    analyses.push({ siteKey: latest.siteKey, domain: latest.domain, audits, latest, issues, changes, summary, seenIn, compared: window.length })
  }
  return analyses
}

const SEVERITY_SCORE: Record<Severity, number> = { critical: 60, high: 45, medium: 30, low: 10, info: 0 }
const IMPACT_SCORE: Record<ImpactLevel, number> = { high: 15, medium: 8, low: 0, unknown: 0 }
const TYPE_SCORE: Record<FindingType, number> = { verified: 10, 'supported-observation': 5, inference: 0 }
/** Categories that sit on the path to an enquiry or sale. */
const CONVERSION_PATH = new Set<Category>(['Conversion', 'Tracking', 'Broken Functionality'])

/**
 * Deterministic priority of a finding: severity first, then business impact, how well it is
 * established, whether it got worse or keeps coming back, whether it touches the conversion path,
 * and whether it is cheap to fix.
 */
export function followUpScore(finding: FindingSignal, change: FollowUpChange, seenIn: number): number {
  let score = SEVERITY_SCORE[finding.severity] + IMPACT_SCORE[finding.businessImpactLevel] + TYPE_SCORE[finding.type]
  if (change === 'regressed') score += 12
  if (seenIn >= 2) score += Math.min(12, 6 + 3 * (seenIn - 2))
  if (CONVERSION_PATH.has(finding.category)) score += 8
  if (finding.effort === 'low') score += 4
  return score
}

export const MAX_FOLLOW_UPS = 5
const MAX_FOLLOW_UPS_PER_SITE = 2

/** The few issues worth attention across the latest audit of each public website. */
export function rankFollowUps(analyses: SiteAnalysis[], limit = MAX_FOLLOW_UPS): FollowUp[] {
  const candidates: (FollowUp & { score: number; rank: number })[] = []
  for (const site of analyses) {
    for (const issue of site.issues) {
      const matched = site.changes.get(issue.ref)
      const change: FollowUpChange = site.audits.length < 2 ? 'first-audit' : (matched?.status as FollowUpChange | undefined) ?? 'new'
      // Only issues that matter: medium or worse, high business impact, or a regression.
      if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK.medium && issue.businessImpactLevel !== 'high' && change !== 'regressed') continue
      const seenIn = site.seenIn.get(issue.ref) ?? 1
      candidates.push({
        auditId: site.latest.id,
        auditCreatedAt: site.latest.createdAt,
        siteKey: site.siteKey,
        domain: site.domain,
        ref: issue.ref,
        title: issue.title,
        severity: issue.severity,
        category: issue.category,
        type: issue.type,
        verificationStatus: issue.verificationStatus,
        businessImpactLevel: issue.businessImpactLevel,
        effort: issue.effort,
        change,
        previousSeverity: matched?.previousSeverity ?? null,
        seenIn,
        auditsCompared: site.compared,
        score: followUpScore(issue, change, seenIn),
        rank: issue.rank,
      })
    }
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.auditCreatedAt.localeCompare(a.auditCreatedAt) ||
      a.rank - b.rank,
  )
  const perSite = new Map<string, number>()
  const picked: FollowUp[] = []
  for (const { score: _score, rank: _rank, ...candidate } of candidates) {
    const count = perSite.get(candidate.siteKey) ?? 0
    if (count >= MAX_FOLLOW_UPS_PER_SITE) continue
    perSite.set(candidate.siteKey, count + 1)
    picked.push(candidate)
    if (picked.length >= limit) break
  }
  return picked
}

/** Websites whose latest audit still has issues found in the audit before it. */
export function findRepeatSites(analyses: SiteAnalysis[], limit = 5): RepeatSite[] {
  return analyses
    .filter((site) => site.summary && site.summary.unchanged + site.summary.improved + site.summary.regressed > 0)
    .map((site) => {
      const previous = site.audits.at(-2)!
      return {
        siteKey: site.siteKey,
        domain: site.domain,
        latestAuditId: site.latest.id,
        audits: site.audits.length,
        changes: site.summary!,
        direction: severityDirection(site.latest.severityCounts, previous.severityCounts),
        history: site.audits.slice(-6).map(point),
      }
    })
    .sort((a, b) => {
      const recurring = (site: RepeatSite) => site.changes.unchanged + site.changes.improved + site.changes.regressed
      return (
        b.changes.regressed - a.changes.regressed ||
        recurring(b) - recurring(a) ||
        (b.history.at(-1)?.createdAt ?? '').localeCompare(a.history.at(-1)?.createdAt ?? '')
      )
    })
    .slice(0, limit)
}

/** The latest state change of each recent audit, newest first. */
export function recentActivity(audits: AuditBrief[], limit = 6): DashboardActivity[] {
  return audits
    .map((audit): DashboardActivity => {
      const kind = audit.status === 'queued' ? 'created' : audit.status === 'running' ? 'started' : audit.status
      const at =
        kind === 'created' ? audit.createdAt : kind === 'started' ? (audit.startedAt ?? audit.createdAt) : (audit.finishedAt ?? audit.startedAt ?? audit.createdAt)
      const message = audit.error?.message ?? null
      return {
        auditId: audit.id,
        kind,
        at,
        domain: audit.domain,
        benchmark: audit.benchmark,
        local: isLocalTarget(audit.siteKey),
        aiEnabled: audit.aiEnabled,
        findingCount: audit.findingCount,
        stage: audit.stage,
        error: message && message.length > 160 ? `${message.slice(0, 157)}…` : message,
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}

export interface DashboardInput {
  includeBenchmarks: boolean
  generatedAt: string
  stats: AuditGroupStat[]
  /** Most recent audits in scope, newest first. */
  recent: AuditBrief[]
  /** Finished AI audits in scope. */
  history: FinishedAiAudit[]
  /** Findings of the audits listed by `followUpAuditIds(history)`. */
  findings: FindingSignal[]
  /** Steps of the active audits in `recent`. */
  steps: Record<string, AuditStep[]>
}

export function buildDashboard(input: DashboardInput): Dashboard {
  const histories = groupHistory(input.history)
  const audits: DashboardAudit[] = input.recent.map(({ error: _error, ...audit }) => ({
    ...audit,
    local: isLocalTarget(audit.siteKey),
    trend: auditTrend(audit, histories.get(historyKey(audit.siteKey, audit.benchmark))),
  }))
  const active: ActiveAudit[] = audits
    .filter((audit) => isActive(audit.status))
    .map((audit) => ({ ...audit, steps: input.steps[audit.id] ?? [] }))
  const analyses = analyzeSites(input.history, input.findings)
  return {
    generatedAt: input.generatedAt,
    includesBenchmarks: input.includeBenchmarks,
    summary: summarizeAudits(input.stats, input.history, input.includeBenchmarks),
    active,
    audits,
    followUps: rankFollowUps(analyses),
    repeatSites: findRepeatSites(analyses),
    activity: recentActivity(input.recent),
  }
}

/** Loads the home screen aggregates with a handful of light queries. */
export async function loadDashboard(db: Db, options: { includeBenchmarks: boolean; limit?: number }): Promise<Dashboard> {
  const generatedAt = new Date().toISOString()
  const [stats, recent, history] = await Promise.all([
    auditGroupStats(db),
    listAuditBriefs(db, { includeBenchmarks: options.includeBenchmarks, limit: options.limit }),
    listFinishedAiAudits(db, { includeBenchmarks: options.includeBenchmarks }),
  ])
  const activeIds = recent.filter((audit) => isActive(audit.status)).map((audit) => audit.id)
  const [findings, steps] = await Promise.all([
    listFindingSignals(db, followUpAuditIds(history)),
    Promise.all(activeIds.map(async (id) => [id, await listSteps(db, id)] as const)),
  ])
  return buildDashboard({
    includeBenchmarks: options.includeBenchmarks,
    generatedAt,
    stats,
    recent,
    history,
    findings,
    steps: Object.fromEntries(steps),
  })
}
