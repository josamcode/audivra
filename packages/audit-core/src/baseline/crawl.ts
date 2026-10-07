import * as cheerio from 'cheerio'
import { fetchUrl, type FetchResult } from './http.ts'

export interface PageFacts {
  url: string
  finalUrl: string
  status: number | null
  depth: number
  source: 'start' | 'link' | 'sitemap'
  contentType: string | null
  bytes: number
  timingMs: number
  error: string | null
  redirects: number
  title: string | null
  description: string | null
  canonical: string | null
  robotsMeta: string | null
  xRobotsTag: string | null
  h1: string[]
  h2Count: number
  lang: string | null
  dir: string | null
  hreflang: { lang: string; href: string }[]
  viewport: string | null
  ogTitle: string | null
  ogImage: string | null
  generator: string | null
  images: number
  imagesMissingAlt: number
  missingAltSamples: string[]
  internalLinks: number
  externalLinks: number
  forms: number
  wordCount: number
  arabicCharRatio: number
  /** Share of Latin letters in navigation/header link text (null when there is too little text). */
  navLatinRatio: number | null
  /** Share of Latin letters in buttons and call-to-action controls (null when there is too little text). */
  controlsLatinRatio: number | null
  structuredDataTypes: string[]
  scripts: number
  stylesheets: number
}

export interface ExtractedLink {
  href: string
  kind: 'page' | 'resource'
  text: string
}

const SKIP_EXTENSIONS =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|gz|mp4|mp3|webm|mov|avi|docx?|xlsx?|pptx?|css|js|json|xml|txt|woff2?|ttf|eot)$/i

/** Share of Latin-script letters among all letters, or null when there are fewer than 6 letters. */
export function latinShare(text: string): number | null {
  const letters = text.replace(/[^\p{L}]/gu, '')
  if (letters.length < 6) return null
  const latin = text.replace(/[^\p{Script=Latin}]/gu, '')
  return Math.round((latin.length / letters.length) * 100) / 100
}

export function normalizePageUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.replace(/^www\./, '')
  try {
    return strip(new URL(a).hostname) === strip(new URL(b).hostname)
  } catch {
    return false
  }
}

