import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { benchmarkTotals, BenchmarkSuite, scoreFixture, type FixtureExpectations } from '../src/benchmark.ts'
import { evidence, finding } from './helpers.ts'

const suite = BenchmarkSuite.parse(
  JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'fixtures', 'site', 'expectations.json'), 'utf8')),
)
const fixture = (id: string) => suite.fixtures.find((f) => f.id === id) as FixtureExpectations

describe('benchmark ground truth', () => {
  it('ships all three fixture variants with valid patterns', () => {
    expect(suite.fixtures.map((f) => f.id)).toEqual(['v1', 'v2', 'healthy'])
    for (const f of suite.fixtures) {
      for (const p of [...f.issues.map((i) => i.match), ...f.absent.map((a) => a.match), ...f.tolerated]) expect(() => new RegExp(p, 'i')).not.toThrow()
    }
    expect(fixture('healthy').issues).toEqual([])
  })
})

describe('benchmark scoring', () => {
  const ev = [
    evidence('EV-3', { type: 'dom-observation', title: 'Horizontal overflow on mobile: / is 1200px wide in a 390px viewport' }),
    evidence('EV-7', { type: 'console-error', title: '1 console/JS error(s) on /' }),
  ]
  const base = { auditId: 'a1', status: 'completed', durationMs: 600_000, auditorTurns: 40, evidence: ev }

  it('counts found, missed, severity band and evidence linkage on the planted-issue fixture', () => {
    const result = scoreFixture(fixture('v1'), {
      ...base,
      findings: [
        finding('F1', { title: 'Promo banner causes horizontal overflow on mobile', category: 'Mobile', severity: 'high', evidenceRefs: ['EV-3'] }),
        finding('F2', { title: 'JavaScript error: initBookingWidget is not defined', category: 'Broken Functionality', severity: 'low', evidenceRefs: ['EV-3'] }),
        finding('F3', { title: 'Site is slow to load', description: 'Poor performance on mobile', category: 'Performance', severity: 'medium', evidenceRefs: [] }),
      ],
    })
    const issue = (id: string) => result.issues.find((i) => i.id === id)!
    expect(issue('mobile-overflow')).toMatchObject({ found: true, matchedFindingRef: 'F1', severityCorrect: true, evidenceLinked: true })
    // Found, but it cites overflow evidence instead of the console error: linkage is not correct.
    expect(issue('js-error')).toMatchObject({ found: true, severityCorrect: true, evidenceLinked: false })
    expect(issue('arabic-rtl').found).toBe(false)
    expect(result.known).toBe(fixture('v1').issues.filter((i) => i.deterministic).length)
    expect(result.found).toBe(2)
    expect(result.missed).toBe(result.known - 2)
    // "Site is slow" is known to be false for the tiny local fixture, and it cites no evidence.
    expect(result.falsePositives).toBe(1)
    expect(result.falsePositiveDetails[0]!.ref).toBe('F3')
    expect(result.unsupported).toBe(1)
    // Subjective expectations are reported but never scored.
    expect(issue('trust-proof').deterministic).toBe(false)
  })

  it('flags unexpected problems on the healthy fixture but tolerates environment facts and info findings', () => {
    const result = scoreFixture(fixture('healthy'), {
      ...base,
      findings: [
        finding('F1', { title: 'Site is served over plain HTTP without TLS', category: 'Security', severity: 'high' }),
        finding('F2', { title: 'No analytics or conversion tracking', category: 'Tracking', severity: 'medium' }),
        finding('F3', { title: 'Images are missing alt text', category: 'Accessibility', severity: 'medium' }),
        finding('F4', { title: 'Hero headline is vague', category: 'Conversion', severity: 'medium' }),
        finding('F5', { title: 'No missing alt text found', category: 'Accessibility', severity: 'info' }),
      ],
    })
    expect(result.known).toBe(0)
    expect(result.falsePositiveDetails.map((f) => f.ref)).toEqual(['F3', 'F4'])
    expect(result.falsePositiveDetails[0]!.reason).toMatch(/known to be absent/)
    expect(result.falsePositiveDetails[1]!.reason).toMatch(/Unexpected medium finding on a healthy fixture/)
  })

  it('treats claims about issues fixed in v2 as false positives', () => {
    const result = scoreFixture(fixture('v2'), {
      ...base,
      findings: [finding('F1', { title: 'ReferenceError: initBookingWidget is not defined', category: 'Broken Functionality', severity: 'medium' })],
    })
    expect(result.falsePositives).toBe(1)
  })

  it('sums totals and averages only real values', () => {
    const a = scoreFixture(fixture('v1'), { ...base, findings: [] })
    const b = scoreFixture(fixture('healthy'), { ...base, durationMs: null, auditorTurns: 20, findings: [] })
    const totals = benchmarkTotals([a, b])
    expect(totals).toMatchObject({ known: a.known, found: 0, missed: a.known, falsePositives: 0, avgDurationMs: 600_000, avgAuditorTurns: 30 })
  })
})
