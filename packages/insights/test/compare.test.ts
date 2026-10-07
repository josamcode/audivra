import { describe, expect, it } from 'vitest'
import { compareMetrics, matchFindings, pairScreenshots, summarize, type MetricSnapshot } from '../src/compare.ts'
import { brief, evidence } from './helpers.ts'

describe('finding comparison across audits', () => {
  it('classifies new, resolved, persisting, improved and regressed findings', () => {
    const previous = [
      brief('F1', { issueKey: 'www-certificate-mismatch', title: 'www host serves an invalid certificate', severity: 'high', category: 'Security' }),
      brief('F2', { issueKey: 'missing-conversion-tracking', title: 'No conversion tracking on enquiries', severity: 'high', category: 'Tracking' }),
      brief('F3', { issueKey: 'mobile-text-too-small', title: 'Body text is too small on mobile', severity: 'low', category: 'Mobile' }),
      brief('F4', { title: 'Arabic homepage loads slower than English', severity: 'medium', category: 'Performance', affectedUrls: ['https://example.com/ar'] }),
    ]
    const current = [
      // Same issue key → matched even though the wording changed; severity unchanged → persisting.
      brief('F1', { issueKey: 'www-certificate-mismatch', title: 'Certificate error on www subdomain', severity: 'high', category: 'Security' }),
      // Same key, lower severity → improved.
      brief('F2', { issueKey: 'missing-conversion-tracking', title: 'Conversion tracking only on WhatsApp', severity: 'medium', category: 'Tracking' }),
      // Same key, higher severity → regressed.
      brief('F3', { issueKey: 'mobile-text-too-small', title: 'Body text is too small on mobile', severity: 'medium', category: 'Mobile' }),
      // No key, similar title/category/page → matched by similarity.
      brief('F4', { title: 'Arabic homepage loads slower than the English homepage', severity: 'medium', category: 'Performance', affectedUrls: ['https://example.com/ar/'] }),
      brief('F5', { issueKey: 'contact-page-noindex', title: 'Contact page is marked noindex', severity: 'high', category: 'SEO' }),
    ]
    const changes = matchFindings(current, previous)
    const status = (ref: string) => changes.find((c) => c.current?.ref === ref)?.status
    expect(status('F1')).toBe('unchanged')
    expect(status('F2')).toBe('improved')
    expect(status('F3')).toBe('regressed')
    expect(status('F4')).toBe('unchanged')
    expect(changes.find((c) => c.current?.ref === 'F4')?.matchedBy).toBe('similarity')
    expect(status('F5')).toBe('new')
    expect(summarize(changes)).toEqual({ new: 1, resolved: 0, improved: 1, regressed: 1, unchanged: 2 })
  })

  it('reports previous findings that no longer appear as resolved, and never matches different keys', () => {
    const changes = matchFindings(
      [brief('F1', { issueKey: 'broken-links', title: 'Broken links on service pages' })],
      [
        brief('F1', { issueKey: 'broken-links-footer', title: 'Broken links on service pages' }),
        brief('F2', { issueKey: 'js-error', title: 'JavaScript error on every page', category: 'Broken Functionality' }),
      ],
    )
    expect(summarize(changes)).toEqual({ new: 1, resolved: 2, improved: 0, regressed: 0, unchanged: 0 })
  })
})

describe('metric comparison', () => {
  const metric = (key: string, value: number | null, lowerIsBetter: boolean, noise: number): MetricSnapshot => ({ key, label: key, unit: 'ms', lowerIsBetter, noise, value })

  it('ignores lab noise and gets the direction right for both kinds of metric', () => {
    const changes = compareMetrics(
      [metric('lcp', 2500, true, 150), metric('perf', 80, false, 3), metric('cls', 0.105, true, 0.01), metric('broken', 0, true, 0), metric('new', 5, true, 0)],
      [metric('lcp', 3100, true, 150), metric('perf', 91, false, 3), metric('cls', 0.1, true, 0.01), metric('broken', 3, true, 0), metric('new', null, true, 0)],
    )
    const by = (key: string) => changes.find((c) => c.key === key)!
    expect(by('lcp')).toMatchObject({ direction: 'improved', delta: -600 })
    expect(by('perf')).toMatchObject({ direction: 'regressed', delta: -11 })
    expect(by('cls').direction).toBe('unchanged')
    expect(by('broken').direction).toBe('improved')
    expect(by('new').direction).toBe('new')
  })
})

describe('before/after screenshots', () => {
  it('pairs the same page and viewport across audits, preferring baseline captures', () => {
    const shot = (ref: string, url: string, viewport: string, source: 'baseline' | 'auditor' = 'baseline') =>
      evidence(ref, { type: 'screenshot', url, artifactPath: `screenshots/${ref}.png`, metadata: { viewport }, source })
    const pairs = pairScreenshots(
      { auditId: 'b', date: '2026-10-08', evidence: [shot('EV-2', 'https://x.com/', '390x844', 'auditor'), shot('EV-3', 'https://x.com/', '390x844'), shot('EV-4', 'https://x.com/about', '1440x900')] },
      { auditId: 'a', date: '2026-10-01', evidence: [shot('EV-9', 'https://x.com/', '390x844')] },
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ url: '/', viewport: 'mobile', before: { evidenceRef: 'EV-9' }, after: { evidenceRef: 'EV-3' } })
  })
})
