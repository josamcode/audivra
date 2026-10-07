import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  containerTarget,
  parseHttpxOutput,
  parseKatanaOutput,
  summarizePa11y,
  summarizeTestssl,
  summarizeZapReport,
} from '../src/baseline/scanners.ts'
import { buildLinkGraph, extractPageFacts, type PageFacts } from '../src/baseline/crawl.ts'
import { analyzeLocalization } from '../src/baseline/seo.ts'
import { extractTrackingEvents } from '../src/baseline/signals.ts'

// Trimmed real outputs captured from the tools against the fixture site and example.com.
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', 'scanners', name), 'utf8')

describe('ZAP baseline report', () => {
  it('counts alert types by risk, maps container URLs back to the target and drops false positives', () => {
    const { restore } = containerTarget('http://127.0.0.1:4321/')
    const report = JSON.parse(fixture('zap.json'))
    report.site[0].alerts.push({ name: 'Ignored', riskcode: '3', confidence: '0', instances: [] })
    const summary = summarizeZapReport(report, restore)
    expect(summary.riskCounts).toEqual({ high: 0, medium: 3, low: 2, informational: 0 })
    expect(summary.alerts.map((a) => a.risk)).toEqual(['medium', 'medium', 'medium', 'low', 'low'])
    expect(summary.alerts.every((a) => a.urls.every((u) => u.startsWith('http://127.0.0.1:4321')))).toBe(true)
    expect(summary.alerts.find((a) => a.name === 'Ignored')).toBeUndefined()
    expect(summary.alerts[0]!.solution).not.toMatch(/<p>/)
  })

  it('only rewrites loopback targets for containers', () => {
    expect(containerTarget('http://127.0.0.1:4321/a').target).toBe('http://host.docker.internal:4321/a')
    expect(containerTarget('http://localhost:8080/').target).toBe('http://host.docker.internal:8080/')
    expect(containerTarget('https://example.com/').target).toBe('https://example.com/')
  })
})

describe('testssl.sh report', () => {
  const summary = summarizeTestssl(JSON.parse(fixture('testssl.json')), 'example.com')

  it('reads protocols and the first certificate despite per-certificate id suffixes', () => {
    expect(summary.protocols.filter((p) => p.offered).map((p) => p.name)).toEqual(['TLS 1.0', 'TLS 1.1', 'TLS 1.2', 'TLS 1.3'])
    expect(summary.protocols.filter((p) => p.offered === false).map((p) => p.name)).toEqual(['SSLv2', 'SSLv3'])
    expect(summary.certificate.commonName).toBe('example.com')
    expect(summary.certificate.chainOfTrust).toMatch(/passed/)
    expect(summary.certificate.notAfter).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })

  it('groups per-cipher lines into one item instead of flooding the report', () => {
    const ids = summary.issues.map((i) => i.id)
    expect(ids.filter((id) => id.startsWith('cipher-'))).toEqual([])
    expect(ids).toContain('weak_ciphers')
    expect(new Set(ids).size).toBe(ids.length)
    // Ordered most severe first.
    const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
    const ranks = summary.issues.map((i) => order.indexOf(i.severity))
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
  })
})

describe('httpx, Katana and Pa11y output', () => {
  it('parses the first httpx JSON line', () => {
    const line = JSON.stringify({ url: 'https://example.com', status_code: 200, title: 'Example', webserver: 'nginx', cdn_name: 'cloudflare', tech: ['Nginx', 'HSTS', 'Nginx'] })
    expect(parseHttpxOutput(`[INF] noise\n${line}\n`)).toEqual({
      url: 'https://example.com',
      statusCode: 200,
      title: 'Example',
      webserver: 'nginx',
      cdn: 'cloudflare',
      technologies: ['Nginx', 'HSTS'],
    })
    expect(parseHttpxOutput('no json here')).toBeNull()
  })

  it('counts only fetched same-host HTML pages from Katana and reports blocked requests', () => {
    const { endpoints, pageUrls, blocked } = parseKatanaOutput(fixture('katana.jsonl'), 'http://127.0.0.1:4321/')
    expect(endpoints).toBe(11)
    // Not pages: assets, a 404, an escaped-backslash JS artefact, framework internals, an RSC
    // prefetch variant, another host and a request refused by bot protection.
    expect(pageUrls).toEqual(['http://127.0.0.1:4321/', 'http://127.0.0.1:4321/services/implants', 'http://127.0.0.1:4321/ar/'])
    expect(blocked).toBe(1)
  })

  it('summarizes Pa11y issues by code', () => {
    const summary = summarizePa11y(JSON.parse(fixture('pa11y.json')), 'http://127.0.0.1:4321/')
    expect(summary.errors).toBe(3)
    expect(summary.byCode[0]).toMatchObject({ code: expect.stringContaining('H37'), count: 2 })
  })
})

