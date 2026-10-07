import {
  MIN_TREND_POINTS,
  siteKeyFor,
  type Artifact,
  type AuditComparison,
  type AuditStep,
  type CoverageItem,
  type EvidenceItem,
  type FindingBrief,
  type FindingItem,
  type MetricCatalogEntry,
  type PageItem,
  type SiteHistory,
  type ToolRunItem,
  type TrendSeries,
} from '@audivra/contracts'
import {
  getAuditRow,
  getPreviousSiteAudit,
  listArtifacts,
  listEvidence,
  listFindings,
  listPages,
  listSiteAudits,
  listSteps,
  listToolRuns,
  updateAudit,
  type AuditRow,
  type Db,
} from '@audivra/database'
import { buildMetricCatalog } from './catalog.ts'
import {
  compareCoverage,
  compareMetrics,
  compareTechnologies,
  matchFindings,
  pairScreenshots,
  summarize,
  type MetricSnapshot,
} from './compare.ts'
import { computeCoverage } from './coverage.ts'

export interface AuditData {
  row: AuditRow
  findings: FindingItem[]
  evidence: EvidenceItem[]
  artifacts: Artifact[]
  pages: PageItem[]
  toolRuns: ToolRunItem[]
  steps: AuditStep[]
  coverage: CoverageItem[]
  catalog: MetricCatalogEntry[]
}

/** Loads everything presentation needs for one audit. Computes (and persists) coverage when missing. */
export async function loadAuditData(db: Db, auditId: string): Promise<AuditData | undefined> {
  const row = await getAuditRow(db, auditId)
  if (!row) return undefined
  const [findings, evidence, artifacts, pages, toolRuns, steps] = await Promise.all([
    listFindings(db, auditId),
    listEvidence(db, auditId),
    listArtifacts(db, auditId),
    listPages(db, auditId),
    listToolRuns(db, auditId),
    listSteps(db, auditId),
  ])
  let coverage = row.coverage ?? null
  if (!coverage || coverage.length === 0) {
    coverage = computeCoverage({ targetUrl: row.normalizedUrl, toolRuns, steps, baseline: row.baseline ?? null, evidence })
    if (row.status !== 'running' && row.status !== 'queued') await updateAudit(db, auditId, { coverage })
  }
  return { row, findings, evidence, artifacts, pages, toolRuns, steps, coverage, catalog: buildMetricCatalog(evidence) }
}

export function toBrief(f: FindingItem): FindingBrief {
  return { ref: f.ref, title: f.title, severity: f.severity, category: f.category, issueKey: f.issueKey, affectedUrls: f.affectedUrls }
}

/** Comparable metrics for an audit snapshot, with lab-noise thresholds. */
export function metricSnapshots(data: Pick<AuditData, 'row' | 'findings'>): MetricSnapshot[] {
  const b = data.row.baseline
  const lh = b?.lighthouse ?? null
  const critHigh = data.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length
  const hasFindings = data.row.aiEnabled && (data.row.status === 'completed' || data.row.status === 'partial')
  return [
    { key: 'lighthouse.performance', label: 'Performance score (mobile, start page)', unit: 'score', lowerIsBetter: false, noise: 3, value: lh?.performance ?? null },
    { key: 'lighthouse.lcp', label: 'LCP (mobile, start page)', unit: 'ms', lowerIsBetter: true, noise: 150, value: lh?.lcpMs ?? null },
    { key: 'lighthouse.cls', label: 'CLS (mobile, start page)', unit: 'none', lowerIsBetter: true, noise: 0.01, value: lh?.cls ?? null },
    { key: 'lighthouse.tbt', label: 'Total blocking time (mobile)', unit: 'ms', lowerIsBetter: true, noise: 50, value: lh?.tbtMs ?? null },
    { key: 'lighthouse.accessibility', label: 'Accessibility score (Lighthouse)', unit: 'score', lowerIsBetter: false, noise: 2, value: lh?.accessibility ?? null },
    { key: 'lighthouse.seo', label: 'SEO score (Lighthouse)', unit: 'score', lowerIsBetter: false, noise: 2, value: lh?.seo ?? null },
    { key: 'lighthouse.weight', label: 'Page weight (start page)', unit: 'bytes', lowerIsBetter: true, noise: 20_480, value: lh?.totalBytes ?? null },
    { key: 'links.broken', label: 'Broken link/resource targets', unit: 'count', lowerIsBetter: true, noise: 0, value: b ? b.brokenLinks : null },
    { key: 'browser.consoleErrors', label: 'Console/JS errors', unit: 'count', lowerIsBetter: true, noise: 0, value: b ? b.consoleErrors : null },
    { key: 'browser.networkFailures', label: 'Failed network requests', unit: 'count', lowerIsBetter: true, noise: 0, value: b ? b.networkFailures : null },
    { key: 'axe.violations', label: 'Accessibility rule violations (axe)', unit: 'count', lowerIsBetter: true, noise: 0, value: b ? b.accessibilityViolations : null },
    { key: 'findings.total', label: 'Findings', unit: 'count', lowerIsBetter: true, noise: 0, value: hasFindings ? data.findings.length : null },
    { key: 'findings.criticalHigh', label: 'Critical + high findings', unit: 'count', lowerIsBetter: true, noise: 0, value: hasFindings ? critHigh : null },
  ]
}

