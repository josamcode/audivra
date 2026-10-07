import { getConfig } from '@audivra/config'
import type { BaselineStats, EvidenceItem, SystemStatus } from '@audivra/contracts'
import { upsertPages } from '@audivra/database'
import { chromiumExecutable, isToolReady } from '@audivra/tool-runtime'
import type { AuditContext } from '../context.ts'
import { inspectPage, launchBrowser, type BrowserPageReport } from './browser.ts'
import { buildLinkGraph, crawlSite, type CrawlResult } from './crawl.ts'
import { fetchRobots, fetchSitemaps, type RobotsFacts, type SitemapFacts } from './discovery.ts'
import { fetchUrl, getTlsInfo, securityHeaderFacts, type FetchResult, type TlsInfo } from './http.ts'
import { runLighthouse, type LighthouseSummary } from './lighthouse.ts'
import { checkLinks, type LinkCheckSummary } from './links.ts'
import { buildBaselineStats, buildBaselineSummary, type BaselineData } from './report.ts'
import { runHttpx, runKatana, runPa11y, runTestssl, runZapBaseline } from './scanners.ts'
import { analyzeLocalization, analyzeSeo, choosePagesForBrowser } from './seo.ts'
import type { SignalHit, TrackingEvent } from './signals.ts'

/** Optional scanners the baseline may run (each also needs its tool to be ready). */
export const BASELINE_SCANNERS = ['httpx', 'katana', 'pa11y', 'zap', 'testssl'] as const
export type BaselineScanner = (typeof BASELINE_SCANNERS)[number]

export class RequiredCapabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequiredCapabilityError'
  }
}

export interface BaselineOptions {
  url: string
  maxPages: number
  maxLinkChecks: number
  browserPages: number
  tools: SystemStatus
  /** Enabled optional scanners (default: all). Disabled ones are recorded as skipped with the reason. */
  scanners?: readonly string[]
}

export interface BaselineResult {
  stats: BaselineStats
  summaryMarkdown: string
  evidence: EvidenceItem[]
}

const path = (url: string) => {
  try {
    const u = new URL(url)
    return u.pathname + u.search || '/'
  } catch {
    return url
  }
}

/**
 * Deterministic baseline: cheap factual context for the AI auditor. Every module is isolated so an
 * optional failure is recorded and skipped instead of failing the audit. Outputs are leads, not truth.
 */