/** Extracts SEO/content facts and outgoing links from HTML. Pure function — easy to test. */
export function extractPageFacts(
  html: string,
  pageUrl: string,
): {
  facts: Omit<
    PageFacts,
    | 'url'
    | 'finalUrl'
    | 'status'
    | 'depth'
    | 'source'
    | 'contentType'
    | 'bytes'
    | 'timingMs'
    | 'error'
    | 'redirects'
    | 'xRobotsTag'
  >
  links: ExtractedLink[]
} {
  const $ = cheerio.load(html)
  const text = (sel: string) => $(sel).first().attr('content')?.trim() || null
  const links: ExtractedLink[] = []
  let internalLinks = 0
  let externalLinks = 0

  $('a[href]').each((_, el) => {
    const href = normalizePageUrl($(el).attr('href') ?? '', pageUrl)
    if (!href) return
    if (sameSite(href, pageUrl)) internalLinks++
    else externalLinks++
    links.push({ href, kind: 'page', text: $(el).text().trim().replace(/\s+/g, ' ').slice(0, 80) })
  })
  const resourceSelectors: [string, string][] = [
    ['img[src]', 'src'],
    ['script[src]', 'src'],
    ['link[rel="stylesheet"][href]', 'href'],
    ['source[src]', 'src'],
  ]
  for (const [selector, attr] of resourceSelectors) {
    $(selector).each((_, el) => {
      const href = normalizePageUrl($(el).attr(attr) ?? '', pageUrl)
      if (href) links.push({ href, kind: 'resource', text: selector.split('[')[0] ?? '' })
    })
  }

  const images = $('img')
  const missingAlt = images.filter((_, el) => $(el).attr('alt') === undefined)
  const structured = new Set<string>()
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text()) as unknown
      const visit = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (node && typeof node === 'object') {
          const type = (node as Record<string, unknown>)['@type']
          if (typeof type === 'string') structured.add(type)
          else if (Array.isArray(type)) type.forEach((t) => typeof t === 'string' && structured.add(t))
          const graph = (node as Record<string, unknown>)['@graph']
          if (graph) visit(graph)
        }
      }
      visit(parsed)
    } catch {
      structured.add('(invalid JSON-LD)')
    }
  })

  const navText = $('nav a, header a').map((_, el) => $(el).text()).get().join(' ')
  const controlsText = $('button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn"], a[class*="button"], [class*="cta"]')
    .map((_, el) => $(el).text() || $(el).attr('value') || '')
    .get()
    .join(' ')
  $('script, style, noscript, template').remove()
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
  const letters = bodyText.replace(/[^\p{L}]/gu, '')
  const arabic = bodyText.replace(/[^\p{Script=Arabic}]/gu, '')

  return {
    facts: {
      title: $('title').first().text().trim() || null,
      description: text('meta[name="description" i]'),
      canonical: $('link[rel="canonical"]').attr('href')?.trim() || null,
      robotsMeta: text('meta[name="robots" i]'),
      h1: $('h1')
        .map((_, el) => $(el).text().trim().replace(/\s+/g, ' ').slice(0, 160))
        .get(),
      h2Count: $('h2').length,
      lang: $('html').attr('lang')?.trim() || null,
      dir: $('html').attr('dir')?.trim() || $('body').attr('dir')?.trim() || null,
      hreflang: $('link[rel="alternate"][hreflang]')
        .map((_, el) => ({ lang: $(el).attr('hreflang') ?? '', href: $(el).attr('href') ?? '' }))
        .get(),
      viewport: text('meta[name="viewport" i]'),
      ogTitle: text('meta[property="og:title"]'),
      ogImage: text('meta[property="og:image"]'),
      generator: text('meta[name="generator" i]'),
      images: images.length,
      imagesMissingAlt: missingAlt.length,
      missingAltSamples: missingAlt
        .map((_, el) => $(el).attr('src') ?? '')
        .get()
        .slice(0, 5),
      internalLinks,
      externalLinks,
      forms: $('form').length,
      wordCount: bodyText ? bodyText.split(' ').length : 0,
      arabicCharRatio: letters.length ? Math.round((arabic.length / letters.length) * 100) / 100 : 0,
      navLatinRatio: latinShare(navText),
      controlsLatinRatio: latinShare(controlsText),
      structuredDataTypes: [...structured],
      scripts: $('script[src]').length,
      stylesheets: $('link[rel="stylesheet"]').length,
    },
    links,
  }
}

export interface CrawlOptions {
  startUrl: string
  sitemapUrls: string[]
  maxPages: number
  concurrency?: number
  signal?: AbortSignal
  onPage?: (page: PageFacts) => void
}

export interface CrawlResult {
  pages: PageFacts[]
  /** All link/resource targets with the pages they appear on. */
  linkSources: Map<string, { kind: 'page' | 'resource'; sources: Set<string>; text: string }>
  discoveredUrls: number
}

/** Picks sitemap URLs spread across top-level path sections so different page types get sampled. */
export function diversifySample(urls: string[], limit: number): string[] {
  const groups = new Map<string, string[]>()
  for (const url of urls) {
    let key: string
    try {
      key = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '/'
    } catch {
      continue
    }
    const list = groups.get(key) ?? []
    list.push(url)
    groups.set(key, list)
  }
  const result: string[] = []
  const lists = [...groups.values()]
  for (let i = 0; result.length < limit && lists.some((l) => l.length > i); i++) {
    for (const list of lists) {
      if (result.length >= limit) break
      const url = list[i]
      if (url) result.push(url)
    }
  }
  return result
}

