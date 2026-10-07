import type { EvidenceItem, MetricCatalogEntry, ValueUnit } from '@audivra/contracts'

/**
 * The metric catalog: measured facts extracted deterministically from evidence metadata.
 * Artifacts reference these by key so the AI never types numbers that Audivra cannot trace.
 *
 * Key scheme (documented for the Artifact Planner):
 *   lighthouse:<path>:<mobile|desktop>:<performance|accessibility|bestPractices|seo|lcp|fcp|tbt|cls|si|tti|weight|ttfb>
 *   browser:<path>:<desktop|mobile>:<ttfb|dcl|load|lcp|cls|requests|transfer|thirdParties>
 *   axe:<path>:<violations|nodes>        console:<path>:errors      network:<path>:failures
 *   mobile:<path>:scrollWidth            links:<checked|broken|brokenInternal|inconclusive>
 *   crawl:<pages|discovered>             seo:<missingTitle|missingDescription|missingH1|multipleH1|duplicateTitles|
 *                                            duplicateDescriptions|noindex|missingCanonical|imagesMissingAltPages>
 *   tls:daysRemaining                    tracking:detected           zap:<high|medium|low|informational>
 *   evidence:<EV-ref>:<name>             (numbers an auditor recorded under metadata.metrics)
 */

type Meta = Record<string, unknown>

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const obj = (value: unknown): Meta | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Meta) : null)
const arr = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

/** Canonical page path used in keys: pathname (+ search), "/" for the root, trailing slash removed. */
export function pagePath(url: string | null | undefined): string {
  if (!url) return '/'
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '') || '/'
    return `${path}${u.search}`
  } catch {
    return url.startsWith('/') ? url.replace(/\/+$/, '') || '/' : url
  }
}

/** Evidence kind: explicit metadata.kind (newer baseline evidence) or inferred from metadata shape. */
export function evidenceKind(item: EvidenceItem): string {
  const m = item.metadata
  if (typeof m.kind === 'string') return m.kind
  if (obj(m.scores) && obj(m.metrics) && typeof m.formFactor === 'string') return 'lighthouse'
  if (obj(m.timing) && 'transferKB' in m) return 'browser-metrics'
  if (arr(m.violations) && 'passes' in m) return 'axe'
  if ('checked' in m && arr(m.broken)) return 'links'
  if ('pagesFetched' in m) return 'crawl'
  if (arr(m.missingTitle) && arr(m.duplicateTitles)) return 'seo-inventory'
  if (arr(m.directionMismatches) && arr(m.languages)) return 'localization'
  if (item.type === 'tls-result' && 'daysRemaining' in m) return 'tls'
  if (arr(m.consoleErrors) || arr(m.uncaughtExceptions)) return 'console'
  if (item.type === 'network-failure' && arr(m.requests)) return 'network'
  if ('scrollWidth' in m && 'viewportWidth' in m) return 'overflow'
  if (arr(m.detected) && 'dataLayerEvents' in m) return 'tracking'
  if (arr(m.hints)) return 'technology'
  if (item.type === 'screenshot') return 'screenshot'
  if (item.type === 'http-header' && 'securityHeadersMissing' in m) return 'http'
  if (arr(m.pages) && item.title.startsWith('Contact/conversion')) return 'conversion-surface'
  return item.type
}

/** Page path of a viewport-specific baseline evidence item ("Browser load metrics (mobile) · /ar/"). */
function viewportOf(item: EvidenceItem): 'desktop' | 'mobile' | null {
  const viewport = typeof item.metadata.viewport === 'string' ? item.metadata.viewport : item.title
  if (/mobile|390/i.test(viewport)) return 'mobile'
  if (/desktop|1440/i.test(viewport)) return 'desktop'
  return null
}

interface Builder {
  add(entry: Omit<MetricCatalogEntry, 'lowerIsBetter'> & { lowerIsBetter?: boolean | null }): void
}

