import { describe, expect, it } from 'vitest'
import type { AuditComparison, AuditStep, BenchmarkFixtureResult } from '@audivra/contracts'
import { metricSnapshots } from '../src/audit-data.ts'
import { scoreChanges, scoreJourneys } from '../src/benchmark.ts'
import { buildFindingTimelines, changeFactIndex, compareJourneys, compareNames } from '../src/changes.ts'
import { compareCoverage } from '../src/compare.ts'
import { IN_PROGRESS } from '../src/coverage.ts'
import { clientSafeText, toReportJourney } from '../src/report.ts'
import { brief, finding, journey } from './helpers.ts'

describe('journey changes', () => {
  it('matches by journey key and reports step and health changes only', () => {
    const before = journey('J1')
    const after = journey('J1', {
      steps: before.steps.map((s, i) => (i === 1 ? { ...s, status: 'blocked' } : s)),
      health: [{ dimension: 'tracking', status: 'problem', note: 'No event', evidenceIds: ['EV-2'], findingIds: [] }],
    })
    const [change] = compareJourneys([after], [before])
    expect(change).toMatchObject({ status: 'changed', currentRef: 'J1', previousRef: 'J1', pathChanged: false })
    expect(change!.steps).toEqual([{ label: 'WhatsApp chat', before: 'ok', after: 'blocked' }])
    expect(change!.health).toEqual([{ dimension: 'tracking', before: 'healthy', after: 'problem' }])
  })

  it('falls back to type and path when the key was reworded', () => {
    const before = journey('J2', { journeyKey: 'booking-whatsapp' })
    const after = journey('J1', { journeyKey: 'whatsapp-appointment' })
    const [change] = compareJourneys([after], [before])
    expect(change).toMatchObject({ status: 'unchanged', previousRef: 'J2' })
  })

  it('reports new journeys and ones that were not found again (never "removed")', () => {
    const changes = compareJourneys(
      [journey('J1', { journeyKey: 'contact-form', type: 'lead', steps: [{ ...journey('J1').steps[0]!, url: 'https://example.com/contact' }, journey('J1').steps[1]!] })],
      [journey('J1')],
    )
    expect(changes.map((c) => c.status).sort()).toEqual(['new', 'not-found-again'])
  })

  it('compares tracking tools by name, case-insensitively', () => {
    expect(compareNames(['GA4', 'Meta Pixel'], ['ga4', 'Hotjar'])).toEqual({ added: ['Meta Pixel'], removed: ['Hotjar'], unchanged: ['GA4'] })
  })
})

describe('finding timelines', () => {
  const audits = [
    { id: 'a1', date: '2026-08-01T00:00:00.000Z', findings: [brief('F1', { title: 'Missing form labels', category: 'Accessibility', issueKey: 'a11y-form-labels' }), brief('F2', { title: 'Slow LCP', issueKey: 'perf-lcp' })] },
    { id: 'a2', date: '2026-09-01T00:00:00.000Z', findings: [brief('F1', { title: 'Slow LCP', issueKey: 'perf-lcp' })] },
    { id: 'a3', date: '2026-10-01T00:00:00.000Z', findings: [brief('F1', { title: 'Slow LCP', issueKey: 'perf-lcp' }), brief('F2', { title: 'Missing form labels', category: 'Accessibility', issueKey: 'a11y-form-labels' })] },
  ]

  it('tracks each issue across audits without calling absence a fix', () => {
    const timelines = buildFindingTimelines(audits)
    const labels = timelines.find((t) => t.key === 'a11y-form-labels')!
    expect(labels.entries.map((e) => e.status)).toEqual(['detected', 'not-found', 'detected-again'])
    expect(labels.currentRef).toBe('F2')
    const lcp = timelines.find((t) => t.key === 'perf-lcp')!
    expect(lcp.entries.map((e) => e.status)).toEqual(['detected', 'detected', 'detected'])
    expect(JSON.stringify(timelines)).not.toMatch(/fixed|resolved/)
  })

  it('starts an issue on the audit that first reported it', () => {
    const timelines = buildFindingTimelines([audits[1]!, audits[2]!])
    expect(timelines.find((t) => t.key === 'a11y-form-labels')!.entries).toHaveLength(1)
  })
})

