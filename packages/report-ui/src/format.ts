import type { Datum, ValueUnit } from '@audivra/contracts'

export type Tone = 'good' | 'warning' | 'bad' | 'neutral'

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** Formats a number for display in its unit. Deterministic (fixed locale) so SSR and app agree. */
export function formatValue(value: number, unit: ValueUnit = 'none'): string {
  if (!Number.isFinite(value)) return '–'
  switch (unit) {
    case 'ms':
      if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(Math.abs(value) >= 10000 ? 0 : 1)} s`
      return `${intFormat.format(Math.round(value))} ms`
    case 's':
      return `${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)} s`
    case 'score': {
      const score = value > 0 && value <= 1 && !Number.isInteger(value) ? value * 100 : value
      return intFormat.format(Math.round(score))
    }
    case 'count':
      return intFormat.format(Math.round(value))
    case 'bytes':
      if (Math.abs(value) < 1024) return `${intFormat.format(Math.round(value))} B`
      if (Math.abs(value) < 1024 * 1024) return `${intFormat.format(Math.round(value / 1024))} KB`
      return `${trimZeros((value / (1024 * 1024)).toFixed(1))} MB`
    case 'kb':
      if (Math.abs(value) < 1024) return `${intFormat.format(Math.round(value))} KB`
      return `${trimZeros((value / 1024).toFixed(1))} MB`
    case 'percent':
      return `${trimZeros(value.toFixed(Math.abs(value) >= 10 ? 0 : 1))}%`
    case 'px':
      return `${intFormat.format(Math.round(value))} px`
    case 'ratio':
      return trimZeros(value.toFixed(2))
    case 'days':
      return `${intFormat.format(Math.round(value))} ${Math.round(value) === 1 ? 'day' : 'days'}`
    default:
      if (Number.isInteger(value)) return intFormat.format(value)
      return trimZeros(value.toFixed(Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 3))
  }
}

export function formatDatum(datum: Pick<Datum, 'value' | 'unit'>): string {
  return formatValue(datum.value, datum.unit)
}

/** Compact signed delta for comparisons ("+0.4 s", "−3"). */
export function formatDelta(delta: number, unit: ValueUnit = 'none'): string {
  if (delta === 0) return '±0'
  const sign = delta > 0 ? '+' : '−'
  return `${sign}${formatValue(Math.abs(delta), unit)}`
}

/** Documented Lighthouse / Core Web Vitals thresholds used for tones. */
export const METRIC_THRESHOLDS: Record<string, { good: number; poor: number; higherIsBetter: boolean }> = {
  performance: { good: 90, poor: 50, higherIsBetter: true },
  accessibility: { good: 90, poor: 50, higherIsBetter: true },
  seo: { good: 90, poor: 50, higherIsBetter: true },
  bestPractices: { good: 90, poor: 50, higherIsBetter: true },
  lcp: { good: 2500, poor: 4000, higherIsBetter: false },
  fcp: { good: 1800, poor: 3000, higherIsBetter: false },
  cls: { good: 0.1, poor: 0.25, higherIsBetter: false },
  tbt: { good: 200, poor: 600, higherIsBetter: false },
}

export function thresholdTone(metric: string, value: number | null | undefined, unit?: ValueUnit): Tone {
  const t = METRIC_THRESHOLDS[metric]
  if (!t || value == null || !Number.isFinite(value)) return 'neutral'
  let v = value
  if (unit === 's' && (metric === 'lcp' || metric === 'fcp' || metric === 'tbt')) v = value * 1000
  if (unit === 'score' && v > 0 && v <= 1 && !Number.isInteger(v)) v = v * 100
  if (t.higherIsBetter) return v >= t.good ? 'good' : v >= t.poor ? 'warning' : 'bad'
  return v <= t.good ? 'good' : v <= t.poor ? 'warning' : 'bad'
}

/** Short display form of a URL: path (+query) for same-site pages, host+path otherwise. */
export function shortUrl(url: string, max = 64): string {
  let text = url
  try {
    const u = new URL(url)
    const path = `${u.pathname}${u.search}`
    text = path && path !== '/' ? path : `${u.host}/`
  } catch {
    // keep raw
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "7 Oct 2026" — fixed format (UTC) so server and browser render identical text. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '–'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '–'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** Approximate text width (px) for SVG layout without DOM measurement. */
export function approxTextWidth(text: string, fontSize: number): number {
  let units = 0
  for (const ch of text) {
    if (/[ilI.,:;'|!]/.test(ch)) units += 0.3
    else if (/[mwMW@]/.test(ch)) units += 0.85
    else if (/[A-Z0-9]/.test(ch)) units += 0.64
    else if (ch === ' ') units += 0.3
    else units += 0.55
  }
  return units * fontSize
}

export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (approxTextWidth(text, fontSize) <= maxWidth) return text
  let out = text
  while (out.length > 1 && approxTextWidth(`${out}…`, fontSize) > maxWidth) out = out.slice(0, -1)
  return `${out.trimEnd()}…`
}
