import type { DashboardSummary } from '@audivra/contracts'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDuration, formatNumber, pluralize } from '@/lib/format'
import { SeverityCountsText } from './signals'

/** One bordered row of cells; five across from md, two per row (last one full width) below. */
const STRIP =
  'grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-5 [&>*:last-child]:col-span-2 md:[&>*:last-child]:col-span-1'

function Kpi({ label, value, detail, hint }: { label: string; value: ReactNode; detail?: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3" title={hint}>
      <div className="truncate text-xs text-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xl font-medium text-foreground tabular-nums">{value}</div>
      <div className="mt-0.5 min-h-4 truncate text-xs text-subtle">{detail}</div>
    </div>
  )
}

/** Compact operational summary: five real counts, each with a one-line basis. */
export function SummaryStrip({ summary }: { summary: DashboardSummary }) {
  const active = summary.running + summary.queued
  const finished = (['completed', 'partial', 'failed', 'cancelled'] as const)
    .filter((status) => summary.statusCounts[status] > 0)
    .map((status) => `${formatNumber(summary.statusCounts[status])} ${status}`)
    .join(' · ')
  const latest = summary.latestFindings
  return (
    <section aria-label="Summary" className={STRIP}>
      <Kpi label="Total audits" value={formatNumber(summary.totalAudits)} detail={finished || null} />
      <Kpi
        label="Active / queued"
        value={formatNumber(active)}
        detail={
          active
            ? [summary.running && `${summary.running} running`, summary.queued && `${summary.queued} queued`].filter(Boolean).join(' · ')
            : summary.hiddenActive
              ? `${pluralize(summary.hiddenActive, 'benchmark audit')} in progress`
              : 'All caught up'
        }
      />
      <Kpi
        label="Websites audited"
        value={formatNumber(summary.websites)}
        hint="Distinct public sites. Local and benchmark targets are not counted."
        detail={summary.localTargets ? `Excludes ${pluralize(summary.localTargets, 'local target')}` : null}
      />
      <Kpi
        label="Findings in latest audits"
        value={latest.websites ? formatNumber(latest.total) : '—'}
        hint="Findings of the latest finished AI audit of each website."
        detail={
          latest.websites ? (
            <SeverityCountsText counts={latest.severity} className="flex-nowrap overflow-hidden" />
          ) : (
            'No finished AI audit of a website yet'
          )
        }
      />
      <Kpi
        label="Average audit duration"
        value={summary.averageDurationMs === null ? '—' : formatDuration(summary.averageDurationMs)}
        hint="Mean wall-clock time of completed AI audits. Baseline-only runs are excluded, and local test runs unless benchmark audits are shown."
        detail={summary.timedAudits ? `Across ${pluralize(summary.timedAudits, 'completed AI audit')}` : 'No completed AI audit yet'}
      />
    </section>
  )
}

export function SummaryStripSkeleton() {
  return (
    <div className={STRIP} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="bg-surface px-4 py-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-6 w-14" />
          <Skeleton className="mt-1.5 h-3 w-28" />
        </div>
      ))}
    </div>
  )
}