const comparison = (findings: AuditComparison['findings']): AuditComparison => ({
  siteKey: 'example.com',
  current: { id: 'b', createdAt: '2026-10-01T00:00:00.000Z', finishedAt: null, status: 'completed', findingCount: 2 },
  previous: { id: 'a', createdAt: '2026-09-01T00:00:00.000Z', finishedAt: null, status: 'completed', findingCount: 2 },
  summary: { new: 0, resolved: 0, improved: 0, regressed: 0, unchanged: 0 },
  findings,
  metrics: [{ key: 'lcp', label: 'LCP', unit: 'ms', lowerIsBetter: true, before: 2000, after: 3500, delta: 1500, direction: 'regressed' }],
  technologies: { added: [], removed: [], unchanged: [] },
  tracking: { added: ['GA4'], removed: [], unchanged: [] },
  journeys: [],
  coverage: [],
  screenshots: [],
})

describe('facts while visuals are still being made (Change Intelligence runs then)', () => {
  const step = (stage: AuditStep['stage'], status: AuditStep['status']): AuditStep => ({ stage, status, message: null, error: null, startedAt: null, finishedAt: null })

  it('counts findings once finalization completed, even though the audit is still running', () => {
    const row = { aiEnabled: true, status: 'running', baseline: null } as unknown as Parameters<typeof metricSnapshots>[0]['row']
    const findings = [finding('F1', { severity: 'high' }), finding('F2')]
    const total = (steps: AuditStep[]) => metricSnapshots({ row, findings, steps }).find((m) => m.key === 'findings.total')!.value
    expect(total([step('finalizing', 'completed'), step('presenting', 'running')])).toBe(2)
    expect(total([step('finalizing', 'running')])).toBeNull()
  })

  it('does not report a capability that is still in progress as a coverage change', () => {
    const coverage = compareCoverage(
      [
        { capability: 'ai-investigation', label: 'AI investigation', status: 'ran', tools: [], reason: null, detail: null },
        { capability: 'visuals', label: 'Visual report', status: 'partial', tools: [], reason: IN_PROGRESS, detail: null },
      ],
      [
        { capability: 'ai-investigation', label: 'AI investigation', status: 'ran', tools: [], reason: null, detail: null },
        { capability: 'visuals', label: 'Visual report', status: 'ran', tools: [], reason: null, detail: null },
      ],
    )
    expect(coverage.map((c) => c.capability)).toEqual(['ai-investigation'])
  })
})

describe('change facts for the interpreter', () => {
  it('indexes what the comparison established', () => {
    const facts = changeFactIndex(
      comparison([
        { status: 'resolved', current: null, previous: brief('F4'), matchedBy: null, matchScore: null },
        { status: 'new', current: brief('F1'), previous: null, matchedBy: null, matchScore: null },
      ]),
      ['EV-1'],
    )
    expect(facts.previousFindings.get('F4')).toBe('resolved')
    expect(facts.currentFindings.get('F1')).toBe('new')
    expect(facts.metrics.get('lcp')).toBe('regressed')
    expect(facts.trackingChanged).toBe(true)
    expect(facts.currentEvidence.has('EV-1')).toBe(true)
  })
})

