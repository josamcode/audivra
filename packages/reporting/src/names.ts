import type { ExportKind } from '@audivra/contracts'

/** Short, readable slug for file names: "josamcode.com" → "josamcode", "books.toscrape.com" → "books-toscrape". */
export function siteSlug(domain: string): string {
  const host = domain.toLowerCase().replace(/^www\./, '')
  const [name, port] = host.split(':') as [string, string | undefined]
  const isIp = /^[\d.]+$/.test(name) || name === 'localhost'
  const labels = name.split('.').filter(Boolean)
  const core = isIp || labels.length < 2 ? labels : labels.slice(0, -1)
  const slug = [...core, ...(port ? [port] : [])]
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, 60) || 'site'
}

export const EXPORT_META: Record<ExportKind, { label: string; suffix: string; contentType: string }> = {
  pdf: { label: 'Client report (PDF)', suffix: 'audivra-report.pdf', contentType: 'application/pdf' },
  html: { label: 'Client report (HTML)', suffix: 'audivra-report.html', contentType: 'text/html; charset=utf-8' },
  json: { label: 'Audit data (JSON)', suffix: 'audivra-audit.json', contentType: 'application/json; charset=utf-8' },
  'csv-findings': { label: 'Findings (CSV)', suffix: 'findings.csv', contentType: 'text/csv; charset=utf-8' },
  'csv-pages': { label: 'Pages (CSV)', suffix: 'pages.csv', contentType: 'text/csv; charset=utf-8' },
  'csv-performance': { label: 'Performance (CSV)', suffix: 'performance.csv', contentType: 'text/csv; charset=utf-8' },
  'csv-broken-links': { label: 'Broken links (CSV)', suffix: 'broken-links.csv', contentType: 'text/csv; charset=utf-8' },
  bundle: { label: 'Complete audit bundle (ZIP)', suffix: 'audivra-audit.zip', contentType: 'application/zip' },
}

export function exportFilename(domain: string, kind: ExportKind): string {
  return `${siteSlug(domain)}-${EXPORT_META[kind].suffix}`
}