function toFacts(
  fetched: FetchResult,
  entry: { url: string; depth: number; source: PageFacts['source'] },
): { page: PageFacts; links: ExtractedLink[] } {
  const isHtml = !!fetched.body && (!fetched.contentType || /html/i.test(fetched.contentType))
  const extracted = isHtml ? extractPageFacts(fetched.body!, fetched.finalUrl) : null
  const empty = extractPageFacts('<html></html>', fetched.finalUrl).facts
  return {
    page: {
      url: entry.url,
      finalUrl: fetched.finalUrl,
      status: fetched.status,
      depth: entry.depth,
      source: entry.source,
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      timingMs: fetched.timingMs,
      error: fetched.error,
      redirects: fetched.redirects.length,
      xRobotsTag: fetched.headers['x-robots-tag'] ?? null,
      ...(extracted?.facts ?? empty),
    },
    links: extracted?.links ?? [],
  }
}

/** Bounded breadth-first crawl of same-site HTML pages, seeded with a diverse sitemap sample. */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const concurrency = options.concurrency ?? 3
  const queue: { url: string; depth: number; source: PageFacts['source'] }[] = [
    { url: options.startUrl, depth: 0, source: 'start' },
  ]
  const seen = new Set<string>([options.startUrl])
  const sample = diversifySample(
    options.sitemapUrls.filter((u) => sameSite(u, options.startUrl)),
    Math.ceil(options.maxPages / 2),
  )
  const pages: PageFacts[] = []
  const linkSources: CrawlResult['linkSources'] = new Map()
  let sitemapSeeded = false

  const enqueue = (url: string, depth: number, source: PageFacts['source']) => {
    if (seen.has(url) || !sameSite(url, options.startUrl)) return
    try {
      if (SKIP_EXTENSIONS.test(new URL(url).pathname)) return
    } catch {
      return
    }
    seen.add(url)
    queue.push({ url, depth, source })
  }

  const processOne = async () => {
    const entry = queue.shift()
    if (!entry || options.signal?.aborted) return
    const fetched = await fetchUrl(entry.url, { signal: options.signal, timeoutMs: 20000 })
    const { page, links } = toFacts(fetched, entry)
    if (pages.length >= options.maxPages) return
    pages.push(page)
    options.onPage?.(page)
    if (fetched.finalUrl !== entry.url) seen.add(fetched.finalUrl)
    for (const link of links) {
      const existing = linkSources.get(link.href)
      if (existing) existing.sources.add(page.finalUrl)
      else linkSources.set(link.href, { kind: link.kind, sources: new Set([page.finalUrl]), text: link.text })
      if (link.kind === 'page') enqueue(link.href, entry.depth + 1, 'link')
    }
    if (!sitemapSeeded) {
      sitemapSeeded = true
      for (const url of sample) enqueue(url, 1, 'sitemap')
    }
    // Keep the queue biased towards shallow pages.
    queue.sort((a, b) => a.depth - b.depth)
  }

  // The start page first (it seeds links and the sitemap sample), then parallel workers.
  await processOne()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length && pages.length < options.maxPages && !options.signal?.aborted) await processOne()
    }),
  )
  const discovered = new Set([...seen, ...options.sitemapUrls.filter((u) => sameSite(u, options.startUrl))])
  return { pages, linkSources, discoveredUrls: discovered.size }
}

export interface LinkGraphData {
  pages: { url: string; depth: number; title: string | null }[]
  edges: { from: string; to: string }[]
}

/** Page-to-page links found by the crawl (input for the site-structure visual). Pure. */
export function buildLinkGraph(result: Pick<CrawlResult, 'pages' | 'linkSources'>, maxEdges = 4000): LinkGraphData {
  const pages = result.pages.map((p) => ({ url: p.finalUrl, depth: p.depth, title: p.title }))
  const edges: LinkGraphData['edges'] = []
  for (const [href, info] of result.linkSources) {
    if (info.kind !== 'page') continue
    for (const source of info.sources) {
      if (edges.length >= maxEdges) return { pages, edges }
      if (source !== href) edges.push({ from: source, to: href })
    }
  }
  return { pages, edges }
}
