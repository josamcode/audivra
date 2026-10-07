/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { AxeBuilder } from '@axe-core/playwright'
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright'
import type { Workspace } from '../workspace.ts'
import { urlSlug } from '../workspace.ts'
import { detectTechnologies, detectTracking, extractTrackingIds, type SignalHit } from './signals.ts'

export interface ConsoleEntry {
  type: string
  text: string
  location: string | null
}

export interface RequestFailure {
  url: string
  method: string
  resourceType: string
  status: number | null
  failure: string | null
}

export interface OverflowFacts {
  viewportWidth: number
  scrollWidth: number
  offenders: { selector: string; right: number; width: number }[]
}

export interface ViewportReport {
  viewport: 'desktop' | 'mobile'
  width: number
  height: number
  status: number | null
  finalUrl: string
  title: string
  screenshot: string | null
  fullPageScreenshot: string | null
  consoleErrors: ConsoleEntry[]
  pageErrors: string[]
  failedRequests: RequestFailure[]
  requestCount: number
  transferBytes: number
  bytesByType: Record<string, { count: number; bytes: number }>
  heavyResources: { url: string; bytes: number; type: string }[]
  thirdPartyHosts: string[]
  timing: {
    ttfbMs: number | null
    domContentLoadedMs: number | null
    loadMs: number | null
    lcpMs: number | null
    cls: number | null
  }
  overflow: OverflowFacts | null
  mixedContent: string[]
}

export interface AxeViolation {
  id: string
  impact: string | null
  help: string
  helpUrl: string
  nodes: number
  targets: string[]
  sampleHtml: string | null
}

export interface BrowserPageReport {
  url: string
  slug: string
  desktop: ViewportReport | null
  mobile: ViewportReport | null
  error: string | null
  tracking: SignalHit[]
  trackingIds: string[]
  dataLayerEvents: string[]
  technologies: SignalHit[]
  localization: {
    lang: string | null
    dirAttr: string | null
    computedDirection: string | null
    arabicCharRatio: number
    languageLinks: { text: string; href: string; hreflang: string | null }[]
  } | null
  conversionSurface: {
    whatsappLinks: string[]
    telLinks: number
    mailtoLinks: number
    forms: { action: string | null; method: string | null; fields: number; hasSubmit: boolean }[]
    buttons: number
  } | null
  axe: { violations: AxeViolation[]; passes: number; incomplete: number; artifact: string | null } | null
  domSnapshot: string | null
}

const PERF_INIT_SCRIPT = `
window.__audivra = { lcp: null, cls: 0 };
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__audivra.lcp = e.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__audivra.cls += e.value; })
    .observe({ type: 'layout-shift', buffered: true });
} catch {}
`

/**
 * Runs in the page. Kept as a plain string: the dev runtime (tsx/esbuild keepNames) would otherwise
 * inject a `__name` helper into named functions, which does not exist inside the browser.
 */
const OVERFLOW_SCRIPT = `(() => {
  const vw = document.documentElement.clientWidth;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  if (scrollWidth <= vw + 1) return null;
  const offenders = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.right <= vw + 1) continue;
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.visibility === 'hidden') continue;
    const parent = el.parentElement;
    if (parent && parent !== document.body && parent.getBoundingClientRect().right > vw + 1) continue;
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    offenders.push({ selector: el.tagName.toLowerCase() + id + cls, right: Math.round(rect.right), width: Math.round(rect.width) });
    if (offenders.length >= 8) break;
  }
  return { viewportWidth: vw, scrollWidth, offenders };
})()`

const TRACKING_GLOBAL_NAMES = [
  'dataLayer',
  'gtag',
  'fbq',
  'ttq',
  'clarity',
  'hj',
  'snaptr',
  '_linkedin_partner_id',
  'jQuery',
  '___gatsby',
  '__VUE__',
  '__NEXT_DATA__',
  '__NUXT__',
  'Shopify',
  'wp',
]

