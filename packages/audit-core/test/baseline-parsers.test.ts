import { describe, expect, it } from 'vitest'
import { extractPageFacts, diversifySample, type PageFacts } from '../src/baseline/crawl.ts'
import { parseRobots } from '../src/baseline/discovery.ts'
import { securityHeaderFacts } from '../src/baseline/http.ts'
import { summarizeLighthouse } from '../src/baseline/lighthouse.ts'
import { analyzeLocalization, analyzeSeo, choosePagesForBrowser } from '../src/baseline/seo.ts'
import { detectTechnologies, detectTracking, extractTrackingIds } from '../src/baseline/signals.ts'

const HTML = `<!doctype html><html lang="ar"><head>
<title>متجر</title><meta name="description" content="desc"><link rel="canonical" href="https://shop.example/">
<link rel="alternate" hreflang="en" href="https://shop.example/en/">
<meta name="viewport" content="width=device-width">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":"WebSite"}]}</script>
</head><body><h1>مرحبا بكم في المتجر</h1><h1>Second</h1>
<img src="/a.png"><img src="/b.png" alt="">
<a href="/products">منتجات</a><a href="https://other.example/x">x</a><a href="mailto:a@b.c">mail</a>
<form><input></form><script src="/app.js"></script></body></html>`

describe('extractPageFacts', () => {
  it('extracts SEO, content and localization facts', () => {
    const { facts, links } = extractPageFacts(HTML, 'https://shop.example/')
    expect(facts.title).toBe('متجر')
    expect(facts.h1).toHaveLength(2)
    expect(facts.lang).toBe('ar')
    expect(facts.dir).toBeNull()
    expect(facts.hreflang).toEqual([{ lang: 'en', href: 'https://shop.example/en/' }])
    expect(facts.imagesMissingAlt).toBe(1)
    expect(facts.structuredDataTypes).toEqual(['Organization', 'WebSite'])
    expect(facts.arabicCharRatio).toBeGreaterThan(0.6)
    expect(facts.internalLinks).toBe(1)
    expect(facts.externalLinks).toBe(1)
    expect(links.filter((l) => l.kind === 'resource').map((l) => l.href)).toContain(
      'https://shop.example/app.js',
    )
  })
})

describe('parseRobots', () => {
  it('collects sitemaps and disallow rules for the * group', () => {
    const parsed = parseRobots(
      'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /admin/\nDisallow:\nSitemap: https://x/sitemap.xml',
    )
    expect(parsed.disallow).toEqual(['/admin/'])
    expect(parsed.sitemaps).toEqual(['https://x/sitemap.xml'])
  })
})

function page(overrides: Partial<PageFacts>): PageFacts {
  return {
    url: 'https://x/',
    finalUrl: 'https://x/',
    status: 200,
    depth: 0,
    source: 'link',
    contentType: 'text/html',
    bytes: 1000,
    timingMs: 100,
    error: null,
    redirects: 0,
    title: 'Title',
    description: 'Desc',
    canonical: 'https://x/',
    robotsMeta: null,
    xRobotsTag: null,
    h1: ['H'],
    h2Count: 0,
    lang: 'en',
    dir: null,
    hreflang: [],
    viewport: 'width=device-width',
    ogTitle: null,
    ogImage: null,
    generator: null,
    images: 0,
    imagesMissingAlt: 0,
    missingAltSamples: [],
    internalLinks: 0,
    externalLinks: 0,
    forms: 0,
    wordCount: 100,
    arabicCharRatio: 0,
    navLatinRatio: null,
    controlsLatinRatio: null,
    structuredDataTypes: [],
    scripts: 0,
    stylesheets: 0,
    ...overrides,
  }
}

describe('analyzeSeo / analyzeLocalization', () => {
  const pages = [
    page({}),
    page({ url: 'https://x/a', finalUrl: 'https://x/a', title: 'Title', h1: [], canonical: 'https://x/' }),
    page({
      url: 'https://x/ar/',
      finalUrl: 'https://x/ar/',
      canonical: 'https://x/ar/',
      lang: 'ar',
      arabicCharRatio: 0.9,
      title: 'عربي',
      description: null,
    }),
    page({ url: 'https://x/gone', finalUrl: 'https://x/gone', status: 404 }),
  ]

  it('aggregates duplicates and missing metadata', () => {
    const seo = analyzeSeo(pages)
    expect(seo.duplicateTitles).toEqual([{ value: 'Title', urls: ['https://x/', 'https://x/a'] }])
    expect(seo.missingH1).toEqual(['https://x/a'])
    expect(seo.missingDescription).toEqual(['https://x/ar/'])
    expect(seo.canonicalToOtherUrl).toEqual([{ url: 'https://x/a', canonical: 'https://x/' }])
    expect(seo.non200).toHaveLength(1)
  })

  it('flags Arabic pages that are not right-to-left', () => {
    const loc = analyzeLocalization(pages)
    expect(loc.languages).toEqual(['en', 'ar'])
    expect(loc.directionMismatches.map((d) => d.url)).toEqual(['https://x/ar/'])
    expect(loc.localePathPrefixes).toEqual(['ar'])
  })

  it('chooses the start page plus distinct sections for the browser', () => {
    const chosen = choosePagesForBrowser(pages, 'https://x/', 3)
    expect(chosen[0]).toBe('https://x/')
    expect(chosen).toHaveLength(3)
    expect(chosen).not.toContain('https://x/gone')
  })
})

