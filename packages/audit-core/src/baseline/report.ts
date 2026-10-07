import type { BaselineStats } from '@audivra/contracts'
import type { BrowserPageReport } from './browser.ts'
import type { CrawlResult } from './crawl.ts'
import type { RobotsFacts, SitemapFacts } from './discovery.ts'
import type { FetchResult, TlsInfo } from './http.ts'
import type { LighthouseSummary } from './lighthouse.ts'
import type { LinkCheckSummary } from './links.ts'
import type { HttpxSummary, KatanaSummary, Pa11ySummary, TestsslSummary, ZapSummary } from './scanners.ts'
import type { LocalizationFacts, SeoFacts } from './seo.ts'
import type { SignalHit, TrackingEvent } from './signals.ts'

export interface BaselineData {
  url: string
  home: FetchResult | null
  httpUpgrade: {
    status: number | null
    location: string | null
    redirectsToHttps: boolean
    error: string | null
  } | null
  tls: TlsInfo | null
  robots: RobotsFacts | null
  sitemaps: SitemapFacts | null
  crawl: CrawlResult | null
  seo: SeoFacts | null
  localization: LocalizationFacts | null
  links: LinkCheckSummary | null
  browser: BrowserPageReport[]
  lighthouse: LighthouseSummary | null
  tracking: (SignalHit & { pages: string[] })[]
  /** Tracking events observed on page load (no interactions are performed by the baseline). */
  trackingEvents: TrackingEvent[]
  technologies: SignalHit[]
  scanners: {
    zap: ZapSummary | null
    testssl: TestsslSummary | null
    httpx: HttpxSummary | null
    katana: KatanaSummary | null
    pa11y: Pa11ySummary[]
  }
  /** Same-site URLs found only by Katana (not by the crawler or sitemaps). */
  extraDiscovered: number
  /** Evidence refs of the main baseline evidence items, by topic. */
  refs: Record<string, string>
}

export function buildBaselineStats(
  data: BaselineData,
  skipped: BaselineStats['skippedCapabilities'],
): BaselineStats {
  const consoleErrors = new Set<string>()
  const networkFailures = new Set<string>()
  const axeRules = new Set<string>()
  for (const page of data.browser) {
    for (const view of [page.desktop, page.mobile]) {
      view?.consoleErrors.filter((c) => c.type === 'error').forEach((c) => consoleErrors.add(c.text))
      view?.pageErrors.forEach((e) => consoleErrors.add(e))
      view?.failedRequests.forEach((f) => networkFailures.add(`${f.url}|${f.status}`))
    }
    page.axe?.violations.forEach((v) => axeRules.add(`${page.url}|${v.id}`))
  }
  const lh = data.lighthouse
  return {
    pagesDiscovered: (data.crawl?.discoveredUrls ?? 0) + data.extraDiscovered,
    pagesCrawled: data.crawl?.pages.length ?? 0,
    pagesInspectedInBrowser: data.browser.length,
    brokenLinks: data.links?.broken.length ?? 0,
    consoleErrors: consoleErrors.size,
    networkFailures: networkFailures.size,
    accessibilityViolations: axeRules.size,
    trackingDetected: data.tracking.map((t) => t.name),
    technologyHints: data.technologies.map((t) => t.name),
    languages: data.localization?.languages ?? [],
    lighthouse: lh
      ? {
          url: lh.url,
          formFactor: lh.formFactor,
          performance: lh.scores.performance,
          accessibility: lh.scores.accessibility,
          seo: lh.scores.seo,
          bestPractices: lh.scores.bestPractices,
          lcpMs: lh.metrics.lcpMs,
          cls: lh.metrics.cls,
          tbtMs: lh.metrics.tbtMs,
          totalBytes: lh.totalBytes,
        }
      : null,
    skippedCapabilities: skipped,
  }
}

const list = (items: string[], max = 8) =>
  items.length
    ? items.slice(0, max).join(', ') + (items.length > max ? ` (+${items.length - max} more)` : '')
    : 'none'

