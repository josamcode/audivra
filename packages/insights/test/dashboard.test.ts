import { describe, expect, it } from 'vitest'
import type { AuditStep, SeverityCounts } from '@audivra/contracts'
import type { AuditBrief, AuditGroupStat, FindingSignal, FinishedAiAudit } from '@audivra/database'
import {
  buildDashboard,
  followUpAuditIds,
  isLocalTarget,
  severityDirection,
  summarizeAudits,
  type DashboardInput,
} from '../src/dashboard.ts'

const counts = (critical: number, high: number, medium: number, low: number, info = 0): SeverityCounts => ({ critical, high, medium, low, info })
const total = (c: SeverityCounts) => c.critical + c.high + c.medium + c.low + c.info

let clock = 0
/** ISO timestamps that increase with every call, so fixtures read oldest → newest. */
const at = () => new Date(Date.UTC(2026, 9, 1) + 3_600_000 * clock++).toISOString()

function audit(id: string, siteKey: string, overrides: Partial<AuditBrief> = {}): AuditBrief {
  const createdAt = overrides.createdAt ?? at()
  const severityCounts = overrides.severityCounts ?? counts(0, 0, 0, 0)
  return {
    id,
    url: `https://${siteKey}/`,
    domain: siteKey,
    siteKey,
    clientName: null,
    status: 'completed',
    stage: 'done',
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    severityCounts,
    findingCount: total(severityCounts),
    benchmark: false,
    aiEnabled: true,
    error: null,
    ...overrides,
  }
}

const point = (a: AuditBrief): FinishedAiAudit => ({
  id: a.id,
  siteKey: a.siteKey,
  domain: a.domain,
  benchmark: a.benchmark,
  createdAt: a.createdAt,
  severityCounts: a.severityCounts,
})

function signal(auditId: string, ref: string, overrides: Partial<FindingSignal> = {}): FindingSignal {
  return {
    auditId,
    ref,
    rank: Number(ref.slice(1)),
    title: `Finding ${ref} of ${auditId}`,
    category: 'SEO',
    severity: 'medium',
    type: 'verified',
    verificationStatus: 'reviewer-approved',
    businessImpactLevel: 'medium',
    effort: 'low',
    issueKey: null,
    affectedUrls: ['https://example.com/'],
    ...overrides,
  }
}

function stat(siteKey: string, status: AuditGroupStat['status'], count: number, overrides: Partial<AuditGroupStat> = {}): AuditGroupStat {
  return { siteKey, benchmark: false, status, aiEnabled: true, count, timed: 0, durationMs: 0, ...overrides }
}

function input(overrides: Partial<DashboardInput>): DashboardInput {
  return { includeBenchmarks: false, generatedAt: at(), stats: [], recent: [], history: [], findings: [], steps: {}, ...overrides }
}

describe('local targets', () => {
  it('treats loopback, private networks and reserved local names as local, never public sites', () => {
    for (const key of ['127.0.0.1:4321', 'localhost:3000', '[::1]:8080', '10.0.0.5', '192.168.1.20', '172.20.1.1', 'shop.localhost', 'app.test', '0.0.0.0:80']) {
      expect(isLocalTarget(key), key).toBe(true)
    }
    for (const key of ['example.com', 'josamcode.com', 'shop.example.com', '93.184.216.34', '172.32.0.1', 'localhost.example.com']) {
      expect(isLocalTarget(key), key).toBe(false)
    }
  })
})