export async function launchBrowser(executablePath?: string | null): Promise<Browser> {
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  await page.waitForTimeout(800)
}

async function captureScreenshots(
  page: Page,
  ws: Workspace,
  base: string,
): Promise<{ screenshot: string | null; fullPageScreenshot: string | null }> {
  const screenshot = `${base}.png`
  const fullPageScreenshot = `${base}-full.jpg`
  let viewportShot: string | null = null
  let fullShot: string | null = null
  try {
    await page.screenshot({ path: ws.abs(screenshot), timeout: 20000 })
    viewportShot = screenshot
  } catch {
    // leave null; reported via missing artifact
  }
  try {
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    const width = page.viewportSize()?.width ?? 1440
    await page.screenshot({
      path: ws.abs(fullPageScreenshot),
      fullPage: true,
      type: 'jpeg',
      quality: 70,
      timeout: 30000,
      ...(height > 9000 ? { clip: { x: 0, y: 0, width, height: 9000 } } : {}),
    })
    fullShot = fullPageScreenshot
  } catch {
    // very long or unstable pages can fail full-page capture
  }
  return { screenshot: viewportShot, fullPageScreenshot: fullShot }
}

async function inspectViewport(
  context: BrowserContext,
  url: string,
  viewport: 'desktop' | 'mobile',
  ws: Workspace,
  slug: string,
  collect: { requestUrls: Set<string>; globals: Set<string> },
): Promise<{ report: ViewportReport; page: Page }> {
  const page = await context.newPage()
  const consoleErrors: ConsoleEntry[] = []
  const pageErrors: string[] = []
  const failedRequests: RequestFailure[] = []
  const sizes: { url: string; type: string; bytes: number }[] = []
  const pending: Promise<void>[] = []
  const pageOrigin = new URL(url).origin

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const loc = msg.location()
      consoleErrors.push({
        type: msg.type(),
        text: msg.text().slice(0, 500),
        location: loc.url ? `${loc.url}:${loc.lineNumber}` : null,
      })
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 500)))
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? null
    if (failure === 'net::ERR_ABORTED' && request.resourceType() === 'media') return
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: null,
      failure,
    })
  })
  page.on('response', (response) => {
    const request = response.request()
    collect.requestUrls.add(request.url())
    if (response.status() >= 400) {
      failedRequests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
        failure: null,
      })
    }
  })
  page.on('requestfinished', (request) => {
    pending.push(
      request
        .sizes()
        .then((s) => {
          sizes.push({
            url: request.url(),
            type: request.resourceType(),
            bytes: s.responseBodySize + s.responseHeadersSize,
          })
        })
        .catch(() => undefined),
    )
  })

  const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 })
  const status = response?.status() ?? null
  await settle(page)
  if (viewport === 'mobile') {
    // Trigger lazy content, then return to top for the viewport screenshot.
    await page.evaluate(async () => {
      for (let y = 0; y < Math.min(document.body.scrollHeight, 6000); y += 700) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 120))
      }
      window.scrollTo(0, 0)
    })
    await page.waitForTimeout(400)
  }

  const metrics = await page.evaluate((globalNames) => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const w = window as unknown as Record<string, unknown> & {
      __audivra?: { lcp: number | null; cls: number }
    }
    const present = globalNames.filter((name) => typeof w[name] !== 'undefined')
    if (document.querySelector('[data-reactroot], #__next, #root')) present.push('__REACT')
    return {
      title: document.title,
      ttfbMs: nav ? Math.round(nav.responseStart) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav ? Math.round(nav.loadEventEnd) : null,
      lcpMs: w.__audivra?.lcp != null ? Math.round(w.__audivra.lcp) : null,
      cls: w.__audivra ? Math.round(w.__audivra.cls * 1000) / 1000 : null,
      globals: present,
    }
  }, TRACKING_GLOBAL_NAMES)
  for (const g of metrics.globals) collect.globals.add(g)

  let overflow: OverflowFacts | null = null
  if (viewport === 'mobile') {
    overflow = (await page.evaluate(OVERFLOW_SCRIPT)) as OverflowFacts | null
  }

  const shots = await captureScreenshots(page, ws, `screenshots/${slug}-${viewport}`)
  await Promise.all(pending)

  const bytesByType: Record<string, { count: number; bytes: number }> = {}
  let transferBytes = 0
  for (const s of sizes) {
    transferBytes += s.bytes
    const entry = (bytesByType[s.type] ??= { count: 0, bytes: 0 })
    entry.count++
    entry.bytes += s.bytes
  }
  const thirdPartyHosts = [
    ...new Set(
      sizes
        .map((s) => {
          try {
            const host = new URL(s.url).host
            return new URL(s.url).origin === pageOrigin ? null : host
          } catch {
            return null
          }
        })
        .filter((h): h is string => !!h),
    ),
  ]
  const mixedContent = url.startsWith('https:')
    ? sizes
        .filter((s) => s.url.startsWith('http:'))
        .map((s) => s.url)
        .slice(0, 20)
    : []

  return {
    page,
    report: {
      viewport,
      width: page.viewportSize()?.width ?? 0,
      height: page.viewportSize()?.height ?? 0,
      status,
      finalUrl: page.url(),
      title: metrics.title,
      screenshot: shots.screenshot,
      fullPageScreenshot: shots.fullPageScreenshot,
      consoleErrors: consoleErrors.slice(0, 50),
      pageErrors: pageErrors.slice(0, 20),
      failedRequests: failedRequests.slice(0, 50),
      requestCount: sizes.length,
      transferBytes,
      bytesByType,
      heavyResources: [...sizes]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 8)
        .map((s) => ({ url: s.url, bytes: s.bytes, type: s.type })),
      thirdPartyHosts: thirdPartyHosts.slice(0, 40),
      timing: {
        ttfbMs: metrics.ttfbMs,
        domContentLoadedMs: metrics.domContentLoadedMs,
        loadMs: metrics.loadMs,
        lcpMs: metrics.lcpMs,
        cls: metrics.cls,
      },
      overflow,
      mixedContent,
    },
  }
}

