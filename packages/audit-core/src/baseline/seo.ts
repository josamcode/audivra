import { normalizePageUrl, type PageFacts } from './crawl.ts'

export interface SeoFacts {
  pagesAnalyzed: number
  non200: { url: string; status: number | null; error: string | null }[]
  missingTitle: string[]
  missingDescription: string[]
  missingH1: string[]
  multipleH1: { url: string; count: number }[]
  duplicateTitles: { value: string; urls: string[] }[]
  duplicateDescriptions: { value: string; urls: string[] }[]
  noindex: string[]
  missingCanonical: string[]
  canonicalToOtherUrl: { url: string; canonical: string }[]
  missingViewport: string[]
  longTitles: { url: string; length: number }[]
  imagesMissingAlt: { url: string; count: number }[]
  structuredDataTypes: string[]
}

function duplicates(
  pages: PageFacts[],
  pick: (p: PageFacts) => string | null,
): { value: string; urls: string[] }[] {
  const map = new Map<string, string[]>()
  for (const page of pages) {
    const value = pick(page)?.trim()
    if (!value) continue
    map.set(value, [...(map.get(value) ?? []), page.finalUrl])
  }
  return [...map.entries()].filter(([, urls]) => urls.length > 1).map(([value, urls]) => ({ value, urls }))
}

function sameUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return (
      x.host === y.host &&
      x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') &&
      x.search === y.search
    )
  } catch {
    return a === b
  }
}

/** Aggregates crawl facts into SEO facts. Facts only; severity is for the auditor to judge. */
export function analyzeSeo(pages: PageFacts[]): SeoFacts {
  const html = pages.filter((p) => p.status === 200 && (!p.contentType || /html/i.test(p.contentType)))
  return {
    pagesAnalyzed: html.length,
    non200: pages
      .filter((p) => p.status !== 200)
      .map((p) => ({ url: p.url, status: p.status, error: p.error })),
    missingTitle: html.filter((p) => !p.title).map((p) => p.finalUrl),
    missingDescription: html.filter((p) => !p.description).map((p) => p.finalUrl),
    missingH1: html.filter((p) => p.h1.length === 0).map((p) => p.finalUrl),
    multipleH1: html.filter((p) => p.h1.length > 1).map((p) => ({ url: p.finalUrl, count: p.h1.length })),
    duplicateTitles: duplicates(html, (p) => p.title),
    duplicateDescriptions: duplicates(html, (p) => p.description),
    noindex: html
      .filter((p) => /noindex/i.test(`${p.robotsMeta ?? ''} ${p.xRobotsTag ?? ''}`))
      .map((p) => p.finalUrl),
    missingCanonical: html.filter((p) => !p.canonical).map((p) => p.finalUrl),
    canonicalToOtherUrl: html
      .filter((p) => p.canonical && !sameUrl(new URL(p.canonical, p.finalUrl).toString(), p.finalUrl))
      .map((p) => ({ url: p.finalUrl, canonical: p.canonical! })),
    missingViewport: html.filter((p) => !p.viewport).map((p) => p.finalUrl),
    longTitles: html
      .filter((p) => (p.title?.length ?? 0) > 65)
      .map((p) => ({ url: p.finalUrl, length: p.title!.length })),
    imagesMissingAlt: html
      .filter((p) => p.imagesMissingAlt > 0)
      .map((p) => ({ url: p.finalUrl, count: p.imagesMissingAlt })),
    structuredDataTypes: [...new Set(html.flatMap((p) => p.structuredDataTypes))],
  }
}