const LIGHTHOUSE_METRICS: [string, string, string, ValueUnit, boolean][] = [
  ['lcp', 'lcpMs', 'LCP', 'ms', true],
  ['fcp', 'fcpMs', 'FCP', 'ms', true],
  ['tbt', 'tbtMs', 'TBT', 'ms', true],
  ['cls', 'cls', 'CLS', 'none', true],
  ['si', 'speedIndexMs', 'Speed Index', 'ms', true],
  ['tti', 'ttiMs', 'Time to Interactive', 'ms', true],
  ['ttfb', 'serverResponseMs', 'Server response', 'ms', true],
]
const LIGHTHOUSE_SCORES: [string, string][] = [
  ['performance', 'Performance score'],
  ['accessibility', 'Accessibility score'],
  ['bestPractices', 'Best practices score'],
  ['seo', 'SEO score'],
]

function addLighthouse(b: Builder, item: EvidenceItem): void {
  const m = item.metadata
  const scores = obj(m.scores)
  const metrics = obj(m.metrics)
  const formFactor = m.formFactor === 'desktop' ? 'desktop' : 'mobile'
  const path = pagePath(typeof m.url === 'string' && m.url ? m.url : item.url)
  const prefix = `lighthouse:${path}:${formFactor}`
  for (const [key, label] of LIGHTHOUSE_SCORES) {
    const value = num(scores?.[key])
    if (value !== null)
      b.add({ key: `${prefix}:${key}`, label: `${label} (${formFactor}) ${path}`, value, unit: 'score', url: item.url, evidenceId: item.ref, group: 'Lighthouse', lowerIsBetter: false })
  }
  for (const [key, field, label, unit, lower] of LIGHTHOUSE_METRICS) {
    const value = num(metrics?.[field])
    if (value !== null)
      b.add({ key: `${prefix}:${key}`, label: `${label} (${formFactor}) ${path}`, value, unit, url: item.url, evidenceId: item.ref, group: 'Lighthouse', lowerIsBetter: lower })
  }
  const weight = num(m.totalBytes)
  if (weight !== null)
    b.add({ key: `${prefix}:weight`, label: `Page weight (${formFactor}) ${path}`, value: weight, unit: 'bytes', url: item.url, evidenceId: item.ref, group: 'Lighthouse', lowerIsBetter: true })
}