export async function runBaseline(ctx: AuditContext, options: BaselineOptions): Promise<BaselineResult> {
  const evidence: EvidenceItem[] = []
  const skipped: BaselineStats['skippedCapabilities'] = []
  const add: AddEvidence = async (input) => {
    const item = await ctx.evidence({ ...input, source: 'baseline' })
    evidence.push(item)
    return item
  }
  const data: BaselineData = {
    url: options.url,
    home: null,
    httpUpgrade: null,
    tls: null,
    robots: null,
    sitemaps: null,
    crawl: null,
    seo: null,
    localization: null,
    links: null,
    browser: [],
    lighthouse: null,
    tracking: [],
    trackingEvents: [],
    technologies: [],
    scanners: { zap: null, testssl: null, httpx: null, katana: null, pa11y: [] },
    extraDiscovered: 0,
    refs: {},
  }
  const enabled = new Set(
    options.scanners ??
      getConfig()
        .BASELINE_SCANNERS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
  )
  /** Whether an optional scanner should run; records a skip with the reason when it should not. */
  const scannerReady = async (id: BaselineScanner, purpose: string): Promise<boolean> => {
    if (!enabled.has(id)) {
      await ctx.skippedTool(id, purpose, 'Disabled by configuration (BASELINE_SCANNERS)')
      return false
    }
    const status = options.tools.tools.find((t) => t.id === id)
    if (status?.state !== 'ready') {
      const reason = status?.detail ?? 'not installed'
      skipped.push({ capability: purpose, reason: `${id} unavailable: ${reason}` })
      await ctx.skippedTool(id, purpose, `unavailable: ${reason}`)
      return false
    }
    return true
  }

  await ctx.event('baseline.started', `Baseline inspection of ${options.url}`)

  // 1. Target fetch (required).
  const home = await ctx.toolRun(
    'http',
    'Fetch target, redirects and response headers',
    options.url,
    async () => {
      const result = await fetchUrl(options.url, { signal: ctx.signal })
      await ctx.ws.writeJson('baseline/http-home.json', { ...result, body: undefined })
      if (result.body) await ctx.ws.writeText('baseline/home.html', result.body)
      return {
        result,
        artifacts: ['baseline/http-home.json'],
        summary: { status: result.status, finalUrl: result.finalUrl },
      }
    },
  )
  const homeResult: FetchResult | null = home?.result ?? null
  if (!homeResult || homeResult.status === null) {
    throw new RequiredCapabilityError(`Target could not be reached: ${homeResult?.error ?? 'request failed'}`)
  }
  data.home = homeResult
  const finalUrl = homeResult.finalUrl
  const origin = new URL(finalUrl).origin

  if (finalUrl.startsWith('https:')) {
    const insecure = new URL(finalUrl)
    insecure.protocol = 'http:'
    const upgrade = await fetchUrl(insecure.toString(), {
      signal: ctx.signal,
      readBody: false,
      maxRedirects: 0,
      timeoutMs: 10000,
    })
    data.httpUpgrade = {
      status: upgrade.status,
      location: upgrade.redirects[0]?.location ?? null,
      redirectsToHttps: !!upgrade.redirects[0]?.location?.startsWith('https:'),
      error: upgrade.error,
    }
  }
  const security = securityHeaderFacts(homeResult.headers, homeResult.setCookies)
  data.refs.http = (
    await add({
      type: 'http-header',
      title: `HTTP response for ${path(finalUrl)} (${homeResult.status})`,
      summary: `Status ${homeResult.status} in ${homeResult.timingMs} ms after ${homeResult.redirects.length} redirect(s). Missing security headers: ${security.missing.join(', ') || 'none'}.`,
      url: finalUrl,
      artifactPath: 'baseline/http-home.json',
      metadata: {
        status: homeResult.status,
        finalUrl,
        timingMs: homeResult.timingMs,
        redirects: homeResult.redirects,
        httpToHttps: data.httpUpgrade,
        securityHeadersPresent: security.present,
        securityHeadersMissing: security.missing,
        versionDisclosure: security.disclosure,
        cookies: security.cookies,
        headers: homeResult.headers,
      },
    })
  ).ref

  // 2. TLS, robots and sitemap in parallel.
  const host = new URL(finalUrl).hostname
  const httpxWork = (async () => {
    if (!(await scannerReady('httpx', 'Technology fingerprint (httpx)'))) return
    const run = await ctx.toolRun('httpx', 'Technology fingerprint (Wappalyzer rules)', finalUrl, async () => {
      const { summary, command } = await runHttpx(finalUrl, { auditId: ctx.auditId, signal: ctx.signal })
      await ctx.ws.writeJson('tools/httpx.json', summary)
      return { result: summary, command, artifacts: ['tools/httpx.json'], summary: { technologies: summary.technologies.length } }
    })
    if (!run) return
    data.scanners.httpx = run.result
    data.refs.httpx = (
      await add({
        type: 'tool-result',
        title: `httpx fingerprint: ${run.result.technologies.length ? run.result.technologies.slice(0, 6).join(', ') : 'no technologies matched'}`,
        summary: `Wappalyzer-rule fingerprint of ${run.result.url}: status ${run.result.statusCode ?? 'n/a'}, server ${run.result.webserver ?? 'n/a'}, CDN ${run.result.cdn ?? 'none'}. Technologies: ${run.result.technologies.join(', ') || 'none'}.`,
        url: finalUrl,
        artifactPath: 'tools/httpx.json',
        toolRunId: run.toolRunId,
        metadata: { kind: 'httpx', ...run.result },
      })
    ).ref
  })().catch((error: unknown) => {
    // Handled here because other baseline steps are awaited before this promise is joined.
    if (!ctx.signal.aborted) ctx.log.warn({ err: error }, 'httpx step failed')
  })
  const [tls, discovery] = await Promise.all([
    finalUrl.startsWith('https:')
      ? ctx.toolRun('tls', 'Passive TLS handshake and certificate check', origin, async () => {
          const info = await getTlsInfo(host)
          return { result: info, summary: { protocol: info.protocol, daysRemaining: info.daysRemaining } }
        })
      : Promise.resolve(null),
    ctx.toolRun('robots-sitemap', 'Read robots.txt and sitemaps', origin, async () => {
      const robots = await fetchRobots(origin, ctx.signal)
      const sitemaps = await fetchSitemaps(origin, robots.sitemaps, { signal: ctx.signal })
      await ctx.ws.writeJson('baseline/robots-sitemap.json', { robots, sitemaps })
      return {
        result: { robots, sitemaps },
        artifacts: ['baseline/robots-sitemap.json'],
        summary: { robotsFound: robots.found, sitemapUrls: sitemaps.totalUrls },
      }
    }),
  ])
  if (tls) {
    const info: TlsInfo = tls.result
    data.tls = info
    data.refs.tls = (
      await add({
        type: 'tls-result',
        title: `TLS: ${info.protocol ?? 'unknown protocol'}, certificate ${info.daysRemaining != null ? `expires in ${info.daysRemaining} days` : 'unknown expiry'}`,
        summary: `${info.authorized ? 'Certificate chain trusted' : `Certificate NOT trusted (${info.authorizationError})`}. Issuer: ${info.issuer ?? 'unknown'}. Cipher: ${info.cipher ?? 'unknown'}.`,
        url: origin,
        metadata: { ...info },
      })
    ).ref
  }
  if (discovery) {
    const { robots, sitemaps }: { robots: RobotsFacts; sitemaps: SitemapFacts } = discovery.result
    data.robots = robots
    data.sitemaps = sitemaps
    data.refs.discovery = (
      await add({
        type: 'tool-result',
        title: `robots.txt ${robots.found ? 'found' : 'missing'} · sitemap ${sitemaps.totalUrls ? `${sitemaps.totalUrls} URLs` : 'not found'}`,
        summary: `robots.txt ${robots.found ? `found (${robots.disallow.length} disallow rules${robots.disallowAll ? ', disallows everything' : ''})` : `not found (status ${robots.status})`}. Sitemaps checked: ${sitemaps.checked.map((c) => `${path(c.url)} → ${c.kind}`).join(', ') || 'none'}.`,
        url: robots.url,
        artifactPath: 'baseline/robots-sitemap.json',
        metadata: {
          robotsFound: robots.found,
          robotsStatus: robots.status,
          disallow: robots.disallow.slice(0, 30),
          disallowAll: robots.disallowAll,
          sitemapsDeclared: robots.sitemaps,
          sitemapsChecked: sitemaps.checked,
          sitemapUrlCount: sitemaps.totalUrls,
        },
      })
    ).ref
  }

  // 3. Crawl.
  const crawl = await ctx.toolRun('crawler', `Crawl up to ${options.maxPages} pages`, finalUrl, async () => {
    const result = await crawlSite({
      startUrl: finalUrl,
      sitemapUrls: data.sitemaps?.urls ?? [],
      maxPages: options.maxPages,
      signal: ctx.signal,
    })
    await ctx.ws.writeJson('baseline/crawl.json', result.pages)
    return {
      result,
      artifacts: ['baseline/crawl.json'],
      summary: { pages: result.pages.length, discovered: result.discoveredUrls },
    }
  })
  ctx.throwIfCancelled()
  if (crawl) {
    const result: CrawlResult = crawl.result
    data.crawl = result
    await ctx.ws.writeJson('baseline/link-graph.json', buildLinkGraph(result))
    await upsertPages(
      ctx.db,
      ctx.auditId,
      result.pages.map((p) => ({
        url: p.finalUrl,
        status: p.status,
        title: p.title,
        depth: p.depth,
        source: p.source,
        data: { description: p.description, h1: p.h1, lang: p.lang, dir: p.dir, wordCount: p.wordCount },
      })),
    )
    const seo = analyzeSeo(result.pages)
    const localization = analyzeLocalization(result.pages)
    data.seo = seo
    data.localization = localization
    await ctx.ws.writeJson('baseline/seo.json', seo)
    await ctx.ws.writeJson('baseline/localization.json', localization)
    data.refs.crawl = (
      await add({
        type: 'tool-result',
        title: `Crawl: ${result.pages.length} pages fetched, ${result.discoveredUrls} URLs discovered`,
        summary: `Fetched ${result.pages.length} same-site pages (${seo.non200.length} non-200). Sampled sitemap sections plus internal links.`,
        url: finalUrl,
        artifactPath: 'baseline/crawl.json',
        metadata: {
          pagesFetched: result.pages.length,
          urlsDiscovered: result.discoveredUrls,
          pages: result.pages.map((p) => ({
            url: p.finalUrl,
            status: p.status,
            title: p.title,
            depth: p.depth,
            ms: p.timingMs,
          })),
        },
      })
    ).ref
    data.refs.seo = (
      await add({
        type: 'dom-observation',
        title: `SEO metadata inventory across ${seo.pagesAnalyzed} pages`,
        summary: [
          `missing title: ${seo.missingTitle.length}`,
          `missing description: ${seo.missingDescription.length}`,
          `missing H1: ${seo.missingH1.length}`,
          `multiple H1: ${seo.multipleH1.length}`,
          `duplicate titles: ${seo.duplicateTitles.length}`,
          `duplicate descriptions: ${seo.duplicateDescriptions.length}`,
          `noindex: ${seo.noindex.length}`,
          `missing canonical: ${seo.missingCanonical.length}`,
          `images missing alt on ${seo.imagesMissingAlt.length} pages`,
        ].join(' · '),
        url: finalUrl,
        artifactPath: 'baseline/seo.json',
        metadata: { ...seo },
      })
    ).ref
    data.refs.localization = (
      await add({
        type: 'dom-observation',
        title: `Language & direction signals: ${localization.languages.join(', ') || 'no lang attribute'}`,
        summary: [
          `${localization.languages.length} language value(s); hreflang on ${localization.hreflangPages} page(s); ${localization.directionMismatches.length} possible direction mismatch(es); locale path prefixes: ${localization.localePathPrefixes.join(', ') || 'none'}.`,
          localization.hreflangIssues.length ? `hreflang issues: ${localization.hreflangIssues.length} (${[...new Set(localization.hreflangIssues.map((i) => i.kind))].join(', ')}).` : '',
          localization.mixedLanguage.length ? `Mostly Latin-script ${[...new Set(localization.mixedLanguage.map((m) => m.area))].join(' and ')} on ${new Set(localization.mixedLanguage.map((m) => m.url)).size} RTL page(s).` : '',
          localization.untranslatedMetadata.length ? `${localization.untranslatedMetadata.length} title/description value(s) shared across languages.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        url: finalUrl,
        artifactPath: 'baseline/localization.json',
        metadata: { kind: 'localization', ...localization, pages: localization.pages.slice(0, 40) },
      })
    ).ref
  }

  // 4. Lighthouse on the start page (run alone so other work does not skew the measurement).
  if (isToolReady(options.tools, 'lighthouse')) {
    const lh = await ctx.toolRun('lighthouse', 'Lighthouse (mobile) on start page', finalUrl, async () => {
      const { summary, command } = await runLighthouse(finalUrl, ctx.ws, {
        name: 'home-mobile',
        formFactor: 'mobile',
        signal: ctx.signal,
      })
      return {
        result: summary,
        command,
        artifacts: [summary.jsonPath, ...(summary.htmlPath ? [summary.htmlPath] : [])],
        summary: { scores: summary.scores },
      }
    })
    if (lh) {
      const s: LighthouseSummary = lh.result
      data.lighthouse = s
      data.refs.lighthouse = (
        await add({
          type: 'metric',
          title: `Lighthouse mobile: performance ${s.scores.performance ?? '–'}, LCP ${s.metrics.lcpMs != null ? `${(s.metrics.lcpMs / 1000).toFixed(1)} s` : '–'}`,
          summary: `Performance ${s.scores.performance}, Accessibility ${s.scores.accessibility}, Best practices ${s.scores.bestPractices}, SEO ${s.scores.seo}. FCP ${s.metrics.fcpMs} ms, LCP ${s.metrics.lcpMs} ms, TBT ${s.metrics.tbtMs} ms, CLS ${s.metrics.cls}, page weight ${s.totalBytes ? Math.round(s.totalBytes / 1024) : '–'} KB. Lab data under simulated mobile throttling.`,
          url: finalUrl,
          artifactPath: s.htmlPath ?? s.jsonPath,
          toolRunId: lh.toolRunId,
          metadata: { ...s, reportJson: s.jsonPath },
        })
      ).ref
    } else {
      skipped.push({ capability: 'Lighthouse performance', reason: 'Lighthouse run failed (see tool runs)' })
    }
  } else {
    skipped.push({ capability: 'Lighthouse performance', reason: 'Lighthouse unavailable' })
    await ctx.skippedTool('lighthouse', 'Lighthouse (mobile) on start page', 'tool unavailable')
  }

  // 5. Real-browser inspection and link checking in parallel.
  const browserPages = choosePagesForBrowser(data.crawl?.pages ?? [], finalUrl, options.browserPages)
  if (!isToolReady(options.tools, 'axe-core')) {
    skipped.push({ capability: 'Automated accessibility checks (axe-core)', reason: 'axe-core unavailable' })
  }
  const executable = chromiumExecutable()
  const browserWork = (async () => {
    if (!executable) {
      skipped.push({
        capability: 'Browser inspection',
        reason: 'Chromium not installed (run pnpm run setup)',
      })
      await ctx.skippedTool('playwright', 'Browser inspection', 'Chromium not installed')
      return
    }
    const browser = await launchBrowser(executable)
    try {
      for (const url of browserPages) {
        ctx.throwIfCancelled()
        const run = await ctx.toolRun(
          'playwright',
          `Inspect ${path(url)} at desktop and mobile`,
          url,
          async () => {
            const report = await inspectPage(browser, url, ctx.ws, {
              runAxe: isToolReady(options.tools, 'axe-core'),
              responseHeaders: url === finalUrl ? homeResult.headers : {},
            })
            await ctx.ws.writeJson(`browser/${report.slug}/report.json`, report)
            if (!report.desktop && !report.mobile)
              throw new Error(report.error ?? 'Browser inspection failed')
            return { result: report, artifacts: [`browser/${report.slug}/report.json`] }
          },
        )
        if (run) {
          data.browser.push(run.result)
          await recordBrowserEvidence(ctx, run.result, run.toolRunId, add)
        }
      }
    } finally {
      await browser.close().catch(() => undefined)
    }
    // Second accessibility engine (HTML_CodeSniffer) on the start page and one more key page, after the
    // browser inspection so it does not compete with the timing measurements.
    if (data.browser.length && (await scannerReady('pa11y', 'Accessibility checks (Pa11y / HTML_CodeSniffer)'))) {
      for (const [index, url] of browserPages.slice(0, 2).entries()) {
        const run = await ctx.toolRun('pa11y', `Pa11y (WCAG 2 AA, HTML_CodeSniffer) on ${path(url)}`, url, async () => {
          const { summary, command } = await runPa11y(ctx.ws, url, { auditId: ctx.auditId, signal: ctx.signal, name: index === 0 ? 'start' : `page-${index}` })
          return { result: summary, command, artifacts: [summary.reportJson], summary: { errors: summary.errors } }
        })
        if (!run) continue
        const s = run.result
        data.scanners.pa11y.push(s)
        const ref = (
          await add({
            type: 'tool-result',
            title: `Pa11y (HTML_CodeSniffer): ${s.errors} WCAG 2 AA error${s.errors === 1 ? '' : 's'} on ${path(url)}`,
            summary: s.errors
              ? s.byCode
                  .slice(0, 6)
                  .map((c) => `${c.code.split('.').slice(-2).join('.')} ×${c.count}: ${c.message.slice(0, 90)}`)
                  .join(' | ')
              : 'No WCAG 2 AA errors reported by HTML_CodeSniffer (automated checks cover only part of WCAG).',
            url,
            artifactPath: s.reportJson,
            toolRunId: run.toolRunId,
            metadata: { kind: 'pa11y', errors: s.errors, warnings: s.warnings, byCode: s.byCode, issues: s.issues.slice(0, 30) },
          })
        ).ref
        data.refs.pa11y ??= ref
      }
    }
  })()
  // Passive security scan (spider + passive rules, forms never submitted). Runs alongside the browser work.
  const zapWork = (async () => {
    if (!(await scannerReady('zap', 'Passive security scan (OWASP ZAP baseline)'))) return
    const run = await ctx.toolRun('zap', 'OWASP ZAP baseline: 1-minute spider + passive rules (no active scan)', finalUrl, async () => {
      const { summary, command } = await runZapBaseline(ctx.ws, finalUrl, { auditId: ctx.auditId, signal: ctx.signal })
      return { result: summary, command, artifacts: [summary.reportJson, ...(summary.reportHtml ? [summary.reportHtml] : [])], summary: { ...summary.riskCounts } }
    })
    if (!run) return
    const z = run.result
    data.scanners.zap = z
    const notable = z.alerts.filter((a) => a.risk !== 'informational')
    data.refs.zap = (
      await add({
        type: 'tool-result',
        title: `ZAP baseline (passive): ${z.riskCounts.high} high, ${z.riskCounts.medium} medium, ${z.riskCounts.low} low alert types`,
        summary: notable.length
          ? notable
              .slice(0, 8)
              .map((a) => `[${a.risk}] ${a.name} (${a.count})`)
              .join(' | ')
          : 'No low-or-higher passive alerts. Passive rules only: no active scanning or attack payloads were used.',
        url: finalUrl,
        artifactPath: z.reportHtml ?? z.reportJson,
        toolRunId: run.toolRunId,
        metadata: { kind: 'zap', riskCounts: z.riskCounts, alerts: z.alerts.slice(0, 40), reportJson: z.reportJson },
      })
    ).ref
  })()
  // Deep TLS inspection for HTTPS targets: protocols, certificate, cipher preference (no vulnerability probes).
  const testsslWork = (async () => {
    if (!finalUrl.startsWith('https:')) return
    if (!(await scannerReady('testssl', 'Deep TLS inspection (testssl.sh)'))) return
    const target = new URL(finalUrl)
    const run = await ctx.toolRun('testssl', 'testssl.sh: protocols, certificate and cipher preference', origin, async () => {
      const { summary, command } = await runTestssl(ctx.ws, target.hostname, { auditId: ctx.auditId, signal: ctx.signal, port: target.port ? Number(target.port) : 443 })
      return { result: summary, command, artifacts: [summary.reportJson], summary: { issues: summary.issues.length } }
    })
    if (!run) return
    const t = run.result
    data.scanners.testssl = t
    const offered = t.protocols.filter((p) => p.offered).map((p) => p.name)
    data.refs.testssl = (
      await add({
        type: 'tls-result',
        title: `testssl.sh: ${offered.join(', ') || 'no protocols detected'} offered; ${t.issues.length} flagged item${t.issues.length === 1 ? '' : 's'}`,
        summary: [
          `Protocols offered: ${offered.join(', ') || 'none'}.`,
          `Certificate: ${t.certificate.expirationStatus ?? 'n/a'} (valid until ${t.certificate.notAfter ?? 'n/a'}); chain of trust: ${t.certificate.chainOfTrust ?? 'n/a'}.`,
          t.negotiated.protocol ? `Negotiated ${t.negotiated.protocol} / ${t.negotiated.cipher ?? 'n/a'}.` : '',
          t.issues.length ? `Flagged: ${t.issues.slice(0, 5).map((i) => `[${i.severity}] ${i.id}: ${i.finding.slice(0, 80)}`).join(' | ')}` : 'No LOW-or-higher items flagged.',
        ]
          .filter(Boolean)
          .join(' '),
        url: origin,
        artifactPath: t.reportJson,
        toolRunId: run.toolRunId,
        metadata: { kind: 'testssl', protocols: t.protocols, certificate: t.certificate, negotiated: t.negotiated, issues: t.issues, severityCounts: t.severityCounts },
      })
    ).ref
  })()
  // Extra discovery (JavaScript-referenced URLs) beyond the crawler; bounded and rate-limited.
  const katanaWork = (async () => {
    if (!(await scannerReady('katana', 'Extra URL discovery (Katana)'))) return
    const run = await ctx.toolRun('katana', 'Katana discovery (depth 2, JS parsing, 45 s, 2 req/s)', finalUrl, async () => {
      const { summary, command } = await runKatana(ctx.ws, finalUrl, { auditId: ctx.auditId, signal: ctx.signal })
      return { result: summary, command, artifacts: [summary.outputFile], summary: { endpoints: summary.endpoints, pages: summary.pageUrls.length, blocked: summary.blocked } }
    })
    if (!run) return
    const k = run.result
    data.scanners.katana = k
    const known = new Set([
      ...(data.crawl?.pages.map((p) => p.finalUrl) ?? []),
      ...(data.crawl ? [...data.crawl.linkSources.keys()] : []),
      ...(data.sitemaps?.urls ?? []),
    ])
    const fresh = k.pageUrls.filter((u) => !known.has(u))
    data.extraDiscovered = fresh.length
    if (fresh.length) {
      await upsertPages(
        ctx.db,
        ctx.auditId,
        fresh.slice(0, 100).map((url) => ({ url, status: null, title: null, depth: 2, source: 'katana' })),
      )
    }
    data.refs.katana = (
      await add({
        type: 'tool-result',
        title: `Katana: ${k.pageUrls.length} HTML page${k.pageUrls.length === 1 ? '' : 's'} confirmed (${fresh.length} not found by the crawler)${k.blocked ? `; ${k.blocked} request(s) blocked` : ''}`,
        summary: `${k.endpoints} endpoints seen while crawling to depth 2 with JavaScript parsing; only 2xx HTML responses count as pages. New page URLs: ${fresh.slice(0, 8).map(path).join(', ') || 'none'}.${k.blocked ? ` ${k.blocked} request(s) were refused (403/429/503), likely bot protection — discovery is incomplete.` : ''}`,
        url: finalUrl,
        artifactPath: k.outputFile,
        toolRunId: run.toolRunId,
        metadata: { kind: 'katana', endpoints: k.endpoints, blocked: k.blocked, pageUrls: k.pageUrls.slice(0, 60), newUrls: fresh.slice(0, 60) },
      })
    ).ref
  })()
  const linkWork = (async () => {
    if (!data.crawl) return
    const linkRun = await ctx.toolRun(
      'link-checker',
      `Check up to ${options.maxLinkChecks} links and resources`,
      finalUrl,
      async () => {
        const summary = await checkLinks(data.crawl!.linkSources, origin, {
          maxChecks: options.maxLinkChecks,
          signal: ctx.signal,
        })
        await ctx.ws.writeJson('baseline/links.json', summary)
        return {
          result: summary,
          artifacts: ['baseline/links.json'],
          summary: { checked: summary.checked, broken: summary.broken.length },
        }
      },
    )
    if (linkRun) {
      const s: LinkCheckSummary = linkRun.result
      data.links = s
      const internalBroken = s.broken.filter((b) => b.internal)
      data.refs.links = (
        await add({
          type: s.broken.length ? 'network-failure' : 'tool-result',
          title: s.broken.length
            ? `${s.broken.length} broken link/resource target(s) (${internalBroken.length} internal)`
            : `No broken links among ${s.checked} checked targets`,
          summary: `Checked ${s.checked} of ${s.totalTargets} unique link/resource targets. Broken: ${s.broken.length}. Inconclusive (blocked/timeouts, external): ${s.blocked.length}.`,
          url: finalUrl,
          artifactPath: 'baseline/links.json',
          toolRunId: linkRun.toolRunId,
          metadata: {
            checked: s.checked,
            totalTargets: s.totalTargets,
            broken: s.broken
              .slice(0, 40)
              .map((b) => ({
                url: b.url,
                status: b.status,
                error: b.error,
                kind: b.kind,
                internal: b.internal,
                foundOn: b.sources.slice(0, 3),
              })),
            inconclusive: s.blocked
              .slice(0, 20)
              .map((b) => ({ url: b.url, status: b.status, error: b.error })),
          },
        })
      ).ref
    }
  })()
  const settled = await Promise.allSettled([browserWork, linkWork, zapWork, testsslWork, katanaWork, httpxWork])
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      if (ctx.signal.aborted) ctx.throwIfCancelled()
      ctx.log.warn({ err: outcome.reason }, 'baseline module failed')
    }
  }
  ctx.throwIfCancelled()

  // 6. Aggregated tracking / technology / conversion-surface evidence.
  await recordAggregates(ctx, data, add)

  const stats = buildBaselineStats(data, skipped)
  const summaryMarkdown = buildBaselineSummary(data, stats)
  await ctx.ws.writeText('baseline/summary.md', summaryMarkdown)
  await ctx.ws.writeJson('baseline/summary.json', { stats, refs: data.refs, browserPages })
  await ctx.event(
    'baseline.completed',
    `Baseline completed: ${stats.pagesCrawled} pages crawled, ${stats.pagesInspectedInBrowser} inspected in browser, ${evidence.length} evidence items`,
    {
      evidence: evidence.length,
    },
  )
  return { stats, summaryMarkdown, evidence }
}

type AddEvidence = (input: Omit<Parameters<AuditContext['evidence']>[0], 'source'>) => Promise<EvidenceItem>

async function recordBrowserEvidence(
  ctx: AuditContext,
  report: BrowserPageReport,
  toolRunId: string,
  add: AddEvidence,
) {
  const p = path(report.url)
  const refs: Record<string, string> = {}
  for (const view of [report.desktop, report.mobile]) {
    if (!view?.screenshot) continue
    refs[`${view.viewport}Screenshot`] = (
      await add({
        type: 'screenshot',
        title: `${view.viewport === 'desktop' ? 'Desktop 1440×900' : 'Mobile 390×844'} · ${p}`,
        summary: `Above-the-fold ${view.viewport} screenshot of ${view.finalUrl} ("${view.title.slice(0, 80)}"). Full-page capture: ${view.fullPageScreenshot ?? 'unavailable'}.`,
        url: view.finalUrl,
        artifactPath: view.screenshot,
        toolRunId,
        metadata: {
          viewport: `${view.width}x${view.height}`,
          fullPage: view.fullPageScreenshot,
          status: view.status,
        },
      })
    ).ref
  }
  const consoleErrors = [
    ...(report.desktop?.consoleErrors ?? []),
    ...(report.mobile?.consoleErrors ?? []),
  ].filter((c) => c.type === 'error')
  const pageErrors = [
    ...new Set([...(report.desktop?.pageErrors ?? []), ...(report.mobile?.pageErrors ?? [])]),
  ]
  if (consoleErrors.length || pageErrors.length) {
    const unique = [...new Map(consoleErrors.map((c) => [c.text, c])).values()]
    await add({
      type: 'console-error',
      title: `${unique.length + pageErrors.length} console/JS error(s) on ${p}`,
      summary: [...pageErrors.map((e) => `Uncaught: ${e}`), ...unique.map((c) => c.text)]
        .slice(0, 3)
        .join(' | ')
        .slice(0, 600),
      url: report.url,
      toolRunId,
      metadata: { uncaughtExceptions: pageErrors, consoleErrors: unique.slice(0, 30) },
    })
  }
  const failed = [...(report.desktop?.failedRequests ?? []), ...(report.mobile?.failedRequests ?? [])]
  if (failed.length) {
    const unique = [...new Map(failed.map((f) => [`${f.url}|${f.status}`, f])).values()]
    await add({
      type: 'network-failure',
      title: `${unique.length} failed network request(s) on ${p}`,
      summary: unique
        .slice(0, 4)
        .map((f) => `${f.status ?? f.failure} ${f.resourceType} ${f.url.slice(0, 120)}`)
        .join(' | '),
      url: report.url,
      toolRunId,
      metadata: { requests: unique.slice(0, 40) },
    })
  }
  if (report.mobile?.overflow) {
    const o = report.mobile.overflow
    await add({
      type: 'dom-observation',
      title: `Horizontal overflow on mobile: ${p} is ${o.scrollWidth}px wide in a ${o.viewportWidth}px viewport`,
      summary: `Page content extends beyond the mobile viewport. Widest offending elements: ${
        o.offenders
          .map((x) => `${x.selector} (right edge ${x.right}px)`)
          .slice(0, 4)
          .join(', ') || 'not identified'
      }.`,
      url: report.url,
      artifactPath: report.mobile.fullPageScreenshot ?? report.mobile.screenshot,
      toolRunId,
      metadata: { ...o },
    })
  }
  if (report.axe) {
    const v = report.axe.violations
    await add({
      type: 'tool-result',
      title: `axe-core: ${v.length} accessibility rule violation(s) on ${p}`,
      summary: v.length
        ? v
            .slice(0, 6)
            .map((x) => `${x.id} (${x.impact ?? 'n/a'}, ${x.nodes} node${x.nodes === 1 ? '' : 's'})`)
            .join(', ')
        : 'No automated WCAG violations detected (automated checks cover only part of WCAG).',
      url: report.url,
      artifactPath: report.axe.artifact,
      toolRunId,
      metadata: { violations: v, passes: report.axe.passes, incomplete: report.axe.incomplete },
    })
  }
  for (const view of [report.desktop, report.mobile]) {
    if (!view) continue
    await add({
      type: 'metric',
      title: `Browser load metrics (${view.viewport}) · ${p}`,
      summary: `TTFB ${view.timing.ttfbMs ?? '–'} ms, DOMContentLoaded ${view.timing.domContentLoadedMs ?? '–'} ms, load ${view.timing.loadMs ?? '–'} ms, LCP ${view.timing.lcpMs ?? '–'} ms, CLS ${view.timing.cls ?? '–'}; ${view.requestCount} requests, ${Math.round(view.transferBytes / 1024)} KB transferred, ${view.thirdPartyHosts.length} third-party hosts. Unthrottled local measurement.`,
      url: view.finalUrl,
      toolRunId,
      metadata: {
        timing: view.timing,
        requests: view.requestCount,
        transferKB: Math.round(view.transferBytes / 1024),
        bytesByType: view.bytesByType,
        heavyResources: view.heavyResources,
        thirdPartyHosts: view.thirdPartyHosts,
        mixedContent: view.mixedContent,
      },
    })
  }
  return refs
}

async function recordAggregates(ctx: AuditContext, data: BaselineData, add: AddEvidence) {
  const tracking = new Map<string, SignalHit & { pages: string[] }>()
  const ids = new Set<string>()
  const events = new Set<string>()
  for (const page of data.browser) {
    for (const hit of page.tracking) {
      const entry = tracking.get(hit.name) ?? { ...hit, pages: [] }
      entry.pages.push(path(page.url))
      tracking.set(hit.name, entry)
    }
    page.trackingIds.forEach((id) => ids.add(id))
    page.dataLayerEvents.forEach((e) => events.add(e))
  }
  data.tracking = [...tracking.values()]
  const sent = new Map<string, TrackingEvent>()
  for (const page of data.browser) for (const e of page.trackingEvents ?? []) sent.set(`${e.tool}|${e.event}`, e)
  data.trackingEvents = [...sent.values()]
  if (data.browser.length) {
    data.refs.tracking = (
      await add({
        type: 'network-request',
        title: data.tracking.length
          ? `Tracking detected: ${data.tracking.map((t) => t.name).join(', ')}`
          : `No analytics or ad tracking detected on ${data.browser.length} inspected page(s)`,
        summary: data.tracking.length
          ? `Tags present (network requests/globals on page load). IDs: ${[...ids].join(', ') || 'none extracted'}. Events sent on load: ${data.trackingEvents.map((e) => `${e.event} (${e.tool})`).join(', ') || 'none'}. dataLayer events: ${[...events].join(', ') || 'none'}. No interactions were performed, so conversion events (clicks, form submits) were not tested.`
          : 'No requests to known analytics, tag manager, pixel or session-recording endpoints were observed during page load, and no known tracking globals were present. Consent-gated tags would not load without consent.',
        url: data.home?.finalUrl ?? data.url,
        metadata: {
          kind: 'tracking',
          detected: data.tracking,
          ids: [...ids],
          eventsSent: data.trackingEvents,
          dataLayerEvents: [...events],
          conversionEventsTested: false,
          pagesInspected: data.browser.map((b) => b.url),
        },
      })
    ).ref
  }

  const tech = new Map<string, SignalHit>()
  for (const page of data.browser)
    for (const hit of page.technologies) if (!tech.has(hit.name)) tech.set(hit.name, hit)
  // httpx (Wappalyzer rules) adds fingerprints the in-browser signatures may miss; names are merged.
  const known = new Set([...tech.keys()].map((n) => n.toLowerCase()))
  for (const name of data.scanners.httpx?.technologies ?? []) {
    const bare = name.split(':')[0]!.trim()
    if (!bare || known.has(bare.toLowerCase())) continue
    known.add(bare.toLowerCase())
    tech.set(bare, { name: bare, category: 'Fingerprint (httpx)', matched: name })
  }
  data.technologies = [...tech.values()]
  if (data.technologies.length) {
    data.refs.technologies = (
      await add({
        type: 'tool-result',
        title: `Technology hints: ${data.technologies
          .map((t) => t.name)
          .slice(0, 8)
          .join(', ')}`,
        summary: `Signature-based hints from headers, resource URLs, markup and JS globals${data.scanners.httpx ? ', merged with httpx (Wappalyzer rules) fingerprints' : ''}. Unverified leads.`,
        url: data.home?.finalUrl ?? data.url,
        metadata: { kind: 'technology', hints: data.technologies },
      })
    ).ref
  }

  const surface = data.browser
    .filter((b) => b.conversionSurface)
    .map((b) => ({ url: path(b.url), ...b.conversionSurface! }))
  if (surface.length) {
    data.refs.conversion = (
      await add({
        type: 'dom-observation',
        title: `Contact/conversion elements inventory across ${surface.length} page(s)`,
        summary: surface
          .map(
            (s) =>
              `${s.url}: ${s.forms.length} form(s), ${s.whatsappLinks.length} WhatsApp link(s), ${s.telLinks} tel:, ${s.mailtoLinks} mailto:`,
          )
          .join(' | ')
          .slice(0, 800),
        url: data.home?.finalUrl ?? data.url,
        metadata: { pages: surface },
      })
    ).ref
  }
}

export type { BaselineData }