async function pageFacts(page: Page) {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? ''
    const letters = text.replace(/[^\p{L}]/gu, '')
    const arabic = text.replace(/[^\p{Script=Arabic}]/gu, '')
    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
    const languageLinks = anchors
      .filter((a) => {
        const label = a.textContent?.trim() ?? ''
        return (
          a.hasAttribute('hreflang') ||
          /^(ar|en|fr|العربية|عربي|english|français)$/i.test(label) ||
          /\/(ar|en|fr)(\/|$)|[?&](lang|locale)=/i.test(
            new URL(a.href, location.href).pathname + new URL(a.href, location.href).search,
          )
        )
      })
      .slice(0, 10)
      .map((a) => ({
        text: (a.textContent ?? '').trim().slice(0, 40),
        href: a.href,
        hreflang: a.getAttribute('hreflang'),
      }))
    const forms = Array.from(document.querySelectorAll('form'))
      .slice(0, 10)
      .map((f) => ({
        action: f.getAttribute('action'),
        method: f.getAttribute('method'),
        fields: f.querySelectorAll('input:not([type=hidden]), select, textarea').length,
        hasSubmit: !!f.querySelector('button, input[type=submit]'),
      }))
    return {
      localization: {
        lang: document.documentElement.getAttribute('lang'),
        dirAttr: document.documentElement.getAttribute('dir') ?? document.body?.getAttribute('dir') ?? null,
        computedDirection: document.body ? getComputedStyle(document.body).direction : null,
        arabicCharRatio: letters.length ? Math.round((arabic.length / letters.length) * 100) / 100 : 0,
        languageLinks,
      },
      conversionSurface: {
        whatsappLinks: anchors
          .filter((a) => /wa\.me|whatsapp/i.test(a.href))
          .map((a) => a.href)
          .slice(0, 5),
        telLinks: anchors.filter((a) => a.href.startsWith('tel:')).length,
        mailtoLinks: anchors.filter((a) => a.href.startsWith('mailto:')).length,
        forms,
        buttons: document.querySelectorAll('button, [role=button], input[type=submit]').length,
      },
      dataLayerEvents: Array.isArray((window as unknown as { dataLayer?: unknown[] }).dataLayer)
        ? (window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer
            .map((e) => (e && typeof e === 'object' && typeof e.event === 'string' ? e.event : null))
            .filter((e): e is string => !!e)
            .slice(0, 30)
        : [],
    }
  })
}

