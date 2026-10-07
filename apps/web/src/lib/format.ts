const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const integer = new Intl.NumberFormat()

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—'
}

export function formatTime(iso: string): string {
  return timeOnly.format(new Date(iso))
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return 'just now'
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86400 * 30) return relative.format(Math.round(seconds / 86400), 'day')
  return formatDateTime(iso)
}

/** Human duration, e.g. "42s", "6m 12s", "1h 04m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function durationBetween(start: string | null, end: string | null, now = Date.now()): number | null {
  if (!start) return null
  const finish = end ? new Date(end).getTime() : now
  return finish - new Date(start).getTime()
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s` : `${Math.round(ms)} ms`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : integer.format(value)
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`
}

/** Lighthouse-style 0..1 or 0..100 score rendered as 0..100. */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return String(Math.round(value <= 1 ? value * 100 : value))
}

export function formatCost(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? '—' : `$${usd.toFixed(usd < 1 ? 3 : 2)}`
}

/** Path portion of a URL for compact table cells ("/pricing"), falling back to the input. */
export function urlPath(url: string): string {
  try {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}`
    return path === '/' ? '/' : path.replace(/\/$/, '')
  } catch {
    return url
  }
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function titleCase(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`
}

const ACRONYMS = new Set([
  'cls',
  'lcp',
  'fcp',
  'tbt',
  'ttfb',
  'tti',
  'seo',
  'url',
  'urls',
  'http',
  'https',
  'tls',
  'ssl',
  'dom',
  'id',
  'ids',
  'csp',
  'hsts',
  'kb',
  'mb',
  'js',
  'css',
  'html',
  'json',
  'api',
  'cta',
  'ga4',
  'gtm',
  'ui',
  'ux',
  'ai',
  'a11y',
])

/** Turns metadata keys like `lcpMs`, `speed_index`, `bytesByType` into readable labels ("LCP (ms)"). */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
  const out: string[] = []
  for (const [index, word] of words.entries()) {
    const lower = word.toLowerCase()
    if (index > 0 && (lower === 'ms' || lower === 'kb' || lower === 'mb') && words.length > 1) {
      out.push(`(${lower === 'ms' ? 'ms' : lower.toUpperCase()})`)
    } else if (ACRONYMS.has(lower)) {
      out.push(lower === 'a11y' ? 'A11y' : lower.toUpperCase())
    } else {
      out.push(index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower)
    }
  }
  return out.join(' ')
}
