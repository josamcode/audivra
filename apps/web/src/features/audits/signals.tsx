import type { SeverityCounts, SeverityPoint, TrendDirection } from '@audivra/contracts'
import { ArrowDownRight, ArrowRight, ArrowUpRight, FlaskConical, Globe, Laptop } from 'lucide-react'
import { SEVERITY_LABEL } from '@/components/badges'
import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/*
 * Small visual signals shared by the Audits home screen: a neutral site mark, the severity history of
 * a site and its direction. All of them render real audit data only.
 */

/**
 * Neutral visual anchor for a site: the domain initial, a lab flask for benchmark fixtures, a laptop
 * for local targets and a globe for bare IP addresses. Favicons are not fetched from the sites.
 */
export function SiteMark({
  domain,
  benchmark = false,
  local = false,
  className,
}: {
  domain: string
  benchmark?: boolean
  local?: boolean
  className?: string
}) {
  const host = domain.replace(/^www\./, '')
  const Icon = benchmark ? FlaskConical : local ? Laptop : /^[\d.:[\]]+$/.test(host) ? Globe : null
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-muted text-xs font-semibold text-muted uppercase',
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5" /> : host.charAt(0)}
    </span>
  )
}

/** "Benchmark" / "Local" tag shown next to a domain. */
export function TargetTag({ benchmark, local }: { benchmark: boolean; local: boolean }) {
  if (benchmark) {
    return (
      <Badge tone="neutral" title="Benchmark fixture audit (System → Quality); not part of normal history">
        Benchmark
      </Badge>
    )
  }
  if (local) {
    return (
      <Badge tone="neutral" title="Local or private-network target; not counted as a website or used for follow-ups">
        Local
      </Badge>
    )
  }
  return null
}

const SEVERITY_TEXT = { critical: 'text-critical', high: 'text-high', medium: 'text-medium', low: 'text-low' } as const

/** "1 high  1 medium  10 low": counts coloured by severity, always with their label. Info notes are left out. */
export function SeverityCountsText({ counts, className }: { counts: SeverityCounts; className?: string }) {
  const levels = (['critical', 'high', 'medium', 'low'] as const).filter((level) => counts[level] > 0)
  if (levels.length === 0) {
    return <span className={cn('text-xs text-subtle', className)}>{counts.info ? `${counts.info} info` : 'No issues'}</span>
  }
  return (
    <span className={cn('flex flex-wrap items-baseline gap-x-2 text-xs text-muted', className)}>
      {levels.map((level) => (
        <span key={level} className="whitespace-nowrap">
          <span className={cn('font-mono font-medium tabular-nums', SEVERITY_TEXT[level])}>{counts[level]}</span>{' '}
          {SEVERITY_LABEL[level].toLowerCase()}
        </span>
      ))}
    </span>
  )
}

const issueCount = (counts: SeverityCounts) => counts.critical + counts.high + counts.medium + counts.low

/**
 * Severity history: one bar per finished AI audit (oldest → newest), height ∝ issues, split into
 * critical/high, medium and low. The latest audit is drawn at full strength.
 */
export function SeverityBars({ points, className }: { points: SeverityPoint[]; className?: string }) {
  const max = Math.max(1, ...points.map((p) => issueCount(p.counts)))
  return (
    <span className={cn('flex h-5 shrink-0 items-end gap-0.5', className)} aria-hidden>
      {points.map((p, index) => {
        const total = issueCount(p.counts)
        const serious = p.counts.critical + p.counts.high
        return (
          <span
            key={p.auditId}
            className={cn(
              'flex w-1 flex-col overflow-hidden rounded-full',
              total === 0 && 'bg-border-strong',
              index < points.length - 1 && 'opacity-55',
            )}
            style={{ height: total ? `${Math.max(15, (total / max) * 100)}%` : '2px' }}
          >
            {serious ? <span className={p.counts.critical ? 'bg-critical' : 'bg-high'} style={{ flexGrow: serious }} /> : null}
            {p.counts.medium ? <span className="bg-medium" style={{ flexGrow: p.counts.medium }} /> : null}
            {p.counts.low ? <span className="bg-border-strong" style={{ flexGrow: p.counts.low }} /> : null}
          </span>
        )
      })}
    </span>
  )
}

const TREND: Record<TrendDirection, { label: string; icon: typeof ArrowRight; className: string }> = {
  improving: { label: 'Improving', icon: ArrowDownRight, className: 'text-success' },
  stable: { label: 'Stable', icon: ArrowRight, className: 'text-muted' },
  regressing: { label: 'Regressing', icon: ArrowUpRight, className: 'text-critical' },
}

/** Direction in words with an arrow (never colour alone). */
export function TrendLabel({ direction, className }: { direction: TrendDirection; className?: string }) {
  const config = TREND[direction]
  const Icon = config.icon
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap', config.className, className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {config.label}
    </span>
  )
}

/** Plain-language basis of a direction: the counts that decided it and the audit compared with. */
export function trendHint(previous: SeverityPoint, current: SeverityPoint): string {
  const serious = (p: SeverityPoint) => p.counts.critical + p.counts.high
  return `Compared with the audit of ${formatDateTime(previous.createdAt)}: critical + high ${serious(previous)} → ${serious(current)}, medium ${previous.counts.medium} → ${current.counts.medium}. Low and info findings do not change the direction.`
}
