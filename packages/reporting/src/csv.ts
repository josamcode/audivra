import { pagePath, type AuditData } from '@audivra/insights'

/** RFC 4180 CSV: fields quoted when needed, CRLF line endings, UTF-8 BOM for spreadsheet apps. */
export function toCsv(header: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const cell = (value: string | number | boolean | null | undefined) => {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function findingsCsv(data: AuditData): string {
  return toCsv(
    ['ref', 'severity', 'category', 'title', 'type', 'confidence', 'verification', 'affected_urls', 'evidence', 'observed', 'why_it_matters', 'business_impact', 'recommendation', 'effort', 'issue_key'],
    data.findings.map((f) => [
      f.ref,
      f.severity,
      f.category,
      f.title,
      f.type,
      f.confidence,
      f.verificationStatus,
      f.affectedUrls.join(' '),
      f.evidenceRefs.join(' '),
      f.observed,
      f.whyItMatters,
      f.businessImpact,
      f.recommendation,
      f.effort,
      f.issueKey,
    ]),
  )
}

export function pagesCsv(data: AuditData): string {
  return toCsv(
    ['url', 'status', 'title', 'page_type', 'lang', 'dir', 'depth', 'source', 'inspected_in_browser', 'findings'],
    data.pages.map((p) => [p.url, p.status, p.title, p.pageType, p.lang, p.dir, p.depth, p.source, p.inspectedInBrowser, p.findingCount]),
  )
}

const PERF_COLUMNS: [string, string][] = [
  ['performance', 'performance_score'],
  ['accessibility', 'accessibility_score'],
  ['bestPractices', 'best_practices_score'],
  ['seo', 'seo_score'],
  ['lcp', 'lcp_ms'],
  ['fcp', 'fcp_ms'],
  ['tbt', 'tbt_ms'],
  ['cls', 'cls'],
  ['si', 'speed_index_ms'],
  ['weight', 'weight_bytes'],
]

/** One row per page × form factor with Lighthouse lab metrics, plus browser load metrics when present. */
export function performanceCsv(data: AuditData): string | null {
  const rows = new Map<string, Record<string, number | string>>()
  for (const entry of data.catalog) {
    const lighthouse = entry.key.match(/^lighthouse:(.+):(mobile|desktop):(\w+)$/)
    const browser = entry.key.match(/^browser:(.+):(mobile|desktop):(\w+)$/)
    const match = lighthouse ?? browser
    if (!match) continue
    const [, path, formFactor, metric] = match as unknown as [string, string, string, string]
    const id = `${path}|${formFactor}`
    const row = rows.get(id) ?? { page: path, form_factor: formFactor }
    if (lighthouse) {
      const column = PERF_COLUMNS.find(([key]) => key === metric)?.[1]
      if (column) row[column] = entry.value
      row.lighthouse_evidence = entry.evidenceId
    } else {
      row[`browser_${metric}`] = entry.value
    }
    rows.set(id, row)
  }
  if (rows.size === 0) return null
  const browserColumns = ['browser_ttfb', 'browser_dcl', 'browser_load', 'browser_lcp', 'browser_cls', 'browser_requests', 'browser_transfer', 'browser_thirdParties']
  const header = ['page', 'form_factor', ...PERF_COLUMNS.map(([, c]) => c), ...browserColumns, 'lighthouse_evidence']
  return toCsv(
    header,
    [...rows.values()].sort((a, b) => String(a.page).localeCompare(String(b.page))).map((row) => header.map((h) => row[h] ?? null)),
  )
}

/** Broken links from the baseline link check (null when there are none). */
export function brokenLinksCsv(data: AuditData): string | null {
  const links = data.evidence.find((e) => 'checked' in e.metadata && Array.isArray(e.metadata.broken))
  const broken = (links?.metadata.broken as { url: string; status: number | null; error: string | null; kind: string; internal: boolean; foundOn?: string[] }[] | undefined) ?? []
  if (broken.length === 0) return null
  return toCsv(
    ['url', 'status', 'error', 'kind', 'internal', 'found_on', 'evidence'],
    broken.map((b) => [b.url, b.status, b.error, b.kind, b.internal, (b.foundOn ?? []).map((u) => pagePath(u)).join(' '), links!.ref]),
  )
}