function addBrowserMetrics(b: Builder, item: EvidenceItem): void {
  const m = item.metadata
  const viewport = viewportOf(item) ?? 'desktop'
  const path = pagePath(item.url)
  const prefix = `browser:${path}:${viewport}`
  const timing = obj(m.timing)
  const fields: [string, unknown, string, ValueUnit][] = [
    ['ttfb', timing?.ttfbMs, 'TTFB', 'ms'],
    ['dcl', timing?.domContentLoadedMs, 'DOMContentLoaded', 'ms'],
    ['load', timing?.loadMs, 'Load event', 'ms'],
    ['lcp', timing?.lcpMs, 'LCP (unthrottled)', 'ms'],
    ['cls', timing?.cls, 'CLS (browser)', 'none'],
    ['requests', m.requests, 'Requests', 'count'],
    ['transfer', m.transferKB, 'Transferred', 'kb'],
  ]
  for (const [key, raw, label, unit] of fields) {
    const value = num(raw)
    if (value !== null)
      b.add({ key: `${prefix}:${key}`, label: `${label} (${viewport}) ${path}`, value, unit, url: item.url, evidenceId: item.ref, group: 'Browser', lowerIsBetter: true })
  }
  const third = arr(m.thirdPartyHosts)
  if (third)
    b.add({ key: `${prefix}:thirdParties`, label: `Third-party hosts (${viewport}) ${path}`, value: third.length, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Browser', lowerIsBetter: true })
}

export function buildMetricCatalog(evidence: EvidenceItem[]): MetricCatalogEntry[] {
  const entries = new Map<string, MetricCatalogEntry>()
  const b: Builder = {
    add(entry) {
      // First evidence wins for a key (baseline before agent duplicates), keeping refs stable.
      if (!entries.has(entry.key)) entries.set(entry.key, { ...entry, lowerIsBetter: entry.lowerIsBetter ?? null })
    },
  }
  for (const item of evidence) {
    const m = item.metadata
    const kind = evidenceKind(item)
    const path = pagePath(item.url)
    switch (kind) {
      case 'lighthouse':
        addLighthouse(b, item)
        break
      case 'browser-metrics':
        addBrowserMetrics(b, item)
        break
      case 'axe': {
        const violations = arr(m.violations) ?? []
        const nodes = violations.reduce<number>((sum, v) => sum + (num(obj(v)?.nodes) ?? 0), 0)
        b.add({ key: `axe:${path}:violations`, label: `Accessibility rule violations ${path}`, value: violations.length, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Accessibility', lowerIsBetter: true })
        b.add({ key: `axe:${path}:nodes`, label: `Elements failing accessibility rules ${path}`, value: nodes, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Accessibility', lowerIsBetter: true })
        break
      }
      case 'links': {
        const broken = arr(m.broken) ?? []
        const internal = broken.filter((x) => obj(x)?.internal === true).length
        const checked = num(m.checked)
        if (checked !== null) b.add({ key: 'links:checked', label: 'Link/resource targets checked', value: checked, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Links', lowerIsBetter: null })
        b.add({ key: 'links:broken', label: 'Broken link/resource targets', value: broken.length, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Links', lowerIsBetter: true })
        b.add({ key: 'links:brokenInternal', label: 'Broken internal targets', value: internal, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Links', lowerIsBetter: true })
        const inconclusive = arr(m.inconclusive)
        if (inconclusive) b.add({ key: 'links:inconclusive', label: 'Inconclusive external targets', value: inconclusive.length, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Links', lowerIsBetter: null })
        break
      }
      case 'crawl': {
        const pages = num(m.pagesFetched)
        const discovered = num(m.urlsDiscovered)
        if (pages !== null) b.add({ key: 'crawl:pages', label: 'Pages crawled', value: pages, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Crawl', lowerIsBetter: null })
        if (discovered !== null) b.add({ key: 'crawl:discovered', label: 'URLs discovered', value: discovered, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Crawl', lowerIsBetter: null })
        break
      }
      case 'seo-inventory': {
        const counters: [string, string][] = [
          ['missingTitle', 'Pages missing a title'],
          ['missingDescription', 'Pages missing a meta description'],
          ['missingH1', 'Pages missing an H1'],
          ['multipleH1', 'Pages with multiple H1s'],
          ['duplicateTitles', 'Duplicate title groups'],
          ['duplicateDescriptions', 'Duplicate description groups'],
          ['noindex', 'Pages marked noindex'],
          ['missingCanonical', 'Pages missing a canonical'],
          ['imagesMissingAlt', 'Pages with images missing alt'],
        ]
        for (const [field, label] of counters) {
          const list = arr(m[field])
          if (list) b.add({ key: `seo:${field === 'imagesMissingAlt' ? 'imagesMissingAltPages' : field}`, label, value: list.length, unit: 'count', url: item.url, evidenceId: item.ref, group: 'SEO', lowerIsBetter: true })
        }
        const analyzed = num(m.pagesAnalyzed)
        if (analyzed !== null) b.add({ key: 'seo:pagesAnalyzed', label: 'Pages analyzed for SEO', value: analyzed, unit: 'count', url: item.url, evidenceId: item.ref, group: 'SEO', lowerIsBetter: null })
        break
      }
      case 'tls': {
        const days = num(m.daysRemaining)
        if (days !== null) b.add({ key: 'tls:daysRemaining', label: 'Certificate days remaining', value: days, unit: 'days', url: item.url, evidenceId: item.ref, group: 'Security', lowerIsBetter: false })
        break
      }
      case 'console': {
        const errors = (arr(m.consoleErrors)?.length ?? 0) + (arr(m.uncaughtExceptions)?.length ?? 0)
        b.add({ key: `console:${path}:errors`, label: `Console/JS errors ${path}`, value: errors, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Browser', lowerIsBetter: true })
        break
      }
      case 'network': {
        const requests = arr(m.requests)
        if (requests) b.add({ key: `network:${path}:failures`, label: `Failed requests ${path}`, value: requests.length, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Browser', lowerIsBetter: true })
        break
      }
      case 'overflow': {
        const width = num(m.scrollWidth)
        const viewport = num(m.viewportWidth)
        if (width !== null) b.add({ key: `mobile:${path}:scrollWidth`, label: `Mobile page width ${path}`, value: width, unit: 'px', url: item.url, evidenceId: item.ref, group: 'Mobile', lowerIsBetter: true })
        if (viewport !== null) b.add({ key: `mobile:${path}:viewportWidth`, label: `Mobile viewport width ${path}`, value: viewport, unit: 'px', url: item.url, evidenceId: item.ref, group: 'Mobile', lowerIsBetter: null })
        break
      }
      case 'tracking': {
        const detected = arr(m.detected)
        if (detected) b.add({ key: 'tracking:detected', label: 'Tracking tools detected on load', value: detected.length, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Tracking', lowerIsBetter: null })
        break
      }
      case 'zap': {
        const counts = obj(m.riskCounts)
        for (const risk of ['high', 'medium', 'low', 'informational']) {
          const value = num(counts?.[risk])
          if (value !== null) b.add({ key: `zap:${risk}`, label: `ZAP ${risk} alerts`, value, unit: 'count', url: item.url, evidenceId: item.ref, group: 'Security', lowerIsBetter: true })
        }
        break
      }
      default:
        break
    }
    // Numbers an auditor recorded explicitly under metadata.metrics: { name: number }.
    const metrics = obj(m.metrics)
    if (metrics && kind !== 'lighthouse') {
      for (const [name, raw] of Object.entries(metrics)) {
        const value = num(raw)
        if (value === null || !/^[\w.-]{1,40}$/.test(name)) continue
        b.add({ key: `evidence:${item.ref}:${name}`, label: `${name} (${item.ref})`, value, unit: unitFromName(name), url: item.url, evidenceId: item.ref, group: 'Recorded measurements', lowerIsBetter: null })
      }
    }
  }
  return [...entries.values()]
}

function unitFromName(name: string): ValueUnit {
  if (/_ms$|Ms$/.test(name)) return 'ms'
  if (/_s$|seconds/i.test(name)) return 's'
  if (/_px$|px$/i.test(name)) return 'px'
  if (/percent|pct|_ratio$/i.test(name)) return /ratio/i.test(name) ? 'ratio' : 'percent'
  if (/_kb$|kb$/i.test(name)) return 'kb'
  if (/bytes$/i.test(name)) return 'bytes'
  if (/score/i.test(name)) return 'score'
  if (/count|_n$|number/i.test(name)) return 'count'
  return 'none'
}

/**
 * Path of the audited start page as measured by the baseline (the first Lighthouse entry). Sites that
 * redirect "/" (e.g. to "/en") are keyed by the final path.
 */
export function startPagePath(entries: MetricCatalogEntry[]): string {
  const first = entries.find((e) => /^lighthouse:.*:mobile:performance$/.test(e.key))
  return first ? (first.key.split(':')[1] ?? '/') : '/'
}

/** Compact text listing for prompts: one line per entry. */
export function catalogAsText(entries: MetricCatalogEntry[], limit = 400): string {
  return entries
    .slice(0, limit)
    .map((e) => `${e.key} = ${formatValue(e.value, e.unit)} — ${e.label} [${e.evidenceId}]`)
    .join('\n')
}

export function formatValue(value: number, unit: ValueUnit): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 1000) / 1000
  switch (unit) {
    case 'ms':
      return `${rounded} ms`
    case 's':
      return `${rounded} s`
    case 'bytes':
      return `${rounded} B`
    case 'kb':
      return `${rounded} KB`
    case 'percent':
      return `${rounded}%`
    case 'px':
      return `${rounded} px`
    case 'days':
      return `${rounded} days`
    default:
      return String(rounded)
  }
}