describe('tracking events and link graph', () => {
  it('lists events actually sent, separately from tags being present', () => {
    const events = extractTrackingEvents([
      'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view&dl=https%3A%2F%2Fx.com',
      'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view',
      'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=generate_lead',
      'https://www.facebook.com/tr/?id=123&ev=PageView',
      'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
      'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123/?random=1',
    ])
    expect(events.map((e) => `${e.tool}:${e.event}`)).toEqual([
      'Google Analytics 4:page_view',
      'Google Analytics 4:generate_lead',
      'Meta Pixel:PageView',
      'Google Ads:remarketing',
    ])
  })

  it('builds page-to-page edges from the crawl, skipping resources and self-links', () => {
    const graph = buildLinkGraph({
      pages: [
        { finalUrl: 'https://x.com/', depth: 0, title: 'Home' },
        { finalUrl: 'https://x.com/a', depth: 1, title: 'A' },
      ] as never,
      linkSources: new Map([
        ['https://x.com/a', { kind: 'page' as const, sources: new Set(['https://x.com/', 'https://x.com/a']), text: 'A' }],
        ['https://x.com/style.css', { kind: 'resource' as const, sources: new Set(['https://x.com/']), text: '' }],
      ]),
    })
    expect(graph.pages).toHaveLength(2)
    expect(graph.edges).toEqual([{ from: 'https://x.com/', to: 'https://x.com/a' }])
  })
})

describe('localization signals', () => {
  const page = (url: string, overrides: Partial<PageFacts> = {}): PageFacts => ({
    ...extractPageFacts('<html><body>x</body></html>', url).facts,
    url,
    finalUrl: url,
    status: 200,
    depth: 1,
    source: 'link',
    contentType: 'text/html',
    bytes: 100,
    timingMs: 10,
    error: null,
    redirects: 0,
    xRobotsTag: null,
    ...overrides,
  })

  it('reports non-reciprocal, mismatched and invalid hreflang annotations between crawled pages', () => {
    const facts = analyzeLocalization([
      page('https://x.com/en/', { lang: 'en', hreflang: [{ lang: 'en', href: '/en/' }, { lang: 'ar', href: '/ar/' }, { lang: 'english', href: '/en/' }] }),
      page('https://x.com/ar/', { lang: 'en', hreflang: [{ lang: 'ar', href: 'https://x.com/ar/' }] }),
    ])
    const kinds = facts.hreflangIssues.map((i) => `${new URL(i.url).pathname}:${i.kind}`)
    expect(kinds).toEqual(expect.arrayContaining(['/en/:invalid-code', '/en/:not-reciprocal', '/en/:language-mismatch']))
    expect(kinds).not.toContain('/ar/:no-self-reference')
  })

  it('flags Latin-script navigation on Arabic pages and metadata shared across languages', () => {
    const facts = analyzeLocalization([
      page('https://x.com/en/about', { lang: 'en', title: 'About us' }),
      page('https://x.com/ar/about', { lang: 'ar', dir: 'rtl', arabicCharRatio: 0.9, navLatinRatio: 0.9, controlsLatinRatio: 0.1, title: 'About us' }),
      page('https://x.com/en/pricing', { lang: 'en' }),
    ])
    expect(facts.mixedLanguage).toEqual([{ url: 'https://x.com/ar/about', area: 'navigation', latinShare: 0.9 }])
    expect(facts.untranslatedMetadata[0]).toMatchObject({ field: 'title', value: 'About us' })
    expect(facts.missingPairs).toEqual([{ path: '/pricing', present: ['en'], missing: 'ar' }])
  })
})
