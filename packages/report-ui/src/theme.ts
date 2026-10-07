import type { Severity } from '@audivra/contracts'
import type { Tone } from './format.ts'

/**
 * Colors used by SVG charts. In the app and report the palette points at CSS variables (themed by the
 * host); standalone SVG exports use the concrete light-theme values below. Semantic only: severity
 * colors for severity, good/warning/bad for thresholds, one accent plus neutrals for data series.
 */
export interface ChartPalette {
  fg: string
  muted: string
  subtle: string
  border: string
  borderStrong: string
  bg: string
  bgMuted: string
  accent: string
  accentSoft: string
  tone: Record<Tone, string>
  severity: Record<Severity, string>
  severitySoft: Record<Severity, string>
  /** Ordered data-series colors: accent first, then neutrals. */
  series: string[]
  fontSans: string
  fontMono: string
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

export const CSS_PALETTE: ChartPalette = {
  fg: 'var(--av-fg)',
  muted: 'var(--av-muted)',
  subtle: 'var(--av-subtle)',
  border: 'var(--av-border)',
  borderStrong: 'var(--av-border-strong)',
  bg: 'var(--av-bg)',
  bgMuted: 'var(--av-bg-muted)',
  accent: 'var(--av-accent)',
  accentSoft: 'var(--av-accent-soft)',
  tone: { good: 'var(--av-success)', warning: 'var(--av-medium)', bad: 'var(--av-critical)', neutral: 'var(--av-fg)' },
  severity: Object.fromEntries(SEVERITIES.map((s) => [s, `var(--av-${s})`])) as Record<Severity, string>,
  severitySoft: Object.fromEntries(SEVERITIES.map((s) => [s, `var(--av-${s}-soft)`])) as Record<Severity, string>,
  series: ['var(--av-accent)', 'var(--av-muted)', 'var(--av-subtle)', 'var(--av-border-strong)', 'var(--av-accent-soft)', 'var(--av-fg)'],
  fontSans: 'var(--av-font-sans)',
  fontMono: 'var(--av-font-mono)',
}

/** Concrete light-theme token values (sRGB approximations of the oklch tokens) for SVG export. */
export const EXPORT_PALETTE: ChartPalette = {
  fg: '#1b1d22',
  muted: '#5b606a',
  subtle: '#868b94',
  border: '#e3e5e9',
  borderStrong: '#d1d4da',
  bg: '#ffffff',
  bgMuted: '#f6f7f9',
  accent: '#2f5ccf',
  accentSoft: '#dfe6f8',
  tone: { good: '#1e8551', warning: '#a5741a', bad: '#c8302a', neutral: '#1b1d22' },
  severity: { critical: '#c8302a', high: '#c8571b', medium: '#a5741a', low: '#2d68b8', info: '#676c76' },
  severitySoft: { critical: '#fdeceb', high: '#fdefe6', medium: '#fbf3dc', low: '#eaf1fb', info: '#f0f1f3' },
  series: ['#2f5ccf', '#5b606a', '#868b94', '#d1d4da', '#dfe6f8', '#1b1d22'],
  fontSans: "'Inter Variable', 'Inter', 'Segoe UI', system-ui, sans-serif",
  fontMono: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
}

const SEVERITY_NAMES = new Set<string>(SEVERITIES)

/** Segment color: semantic severity colors when the label is a severity, otherwise the series order. */
export function segmentColor(palette: ChartPalette, label: string, index: number): string {
  const key = label.trim().toLowerCase()
  if (SEVERITY_NAMES.has(key)) return palette.severity[key as Severity]
  return palette.series[index % palette.series.length] ?? palette.accent
}