const pathOf = (url: string) => {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

/** Compact Markdown digest of the baseline for the AI auditor. Every section cites its evidence ref. */
export function buildBaselineSummary(data: BaselineData, stats: BaselineStats): string {
  const r = data.refs
  const lines: string[] = []
  const h = data.home
  lines.push(`# Baseline digest for ${data.url}`)
  lines.push('')
  lines.push('Deterministic scanner output. These are LEADS, not conclusions — verify anything material.')
  lines.push('')
  if (h) {
    lines.push(`## HTTP (${r.http ?? 'no evidence'})`)
    lines.push(
      `- Final URL: ${h.finalUrl} · status ${h.status} · ${h.timingMs} ms · redirects: ${h.redirects.map((x) => `${x.status}→${x.location}`).join(' ') || 'none'}`,
    )
    if (data.httpUpgrade)
      lines.push(
        `- http:// → ${data.httpUpgrade.redirectsToHttps ? 'redirects to https' : `does NOT redirect to https (status ${data.httpUpgrade.status ?? data.httpUpgrade.error})`}`,
      )
    const missing = [
      'strict-transport-security',
      'content-security-policy',
      'x-frame-options',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
    ].filter((k) => !h.headers[k])
    lines.push(`- Security headers missing: ${list(missing)}`)
    if (h.headers.server || h.headers['x-powered-by'])
      lines.push(
        `- Disclosure: server=${h.headers.server ?? '-'} x-powered-by=${h.headers['x-powered-by'] ?? '-'}`,
      )
  }
  if (data.tls) {
    lines.push(`## TLS (${r.tls})`)
    lines.push(
      `- ${data.tls.protocol} · ${data.tls.cipher} · trusted=${data.tls.authorized} · expires in ${data.tls.daysRemaining} days · issuer ${data.tls.issuer}`,
    )
  }
  if (data.robots || data.sitemaps) {
    lines.push(`## Discovery (${r.discovery ?? 'n/a'}, crawl ${r.crawl ?? 'n/a'})`)
    lines.push(
      `- robots.txt: ${data.robots?.found ? `found, ${data.robots.disallow.length} disallow rules${data.robots.disallowAll ? ' (DISALLOWS ALL)' : ''}` : 'not found'}`,
    )
    lines.push(`- Sitemap URLs: ${data.sitemaps?.totalUrls ?? 0}`)
    lines.push(`- Pages discovered: ${stats.pagesDiscovered}; crawled: ${stats.pagesCrawled}`)
  }
  if (data.crawl) {
    lines.push('')
    lines.push('### Crawled pages (status · path · title)')
    for (const p of data.crawl.pages.slice(0, 40)) {
      lines.push(
        `- ${p.status ?? p.error} · ${pathOf(p.finalUrl)} · ${(p.title ?? '(no title)').slice(0, 70)}`,
      )
    }
  }
  if (data.seo) {
    const s = data.seo
    lines.push(`## SEO facts (${r.seo})`)
    lines.push(`- Missing title: ${list(s.missingTitle.map(pathOf))}`)
    lines.push(`- Missing meta description: ${list(s.missingDescription.map(pathOf))}`)
    lines.push(
      `- Missing H1: ${list(s.missingH1.map(pathOf))}; multiple H1: ${list(s.multipleH1.map((m) => `${pathOf(m.url)} (${m.count})`))}`,
    )
    lines.push(
      `- Duplicate titles: ${list(s.duplicateTitles.map((d) => `"${d.value.slice(0, 50)}" ×${d.urls.length}`))}`,
    )
    lines.push(`- Duplicate descriptions: ${s.duplicateDescriptions.length}`)
    lines.push(
      `- noindex: ${list(s.noindex.map(pathOf))}; missing canonical: ${s.missingCanonical.length}; canonical pointing elsewhere: ${s.canonicalToOtherUrl.length}`,
    )
    lines.push(`- Missing viewport meta: ${list(s.missingViewport.map(pathOf))}`)
    lines.push(
      `- Images without alt attribute: ${list(s.imagesMissingAlt.map((i) => `${pathOf(i.url)} (${i.count})`))}`,
    )
    lines.push(`- Structured data types: ${list(s.structuredDataTypes)}`)
  }
  if (data.localization) {
    const l = data.localization
    lines.push(`## Localization (${r.localization})`)
    lines.push(
      `- lang values: ${list(l.languages)}; pages missing lang: ${l.missingLang.length}; hreflang on ${l.hreflangPages} pages; locale prefixes: ${list(l.localePathPrefixes)}`,
    )
    lines.push(
      `- Possible direction mismatches: ${list(l.directionMismatches.map((d) => `${pathOf(d.url)} (lang=${d.lang}, dir=${d.dir}, arabic=${d.arabicCharRatio})`))}`,
    )
    if (l.hreflangIssues.length)
      lines.push(`- hreflang issues: ${list(l.hreflangIssues.map((i) => `${pathOf(i.url)} ${i.kind}: ${i.detail}`), 6)}`)
    if (l.mixedLanguage.length)
      lines.push(`- Mostly Latin-script UI on RTL pages: ${list(l.mixedLanguage.map((m) => `${pathOf(m.url)} ${m.area} (${Math.round(m.latinShare * 100)}% Latin)`), 6)}`)
    if (l.untranslatedMetadata.length)
      lines.push(`- Same ${list(l.untranslatedMetadata.map((u) => `${u.field} on ${u.urls.map(pathOf).join(' & ')}`), 4)} across languages`)
    if (l.missingPairs.length)
      lines.push(`- Locale pages without a counterpart in the crawl sample (verify, the crawl is bounded): ${list(l.missingPairs.map((m) => `/${m.present.join(',')}${m.path} → no /${m.missing}`), 6)}`)
  }
  if (data.lighthouse) {
    const lh = data.lighthouse
    lines.push(`## Lighthouse mobile, start page (${r.lighthouse}) — lab data`)
    lines.push(
      `- Scores: perf ${lh.scores.performance}, a11y ${lh.scores.accessibility}, best-practices ${lh.scores.bestPractices}, SEO ${lh.scores.seo}`,
    )
    lines.push(
      `- FCP ${lh.metrics.fcpMs} ms, LCP ${lh.metrics.lcpMs} ms, TBT ${lh.metrics.tbtMs} ms, CLS ${lh.metrics.cls}, SI ${lh.metrics.speedIndexMs} ms, weight ${lh.totalBytes ? Math.round(lh.totalBytes / 1024) : '?'} KB`,
    )
    lines.push(
      `- Top opportunities: ${list(
        lh.opportunities.map((o) => `${o.title}${o.savingsMs ? ` (~${o.savingsMs} ms)` : ''}`),
        6,
      )}`,
    )
    lines.push(`- Full report JSON: ${lh.jsonPath}`)
  }
  if (data.browser.length) {
    lines.push('## Real-browser inspection (desktop 1440×900 + mobile 390×844)')
    for (const b of data.browser) {
      const d = b.desktop
      const m = b.mobile
      lines.push(`### ${pathOf(b.url)}`)
      if (b.error) lines.push(`- Inspection problems: ${b.error}`)
      lines.push(
        `- Screenshots: desktop ${d?.screenshot ?? '-'}, mobile ${m?.screenshot ?? '-'} (full-page: ${d?.fullPageScreenshot ?? '-'}, ${m?.fullPageScreenshot ?? '-'})`,
      )
      lines.push(
        `- Desktop: ${d?.requestCount ?? '?'} requests, ${d ? Math.round(d.transferBytes / 1024) : '?'} KB, LCP ${d?.timing.lcpMs ?? '?'} ms (unthrottled), CLS ${d?.timing.cls ?? '?'}`,
      )
      const errors = [
        ...(d?.pageErrors ?? []),
        ...(d?.consoleErrors.filter((c) => c.type === 'error').map((c) => c.text) ?? []),
      ]
      lines.push(
        `- Console/JS errors: ${
          errors.length
            ? errors
                .slice(0, 3)
                .map((e) => `"${e.slice(0, 100)}"`)
                .join('; ')
            : 'none'
        }`,
      )
      const failed = d?.failedRequests ?? []
      lines.push(
        `- Failed requests: ${
          failed.length
            ? failed
                .slice(0, 4)
                .map((f) => `${f.status ?? f.failure} ${f.url.slice(0, 90)}`)
                .join('; ')
            : 'none'
        }`,
      )
      lines.push(
        `- Mobile overflow: ${
          m?.overflow
            ? `YES, ${m.overflow.scrollWidth}px in ${m.overflow.viewportWidth}px (${m.overflow.offenders
                .map((o) => o.selector)
                .slice(0, 3)
                .join(', ')})`
            : 'none detected'
        }`,
      )
      if (b.axe)
        lines.push(
          `- axe violations: ${list(
            b.axe.violations.map((v) => `${v.id}[${v.impact}]×${v.nodes}`),
            8,
          )}`,
        )
      if (b.localization)
        lines.push(
          `- lang=${b.localization.lang} dir=${b.localization.dirAttr} computed=${b.localization.computedDirection} arabicRatio=${b.localization.arabicCharRatio} languageLinks=${
            b.localization.languageLinks
              .map((l) => l.text || l.href)
              .slice(0, 4)
              .join(', ') || 'none'
          }`,
        )
      if (b.conversionSurface)
        lines.push(
          `- Conversion surface: ${b.conversionSurface.forms.length} forms, ${b.conversionSurface.whatsappLinks.length} WhatsApp, ${b.conversionSurface.telLinks} tel, ${b.conversionSurface.mailtoLinks} mailto, ${b.conversionSurface.buttons} buttons`,
        )
      lines.push(`- Rendered DOM: ${b.domSnapshot ?? '-'}`)
    }
  }
  lines.push(`## Tracking (${r.tracking ?? 'n/a'})`)
  lines.push(`- Detected on load (tag/pixel present): ${list(data.tracking.map((t) => t.name))}`)
  lines.push(
    `- Events observed on load: ${list(data.trackingEvents.map((e) => `${e.event} (${e.tool})`), 12)} — the baseline performs no interactions, so conversion events (clicks, form submits) were NOT tested.`,
  )
  lines.push(`## Technology hints (${r.technologies ?? 'n/a'})`)
  lines.push(
    `- ${list(
      data.technologies.map((t) => `${t.name} [${t.category}]`),
      15,
    )}`,
  )
  if (data.links) {
    lines.push(`## Links (${r.links})`)
    lines.push(
      `- Checked ${data.links.checked}/${data.links.totalTargets}; broken: ${list(
        data.links.broken.map(
          (b) => `${b.status ?? b.error} ${b.url.slice(0, 80)} (on ${pathOf(b.sources[0] ?? '')})`,
        ),
        10,
      )}`,
    )
    lines.push(`- Inconclusive external (bot protection/timeouts): ${data.links.blocked.length}`)
  }
  const sc = data.scanners
  if (sc.httpx) {
    lines.push(`## httpx fingerprint (${r.httpx ?? 'n/a'})`)
    lines.push(`- ${sc.httpx.statusCode ?? '?'} · server ${sc.httpx.webserver ?? 'n/a'} · CDN ${sc.httpx.cdn ?? 'none'} · technologies: ${list(sc.httpx.technologies, 15)}`)
  }
  if (sc.katana) {
    lines.push(`## Katana discovery (${r.katana ?? 'n/a'})`)
    lines.push(`- ${sc.katana.endpoints} endpoints seen; ${sc.katana.pageUrls.length} confirmed HTML pages; ${data.extraDiscovered} not found by the crawler or sitemaps (see tools/katana.jsonl)${sc.katana.blocked ? `; ${sc.katana.blocked} requests refused (403/429/503) — bot protection likely, discovery incomplete` : ''}`)
  }
  if (sc.pa11y.length) {
    lines.push(`## Pa11y / HTML_CodeSniffer (${r.pa11y ?? 'n/a'})`)
    for (const p of sc.pa11y) lines.push(`- ${pathOf(p.url)}: ${p.errors} errors — ${list(p.byCode.map((c) => `${c.code.split('.').slice(-2).join('.')} ×${c.count}`), 6)}`)
  }
  if (sc.zap) {
    lines.push(`## OWASP ZAP baseline — passive (${r.zap ?? 'n/a'})`)
    lines.push(`- Alerts: ${sc.zap.riskCounts.high} high, ${sc.zap.riskCounts.medium} medium, ${sc.zap.riskCounts.low} low, ${sc.zap.riskCounts.informational} informational`)
    for (const a of sc.zap.alerts.filter((x) => x.risk !== 'informational').slice(0, 12)) lines.push(`- [${a.risk}] ${a.name} (${a.count} instance${a.count === 1 ? '' : 's'})`)
  }
  if (sc.testssl) {
    lines.push(`## testssl.sh (${r.testssl ?? 'n/a'})`)
    lines.push(`- Protocols offered: ${list(sc.testssl.protocols.filter((p) => p.offered).map((p) => p.name))}; not offered: ${list(sc.testssl.protocols.filter((p) => p.offered === false).map((p) => p.name))}`)
    lines.push(`- Certificate: ${sc.testssl.certificate.expirationStatus ?? 'n/a'}; chain of trust: ${sc.testssl.certificate.chainOfTrust ?? 'n/a'}`)
    if (sc.testssl.issues.length) lines.push(`- Flagged: ${list(sc.testssl.issues.map((i) => `[${i.severity}] ${i.id}: ${i.finding.slice(0, 80)}`), 8)}`)
  }
  if (stats.skippedCapabilities.length) {
    lines.push('## Skipped capabilities')
    for (const s of stats.skippedCapabilities) lines.push(`- ${s.capability}: ${s.reason}`)
  }
  return lines.join('\n') + '\n'
}