describe('summary', () => {
  const stats: AuditGroupStat[] = [
    stat('josamcode.com', 'completed', 3, { timed: 3, durationMs: 3_600_000 }),
    stat('example.com', 'completed', 1, { timed: 1, durationMs: 600_000 }),
    stat('example.com', 'failed', 1, { timed: 1, durationMs: 100_000 }),
    stat('example.org', 'queued', 1),
    stat('example.org', 'running', 1),
    // Local fixture runs: listed and counted as audits, but not websites, and only averaged with benchmarks shown.
    stat('127.0.0.1:4321', 'completed', 2, { timed: 2, durationMs: 1_000_000 }),
    stat('127.0.0.1:4321', 'completed', 1, { aiEnabled: false, timed: 1, durationMs: 30_000 }),
    stat('127.0.0.1:5000', 'completed', 3, { benchmark: true, timed: 3, durationMs: 1_500_000 }),
    stat('127.0.0.1:5000', 'running', 1, { benchmark: true }),
  ]
  const history: FinishedAiAudit[] = [
    point(audit('j1', 'josamcode.com', { severityCounts: counts(0, 1, 2, 3) })),
    point(audit('j2', 'josamcode.com', { severityCounts: counts(0, 1, 1, 10, 1) })),
    point(audit('e1', 'example.com', { severityCounts: counts(0, 0, 0, 5, 1) })),
    point(audit('l1', '127.0.0.1:4321', { severityCounts: counts(1, 4, 7, 4, 1) })),
    point(audit('b1', '127.0.0.1:5000', { benchmark: true, severityCounts: counts(2, 2, 2, 2) })),
  ]

  it('counts real audits only, with benchmark audits hidden by default', () => {
    const summary = summarizeAudits(stats, history.filter((h) => !h.benchmark), false)
    expect(summary.totalAudits).toBe(10)
    expect(summary.statusCounts).toMatchObject({ completed: 7, failed: 1, queued: 1, running: 1, partial: 0, cancelled: 0 })
    expect([summary.running, summary.queued, summary.hiddenActive]).toEqual([1, 1, 1])
    expect(summary.benchmarkAudits).toBe(4)
    expect(summary.websites).toBe(3)
    expect(summary.localTargets).toBe(1)
    // Completed AI audits of public sites only: (3.6M + 0.6M) / 4.
    expect(summary.averageDurationMs).toBe(1_050_000)
    expect(summary.timedAudits).toBe(4)
    // Latest audit of each public site: j2 (13) + e1 (6).
    expect(summary.latestFindings).toEqual({ websites: 2, total: 19, severity: counts(0, 1, 1, 15, 2) })
  })

  it('includes benchmark audits only when asked, still never as websites or business findings', () => {
    const summary = summarizeAudits(stats, history, true)
    expect(summary.totalAudits).toBe(14)
    expect([summary.running, summary.hiddenActive]).toEqual([2, 0])
    expect(summary.websites).toBe(3)
    expect(summary.localTargets).toBe(2)
    expect(summary.averageDurationMs).toBe(Math.round(6_700_000 / 9))
    expect(summary.latestFindings.total).toBe(19)
  })
})

describe('trend direction', () => {
  it('is decided by critical + high findings, then medium; low and info never change it', () => {
    expect(severityDirection(counts(0, 1, 1, 10), counts(0, 0, 2, 6))).toBe('regressing')
    expect(severityDirection(counts(0, 0, 2, 6), counts(0, 1, 4, 3))).toBe('improving')
    expect(severityDirection(counts(0, 1, 1, 0), counts(1, 0, 5, 0))).toBe('improving')
    expect(severityDirection(counts(0, 0, 1, 50, 9), counts(0, 0, 1, 2))).toBe('stable')
  })

  it('compares each finished AI audit with the previous one of the same site and history, and shows nothing otherwise', () => {
    const first = audit('s1', 'example.com', { severityCounts: counts(0, 2, 3, 1) })
    const benchmarkRun = audit('bx', 'example.com', { benchmark: true, severityCounts: counts(5, 5, 5, 5) })
    const second = audit('s2', 'example.com', { severityCounts: counts(0, 1, 3, 4) })
    const baselineOnly = audit('s3', 'example.com', { aiEnabled: false })
    const running = audit('s4', 'example.com', { status: 'running', stage: 'investigation', finishedAt: null })
    const dashboard = buildDashboard(
      input({
        includeBenchmarks: true,
        recent: [running, baselineOnly, second, benchmarkRun, first],
        history: [first, benchmarkRun, second].map(point),
      }),
    )
    const trend = (id: string) => dashboard.audits.find((a) => a.id === id)!.trend
    expect(trend('s2')).toMatchObject({ direction: 'improving', previousAuditId: 's1' })
    expect(trend('s2')!.history.map((p) => p.auditId)).toEqual(['s1', 's2'])
    // A benchmark run of the same host is its own history, never "the previous audit" of a normal one.
    expect(trend('bx')).toBeNull()
    expect(trend('s1')).toBeNull()
    expect(trend('s3')).toBeNull()
    expect(trend('s4')).toBeNull()
  })
})

describe('active audits', () => {
  it('lists queued and running audits with their real steps', () => {
    const steps: AuditStep[] = [
      { stage: 'preparing', status: 'completed', startedAt: at(), finishedAt: at(), message: null, error: null },
      { stage: 'baseline', status: 'running', startedAt: at(), finishedAt: null, message: null, error: null },
    ]
    const dashboard = buildDashboard(
      input({
        recent: [
          audit('q1', 'example.org', { status: 'queued', stage: 'preparing', startedAt: null, finishedAt: null }),
          audit('r1', 'example.com', { status: 'running', stage: 'baseline', finishedAt: null }),
          audit('c1', 'example.com'),
        ],
        steps: { r1: steps },
      }),
    )
    expect(dashboard.active.map((a) => [a.id, a.status, a.steps.length])).toEqual([
      ['q1', 'queued', 0],
      ['r1', 'running', 2],
    ])
  })
})