export interface LocalizationFacts {
  languages: string[]
  pages: { url: string; lang: string | null; dir: string | null; arabicCharRatio: number; hreflang: number }[]
  hreflangPages: number
  /** Pages whose text is mostly Arabic but are not marked dir="rtl" (and the reverse). */
  directionMismatches: { url: string; lang: string | null; dir: string | null; arabicCharRatio: number }[]
  missingLang: string[]
  localePathPrefixes: string[]
  /** hreflang problems between crawled pages (targets that were not crawled are not judged). */
  hreflangIssues: { url: string; kind: 'not-reciprocal' | 'language-mismatch' | 'invalid-code' | 'no-self-reference'; detail: string }[]
  /** Locale-prefixed paths (e.g. /en/about) whose counterpart in another locale was not seen in the crawl sample. */
  missingPairs: { path: string; present: string[]; missing: string }[]
  /** Pages in different languages that share an identical title or description (likely untranslated). */
  untranslatedMetadata: { field: 'title' | 'description'; value: string; urls: string[] }[]
  /** Right-to-left (Arabic) pages whose navigation or buttons are mostly in Latin script. */
  mixedLanguage: { url: string; area: 'navigation' | 'controls'; latinShare: number }[]
}

const HREFLANG_CODE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i
const urlKey = (url: string) => url.replace(/#.*$/, '').replace(/\/+$/, '')

function hreflangIssues(html: PageFacts[]): LocalizationFacts['hreflangIssues'] {
  const byUrl = new Map(html.map((p) => [urlKey(p.finalUrl), p]))
  const issues: LocalizationFacts['hreflangIssues'] = []
  for (const page of html) {
    if (!page.hreflang.length) continue
    const own = urlKey(page.finalUrl)
    let selfReference = false
    for (const alt of page.hreflang) {
      if (!HREFLANG_CODE.test(alt.lang)) issues.push({ url: page.finalUrl, kind: 'invalid-code', detail: `hreflang="${alt.lang}" is not a valid language/region code` })
      const target = normalizePageUrl(alt.href, page.finalUrl)
      if (!target) continue
      if (urlKey(target) === own) {
        selfReference = true
        continue
      }
      const other = byUrl.get(urlKey(target))
      if (!other) continue
      const back = other.hreflang.map((a) => normalizePageUrl(a.href, other.finalUrl)).filter((u): u is string => !!u).map(urlKey)
      if (!back.includes(own)) issues.push({ url: page.finalUrl, kind: 'not-reciprocal', detail: `hreflang="${alt.lang}" → ${target}, which does not link back` })
      const primary = alt.lang.toLowerCase().split('-')[0]!
      if (alt.lang.toLowerCase() !== 'x-default' && other.lang && !other.lang.toLowerCase().startsWith(primary)) {
        issues.push({ url: page.finalUrl, kind: 'language-mismatch', detail: `hreflang="${alt.lang}" → ${target}, which declares lang="${other.lang}"` })
      }
    }
    if (!selfReference) issues.push({ url: page.finalUrl, kind: 'no-self-reference', detail: 'The hreflang set does not include the page itself' })
  }
  return issues.slice(0, 40)
}

function missingPairs(html: PageFacts[], prefixes: Set<string>): LocalizationFacts['missingPairs'] {
  if (prefixes.size < 2) return []
  const locales = new Map<string, Set<string>>()
  for (const page of html) {
    let segments: string[]
    try {
      segments = new URL(page.finalUrl).pathname.split('/').filter(Boolean)
    } catch {
      continue
    }
    const locale = segments[0]?.toLowerCase()
    if (!locale || !prefixes.has(locale)) continue
    const rest = `/${segments.slice(1).join('/')}`
    locales.set(rest, (locales.get(rest) ?? new Set()).add(locale))
  }
  const result: LocalizationFacts['missingPairs'] = []
  for (const [path, present] of locales) {
    for (const locale of prefixes) if (!present.has(locale)) result.push({ path, present: [...present], missing: locale })
  }
  return result.slice(0, 20)
}

function untranslatedMetadata(html: PageFacts[]): LocalizationFacts['untranslatedMetadata'] {
  const result: LocalizationFacts['untranslatedMetadata'] = []
  for (const field of ['title', 'description'] as const) {
    const groups = new Map<string, PageFacts[]>()
    for (const page of html) {
      const value = page[field]?.trim()
      if (value) groups.set(value, [...(groups.get(value) ?? []), page])
    }
    for (const [value, pages] of groups) {
      const languages = new Set(pages.map((p) => (p.lang ?? '').toLowerCase().split('-')[0]).filter(Boolean))
      if (languages.size >= 2) result.push({ field, value: value.slice(0, 160), urls: pages.map((p) => p.finalUrl).slice(0, 6) })
    }
  }
  return result.slice(0, 20)
}

function mixedLanguage(html: PageFacts[]): LocalizationFacts['mixedLanguage'] {
  const result: LocalizationFacts['mixedLanguage'] = []
  for (const page of html) {
    const rtl = /^(ar|fa|he|ur)\b/i.test(page.lang ?? '') || page.arabicCharRatio >= 0.4
    if (!rtl) continue
    if ((page.navLatinRatio ?? 0) >= 0.6) result.push({ url: page.finalUrl, area: 'navigation', latinShare: page.navLatinRatio! })
    if ((page.controlsLatinRatio ?? 0) >= 0.6) result.push({ url: page.finalUrl, area: 'controls', latinShare: page.controlsLatinRatio! })
  }
  return result.slice(0, 30)
}

export function analyzeLocalization(pages: PageFacts[]): LocalizationFacts {
  const html = pages.filter((p) => p.status === 200)
  const prefixes = new Set<string>()
  for (const page of html) {
    try {
      const first = new URL(page.finalUrl).pathname.split('/').filter(Boolean)[0]
      if (first && /^[a-z]{2}(-[a-z]{2})?$/i.test(first)) prefixes.add(first.toLowerCase())
    } catch {
      // ignore
    }
  }
  return {
    languages: [...new Set(html.map((p) => p.lang).filter((l): l is string => !!l))],
    pages: html.map((p) => ({
      url: p.finalUrl,
      lang: p.lang,
      dir: p.dir,
      arabicCharRatio: p.arabicCharRatio,
      hreflang: p.hreflang.length,
    })),
    hreflangPages: html.filter((p) => p.hreflang.length > 0).length,
    directionMismatches: html
      .filter(
        (p) =>
          (p.arabicCharRatio >= 0.4 && p.dir?.toLowerCase() !== 'rtl') ||
          (p.arabicCharRatio < 0.1 && p.dir?.toLowerCase() === 'rtl') ||
          (/^ar/i.test(p.lang ?? '') && p.dir?.toLowerCase() !== 'rtl'),
      )
      .map((p) => ({ url: p.finalUrl, lang: p.lang, dir: p.dir, arabicCharRatio: p.arabicCharRatio })),
    missingLang: html.filter((p) => !p.lang).map((p) => p.finalUrl),
    localePathPrefixes: [...prefixes],
    hreflangIssues: hreflangIssues(html),
    missingPairs: missingPairs(html, prefixes),
    untranslatedMetadata: untranslatedMetadata(html),
    mixedLanguage: mixedLanguage(html),
  }
}

/** Picks pages for real-browser inspection: the start page plus a spread of page types. */
export function choosePagesForBrowser(pages: PageFacts[], startUrl: string, count: number): string[] {
  const html = pages.filter((p) => p.status === 200 && (!p.contentType || /html/i.test(p.contentType)))
  const chosen = [html.find((p) => p.depth === 0)?.finalUrl ?? startUrl]
  const sections = new Set<string>()
  const section = (url: string) => {
    try {
      return new URL(url).pathname.split('/').filter(Boolean)[0] ?? '/'
    } catch {
      return '/'
    }
  }
  sections.add(section(chosen[0]!))
  const candidates = [...html].sort((a, b) => a.depth - b.depth || b.wordCount - a.wordCount)
  for (const page of candidates) {
    if (chosen.length >= count) break
    if (chosen.includes(page.finalUrl)) continue
    const key = section(page.finalUrl)
    if (sections.has(key)) continue
    sections.add(key)
    chosen.push(page.finalUrl)
  }
  for (const page of candidates) {
    if (chosen.length >= count) break
    if (!chosen.includes(page.finalUrl)) chosen.push(page.finalUrl)
  }
  return chosen
}