async function runAxe(page: Page, ws: Workspace, slug: string): Promise<BrowserPageReport['axe']> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const violations: AxeViolation[] = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    sampleHtml: v.nodes[0]?.html.slice(0, 300) ?? null,
  }))
  const artifact = `tools/axe/${slug}.json`
  await ws.writeJson(artifact, {
    url: results.url,
    timestamp: results.timestamp,
    violations: results.violations,
    incomplete: results.incomplete.map((i) => ({
      id: i.id,
      impact: i.impact,
      help: i.help,
      nodes: i.nodes.length,
    })),
    passes: results.passes.length,
  })
  return { violations, passes: results.passes.length, incomplete: results.incomplete.length, artifact }
}

/** Inspects one page in a real browser at desktop and mobile sizes. */
export async function inspectPage(
  browser: Browser,
  url: string,
  ws: Workspace,
  options: { runAxe: boolean; responseHeaders?: Record<string, string> },
): Promise<BrowserPageReport> {
  const slug = urlSlug(url)
  const collect = { requestUrls: new Set<string>(), globals: new Set<string>() }
  const report: BrowserPageReport = {
    url,
    slug,
    desktop: null,
    mobile: null,
    error: null,
    tracking: [],
    trackingIds: [],
    dataLayerEvents: [],
    technologies: [],
    localization: null,
    conversionSurface: null,
    axe: null,
    domSnapshot: null,
  }

  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  })
  await desktopContext.addInitScript(PERF_INIT_SCRIPT)
  try {
    const { report: desktop, page } = await inspectViewport(desktopContext, url, 'desktop', ws, slug, collect)
    report.desktop = desktop
    const facts = await pageFacts(page)
    report.localization = facts.localization
    report.conversionSurface = facts.conversionSurface
    report.dataLayerEvents = facts.dataLayerEvents
    const html = await page.content()
    report.domSnapshot = await ws.writeText(`browser/${slug}/dom.html`, html)
    if (options.runAxe) {
      report.axe = await runAxe(page, ws, slug).catch(() => null)
    }
    const urls = [...collect.requestUrls]
    report.technologies = detectTechnologies({
      headers: options.responseHeaders ?? {},
      requestUrls: urls,
      html,
      globals: [...collect.globals],
    })
  } catch (error) {
    report.error = `Desktop inspection failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    await desktopContext.close().catch(() => undefined)
  }

  const iphone = devices['iPhone 13']!
  const mobileContext = await browser.newContext({
    viewport: iphone.viewport,
    userAgent: iphone.userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  })
  await mobileContext.addInitScript(PERF_INIT_SCRIPT)
  try {
    const { report: mobile } = await inspectViewport(mobileContext, url, 'mobile', ws, slug, collect)
    report.mobile = mobile
  } catch (error) {
    const message = `Mobile inspection failed: ${error instanceof Error ? error.message : String(error)}`
    report.error = report.error ? `${report.error}; ${message}` : message
  } finally {
    await mobileContext.close().catch(() => undefined)
  }

  const requestUrls = [...collect.requestUrls]
  report.tracking = detectTracking(requestUrls, [...collect.globals])
  report.trackingIds = extractTrackingIds(requestUrls)
  await ws.writeJson(`network/${slug}-requests.json`, requestUrls)
  return report
}
