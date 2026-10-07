import * as cheerio from 'cheerio'
import { fetchUrl } from './http.ts'

export interface RobotsFacts {
  url: string
  status: number | null
  found: boolean
  sitemaps: string[]
  /** Disallow rules for the `*` user agent. */
  disallow: string[]
  disallowAll: boolean
  raw: string | null
}

export function parseRobots(text: string): { sitemaps: string[]; disallow: string[] } {
  const sitemaps: string[] = []
  const disallow: string[] = []
  let appliesToAll = false
  let inGroupHeader = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'sitemap') {
      if (value) sitemaps.push(value)
      continue
    }
    if (key === 'user-agent') {
      // Consecutive user-agent lines form one group.
      appliesToAll = inGroupHeader ? appliesToAll || value === '*' : value === '*'
      inGroupHeader = true
      continue
    }
    inGroupHeader = false
    if (key === 'disallow' && appliesToAll && value) disallow.push(value)
  }
  return { sitemaps, disallow }
}

export async function fetchRobots(origin: string, signal?: AbortSignal): Promise<RobotsFacts> {
  const url = new URL('/robots.txt', origin).toString()
  const result = await fetchUrl(url, { signal, timeoutMs: 15000, maxBytes: 500_000 })
  const found = result.status === 200 && !!result.body && !/<html/i.test(result.body.slice(0, 500))
  const parsed = found && result.body ? parseRobots(result.body) : { sitemaps: [], disallow: [] }
  return {
    url,
    status: result.status,
    found,
    sitemaps: parsed.sitemaps,
    disallow: parsed.disallow,
    disallowAll: parsed.disallow.includes('/'),
    raw: found ? (result.body ?? '').slice(0, 20_000) : null,
  }
}

export interface SitemapFacts {
  checked: {
    url: string
    status: number | null
    kind: 'urlset' | 'index' | 'invalid' | 'missing'
    urls: number
  }[]
  urls: string[]
  totalUrls: number
}

/** Reads sitemap(s), following sitemap indexes, bounded by `maxUrls` and `maxSitemaps`. */
export async function fetchSitemaps(
  origin: string,
  hinted: string[],
  options: { signal?: AbortSignal; maxUrls?: number; maxSitemaps?: number } = {},
): Promise<SitemapFacts> {
  const maxUrls = options.maxUrls ?? 5000
  const maxSitemaps = options.maxSitemaps ?? 8
  const queue = hinted.length ? [...hinted] : [new URL('/sitemap.xml', origin).toString()]
  const seen = new Set<string>()
  const checked: SitemapFacts['checked'] = []
  const urls = new Set<string>()
  let totalUrls = 0

  while (queue.length && checked.length < maxSitemaps) {
    const url = queue.shift()!
    if (seen.has(url)) continue
    seen.add(url)
    const result = await fetchUrl(url, { signal: options.signal, timeoutMs: 20000, maxBytes: 20_000_000 })
    if (result.status !== 200 || !result.body) {
      checked.push({ url, status: result.status, kind: 'missing', urls: 0 })
      continue
    }
    const $ = cheerio.load(result.body, { xml: true })
    const sitemapLocs = $('sitemapindex > sitemap > loc')
      .map((_, el) => $(el).text().trim())
      .get()
    if (sitemapLocs.length) {
      checked.push({ url, status: result.status, kind: 'index', urls: sitemapLocs.length })
      queue.push(...sitemapLocs)
      continue
    }
    const locs = $('urlset > url > loc')
      .map((_, el) => $(el).text().trim())
      .get()
    if (!locs.length) {
      checked.push({ url, status: result.status, kind: 'invalid', urls: 0 })
      continue
    }
    totalUrls += locs.length
    checked.push({ url, status: result.status, kind: 'urlset', urls: locs.length })
    for (const loc of locs) {
      if (urls.size >= maxUrls) break
      urls.add(loc)
    }
  }
  return { checked, urls: [...urls], totalUrls }
}