describe('priority follow-ups and repeat issues', () => {
  // josamcode.com: two audits with issue keys; books.toscrape.com and shop.example.net: first audits.
  const a1 = audit('a1', 'josamcode.com', { severityCounts: counts(0, 0, 1, 2) })
  const a2 = audit('a2', 'josamcode.com', { severityCounts: counts(0, 1, 1, 2, 1) })
  const b1 = audit('b1', 'books.toscrape.com', { severityCounts: counts(0, 0, 3, 1) })
  const e1 = audit('e1', 'shop.example.net', { severityCounts: counts(0, 0, 1, 0) })
  const f1 = audit('f1', 'fresh.example.com', { severityCounts: counts(0, 0, 0, 1) })
  const f2 = audit('f2', 'fresh.example.com', { severityCounts: counts(0, 0, 0, 1) })
  const local = audit('l1', '127.0.0.1:4321', { severityCounts: counts(1, 1, 0, 0) })
  const findings: FindingSignal[] = [
    signal('a1', 'F1', { issueKey: 'arabic-bidi', severity: 'low', category: 'Localization' }),
    signal('a1', 'F2', { issueKey: 'missing-tracking', severity: 'medium', category: 'Tracking' }),
    signal('a1', 'F3', { issueKey: 'csp', severity: 'low', category: 'Security' }),
    signal('a2', 'F1', { issueKey: 'www-cert', severity: 'high', category: 'Security', businessImpactLevel: 'high' }),
    signal('a2', 'F2', { issueKey: 'arabic-bidi', severity: 'medium', category: 'Localization' }),
    signal('a2', 'F3', { issueKey: 'missing-tracking', severity: 'low', category: 'Tracking', businessImpactLevel: 'low' }),
    signal('a2', 'F4', { issueKey: 'csp', severity: 'low', category: 'Security', businessImpactLevel: 'low' }),
    signal('a2', 'F5', { issueKey: 'strong-foundations', severity: 'info', businessImpactLevel: 'low' }),
    signal('b1', 'F1', { category: 'Conversion' }),
    signal('b1', 'F2', { category: 'Broken Functionality' }),
    signal('b1', 'F3', { type: 'supported-observation', businessImpactLevel: 'low', effort: 'medium' }),
    signal('b1', 'F4', { severity: 'low', businessImpactLevel: 'low' }),
    signal('e1', 'F1', { type: 'inference', businessImpactLevel: 'low', effort: 'high' }),
    signal('f1', 'F1', { issueKey: 'old-thing', severity: 'low', businessImpactLevel: 'low' }),
    signal('f2', 'F1', { issueKey: 'other-thing', severity: 'low', businessImpactLevel: 'low' }),
    signal('l1', 'F1', { severity: 'critical', businessImpactLevel: 'high' }),
  ]
  const history = [a1, a2, b1, e1, f1, f2, local].map(point)
  const dashboard = buildDashboard(input({ recent: [f2, f1, local, e1, b1, a2, a1], history, findings }))

  it('only loads findings of public websites (recent audits, local and benchmark targets excluded)', () => {
    expect(followUpAuditIds(history).sort()).toEqual(['a1', 'a2', 'b1', 'e1', 'f1', 'f2'])
  })

  it('ranks the latest issues deterministically, at most two per website, never local or info-level', () => {
    expect(dashboard.followUps.map((f) => `${f.auditId}:${f.ref}`)).toEqual(['a2:F1', 'a2:F2', 'b1:F1', 'b1:F2', 'e1:F1'])
    const [cert, bidi, conversion] = dashboard.followUps
    expect(cert).toMatchObject({ change: 'new', seenIn: 1, auditsCompared: 2, severity: 'high', domain: 'josamcode.com' })
    expect(bidi).toMatchObject({ change: 'regressed', previousSeverity: 'low', seenIn: 2 })
    expect(conversion).toMatchObject({ change: 'first-audit', seenIn: 1, auditsCompared: 1 })
  })

  it('groups websites whose latest audit repeats issues from the audit before it', () => {
    expect(dashboard.repeatSites).toHaveLength(1)
    expect(dashboard.repeatSites[0]).toMatchObject({
      siteKey: 'josamcode.com',
      latestAuditId: 'a2',
      audits: 2,
      changes: { new: 1, regressed: 1, improved: 1, unchanged: 1, resolved: 0 },
      direction: 'regressing',
    })
    expect(dashboard.repeatSites[0]!.history.map((p) => p.auditId)).toEqual(['a1', 'a2'])
  })

  it('reports one activity item per audit, newest change first', () => {
    // Fixtures were created a1 → l1, so the local audit finished last; the oldest one falls off (six items).
    expect(dashboard.activity.map((item) => item.auditId)).toEqual(['l1', 'f2', 'f1', 'e1', 'b1', 'a2'])
    expect(dashboard.activity[0]).toMatchObject({ kind: 'completed', local: true, findingCount: 2 })
  })
})

describe('empty state', () => {
  it('returns zeros and nothing to list when there are no audits', () => {
    const dashboard = buildDashboard(input({}))
    expect(dashboard.summary).toMatchObject({
      totalAudits: 0,
      websites: 0,
      averageDurationMs: null,
      latestFindings: { websites: 0, total: 0 },
    })
    expect([dashboard.audits, dashboard.active, dashboard.followUps, dashboard.repeatSites, dashboard.activity]).toEqual([[], [], [], [], []])
  })
})