describe('diversifySample', () => {
  it('round-robins across top-level sections', () => {
    const urls = ['https://x/p/1', 'https://x/p/2', 'https://x/p/3', 'https://x/blog/1', 'https://x/about']
    expect(diversifySample(urls, 3)).toEqual(['https://x/p/1', 'https://x/blog/1', 'https://x/about'])
  })
})

describe('signals', () => {
  const urls = [
    'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123',
    'https://www.googletagmanager.com/gtag/js?id=G-XYZ987',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://www.facebook.com/tr/?id=123456&ev=PageView',
    'https://cdn.shopify.com/s/files/theme.js',
  ]

  it('detects tracking vendors and IDs', () => {
    const names = detectTracking(urls, ['dataLayer']).map((h) => h.name)
    expect(names).toEqual(
      expect.arrayContaining(['Google Tag Manager', 'Google Analytics 4', 'Meta Pixel', 'dataLayer']),
    )
    expect(extractTrackingIds(urls)).toEqual(expect.arrayContaining(['GTM-ABC123', 'G-XYZ987', 'fb:123456']))
    expect(detectTracking(['https://example.com/app.js'], [])).toEqual([])
  })

  it('detects technology hints from headers, URLs and markup', () => {
    const names = detectTechnologies({
      headers: { server: 'cloudflare', 'x-powered-by': 'PHP/8.2' },
      requestUrls: urls,
      html: '<div ng-version="17">',
    }).map((h) => h.name)
    expect(names).toEqual(expect.arrayContaining(['Cloudflare', 'PHP', 'Shopify', 'Angular']))
  })
})

describe('securityHeaderFacts', () => {
  it('records present/missing headers and cookie flags', () => {
    const facts = securityHeaderFacts(
      { 'strict-transport-security': 'max-age=31536000', server: 'nginx/1.18.0' },
      ['sid=1; Path=/; HttpOnly; Secure; SameSite=Lax', 'pref=2; Path=/'],
    )
    expect(facts.present).toHaveProperty('strict-transport-security')
    expect(facts.missing).toContain('content-security-policy')
    expect(facts.disclosure).toEqual({ server: 'nginx/1.18.0' })
    expect(facts.cookies).toEqual([
      { name: 'sid', secure: true, httpOnly: true, sameSite: 'lax' },
      { name: 'pref', secure: false, httpOnly: false, sameSite: null },
    ])
  })
})

describe('summarizeLighthouse', () => {
  it('extracts scores, metrics and top opportunities', () => {
    const report = {
      finalDisplayedUrl: 'https://x/',
      categories: {
        performance: {
          score: 0.42,
          auditRefs: [
            { id: 'largest-contentful-paint' },
            { id: 'render-blocking-resources' },
            { id: 'uses-optimized-images' },
          ],
        },
        seo: { score: 0.9, auditRefs: [] },
      },
      audits: {
        'largest-contentful-paint': {
          id: 'largest-contentful-paint',
          title: 'LCP',
          score: 0.1,
          scoreDisplayMode: 'numeric',
          numericValue: 5123.4,
        },
        'cumulative-layout-shift': {
          id: 'cumulative-layout-shift',
          title: 'CLS',
          score: 1,
          scoreDisplayMode: 'numeric',
          numericValue: 0.0123,
        },
        'total-byte-weight': {
          id: 'total-byte-weight',
          title: 'Weight',
          score: 0.5,
          scoreDisplayMode: 'numeric',
          numericValue: 3_500_000,
        },
        'render-blocking-resources': {
          id: 'render-blocking-resources',
          title: 'Eliminate render-blocking resources',
          score: 0.2,
          scoreDisplayMode: 'metricSavings',
          details: { type: 'opportunity', overallSavingsMs: 1200 },
        },
        'uses-optimized-images': {
          id: 'uses-optimized-images',
          title: 'Efficiently encode images',
          score: 0.5,
          scoreDisplayMode: 'metricSavings',
          details: { type: 'opportunity', overallSavingsMs: 300, overallSavingsBytes: 900_000 },
        },
      },
    }
    const summary = summarizeLighthouse(report, 'mobile', 'r.json', null)
    expect(summary.scores).toEqual({ performance: 42, accessibility: null, bestPractices: null, seo: 90 })
    expect(summary.metrics.lcpMs).toBe(5123)
    expect(summary.metrics.cls).toBe(0.012)
    expect(summary.totalBytes).toBe(3_500_000)
    expect(summary.opportunities.map((o) => o.id)).toEqual([
      'render-blocking-resources',
      'uses-optimized-images',
    ])
  })
})