describe('client-safe text', () => {
  it('removes local paths and shell commands but keeps facts and public URLs', () => {
    const text = clientSafeText(
      'Measured with `npx lighthouse https://example.com --output json` (saved to tools/lighthouse-home.json); D:\\MyProjects\\Audivra\\.local-data\\x.png shows LCP 3.1 s on https://example.com/.',
    )
    expect(text).not.toMatch(/npx|tools\/|MyProjects|\.local-data/)
    expect(text).toContain('LCP 3.1 s')
    expect(text).toContain('https://example.com/')
  })

  it('shows clients only judged journey dimensions, with cleaned notes', () => {
    const j = toReportJourney(
      journey('J1', {
        health: [
          { dimension: 'tracking', status: 'problem', note: 'See `curl -I https://example.com`', evidenceIds: [], findingIds: [] },
          { dimension: 'mobile', status: 'not-assessed', note: '', evidenceIds: [], findingIds: [] },
        ],
      }),
    )
    expect(j.health.map((h) => h.dimension)).toEqual(['tracking'])
    expect(j.health[0]!.note).not.toContain('curl')
  })
})

describe('benchmark scoring of journeys and changes', () => {
  it('checks the primary journey structure, never its wording', () => {
    const result = scoreJourneys({ primaryTypes: ['booking', 'lead'], conversion: 'whatsapp|wa\\.me|form', noProblems: false }, [journey('J1')])
    expect(result).toMatchObject({ journeys: 1, primaryFound: true, primaryType: 'booking', primaryTypeCorrect: true, conversionCorrect: true, blockedSteps: 0 })
  })

  it('flags invented problems on a healthy fixture', () => {
    const broken = journey('J1', { steps: journey('J1').steps.map((s, i) => (i === 1 ? { ...s, status: 'blocked' } : s)) })
    const result = scoreJourneys({ primaryTypes: ['booking'], conversion: 'whatsapp', noProblems: true }, [broken])
    expect(result.unexpectedProblems).toBe(true)
    expect(result.notes.join(' ')).toMatch(/Unexpected/)
  })

  it('checks that localized journeys stay in their language section', () => {
    const mixed = journey('J1', {
      steps: [
        { ...journey('J1').steps[0]!, url: 'https://example.com/ar/services' },
        { ...journey('J1').steps[0]!, label: 'Contact', url: 'https://example.com/contact' },
      ],
    })
    expect(scoreJourneys({ primaryTypes: ['booking'], conversion: 'x', noProblems: false, localizedPrefix: '/ar/' }, [mixed]).localizedConsistent).toBe(false)
  })

  it('scores the deterministic comparison against known differences', () => {
    const fixture = (issues: { id: string; ref: string | null }[]): BenchmarkFixtureResult => ({
      fixture: 'x',
      healthy: false,
      auditId: 'a',
      status: 'completed',
      durationMs: null,
      auditorTurns: null,
      findings: 0,
      known: issues.length,
      found: issues.filter((i) => i.ref).length,
      missed: 0,
      falsePositives: 0,
      unsupported: 0,
      severityCorrect: 0,
      evidenceLinked: 0,
      issues: issues.map((i) => ({
        id: i.id,
        description: i.id,
        deterministic: false,
        found: i.ref !== null,
        matchedFindingRef: i.ref,
        severityExpected: ['medium'],
        severityActual: null,
        severityCorrect: null,
        evidenceLinked: null,
      })),
      falsePositiveDetails: [],
      unsupportedDetails: [],
      error: null,
    })
    const v1 = fixture([
      { id: 'banner-overflow', ref: 'F1' },
      { id: 'missing-labels', ref: 'F2' },
    ])
    const v2 = fixture([
      { id: 'missing-labels', ref: 'F1' },
      { id: 'broken-whatsapp', ref: 'F2' },
    ])
    const result = scoreChanges(
      { comparedWith: 'v1', notFoundAgain: ['banner-overflow'], stillPresent: ['missing-labels'], new: ['broken-whatsapp'] },
      v1,
      v2,
      comparison([
        { status: 'resolved', current: null, previous: brief('F1'), matchedBy: null, matchScore: null },
        { status: 'unchanged', current: brief('F1'), previous: brief('F2'), matchedBy: 'issue-key', matchScore: 1 },
        { status: 'new', current: brief('F2'), previous: null, matchedBy: null, matchScore: null },
      ]),
    )
    expect(result).toMatchObject({ comparedWith: 'v1', expected: 3, correct: 3 })
  })
})