function technologies(row: AuditRow): string[] {
  const ai = row.summary?.technologies?.map((t) => t.name) ?? []
  return ai.length ? ai : (row.baseline?.technologyHints ?? [])
}

/** Compares an audit with an earlier audit of the same site (default: the previous finished one). */
export async function buildComparison(db: Db, auditId: string, withAuditId?: string): Promise<AuditComparison | null> {
  const row = await getAuditRow(db, auditId)
  if (!row) return null
  const previousRow = withAuditId ? await getAuditRow(db, withAuditId) : await getPreviousSiteAudit(db, row)
  if (!previousRow || previousRow.id === row.id) return null
  if ((previousRow.siteKey || siteKeyFor(previousRow.normalizedUrl)) !== (row.siteKey || siteKeyFor(row.normalizedUrl))) return null
  const [current, previous] = await Promise.all([loadAuditData(db, row.id), loadAuditData(db, previousRow.id)])
  if (!current || !previous) return null
  const findings = matchFindings(current.findings.map(toBrief), previous.findings.map(toBrief))
  const ref = (r: AuditRow, count: number) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    status: r.status,
    findingCount: count,
  })
  return {
    siteKey: row.siteKey,
    current: ref(row, current.findings.length),
    previous: ref(previousRow, previous.findings.length),
    summary: summarize(findings),
    findings,
    metrics: compareMetrics(metricSnapshots(current), metricSnapshots(previous)),
    technologies: compareTechnologies(technologies(row), technologies(previousRow)),
    coverage: compareCoverage(current.coverage, previous.coverage),
    screenshots: pairScreenshots(
      { auditId: row.id, date: row.createdAt.toISOString(), evidence: current.evidence },
      { auditId: previousRow.id, date: previousRow.createdAt.toISOString(), evidence: previous.evidence },
    ),
  }
}

const HISTORY_SERIES: { key: string; label: string; unit: TrendSeries['unit']; lowerIsBetter: boolean }[] = [
  { key: 'lighthouse.performance', label: 'Performance score', unit: 'score', lowerIsBetter: false },
  { key: 'lighthouse.lcp', label: 'LCP (mobile)', unit: 'ms', lowerIsBetter: true },
  { key: 'lighthouse.accessibility', label: 'Accessibility score', unit: 'score', lowerIsBetter: false },
  { key: 'links.broken', label: 'Broken links', unit: 'count', lowerIsBetter: true },
  { key: 'findings.total', label: 'Findings', unit: 'count', lowerIsBetter: true },
  { key: 'findings.criticalHigh', label: 'Critical + high findings', unit: 'count', lowerIsBetter: true },
  { key: 'findings.verified', label: 'Verified findings', unit: 'count', lowerIsBetter: false },
  { key: 'pages.discovered', label: 'Pages discovered', unit: 'count', lowerIsBetter: false },
  { key: 'tracking.tools', label: 'Tracking tools detected', unit: 'count', lowerIsBetter: false },
]

/** Real per-audit history for a site. Series appear only with at least MIN_TREND_POINTS real values. */
export async function buildSiteHistory(db: Db, siteKey: string, options: { benchmark?: boolean } = {}): Promise<SiteHistory> {
  const rows = (await listSiteAudits(db, siteKey)).filter((r) => r.benchmark === (options.benchmark ?? false))
  const audits: SiteHistory['audits'] = []
  const values = new Map<string, { auditId: string; at: string; value: number }[]>()
  for (const row of rows) {
    const findings = await listFindings(db, row.id)
    const severityCounts: Record<string, number> = {}
    for (const f of findings) severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1
    audits.push({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      status: row.status,
      findingCount: findings.length,
      severityCounts,
    })
    const snapshot = new Map(metricSnapshots({ row, findings }).map((m) => [m.key, m.value]))
    const hasFindings = row.aiEnabled
    snapshot.set('findings.verified', hasFindings ? findings.filter((f) => f.type === 'verified').length : null)
    snapshot.set('pages.discovered', row.baseline?.pagesDiscovered ?? null)
    snapshot.set('tracking.tools', row.baseline ? row.baseline.trackingDetected.length : null)
    for (const series of HISTORY_SERIES) {
      const value = snapshot.get(series.key)
      if (value === null || value === undefined || !Number.isFinite(value)) continue
      values.set(series.key, [...(values.get(series.key) ?? []), { auditId: row.id, at: row.createdAt.toISOString(), value }])
    }
  }
  const series: TrendSeries[] = HISTORY_SERIES.filter((s) => (values.get(s.key)?.length ?? 0) >= MIN_TREND_POINTS).map((s) => ({
    ...s,
    points: values.get(s.key)!,
  }))
  return { siteKey, audits, series }
}
