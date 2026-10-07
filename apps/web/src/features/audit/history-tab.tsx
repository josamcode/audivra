import {
  MIN_TREND_POINTS,
  type AuditComparison,
  type AuditDetail,
  type FindingChange,
  type FindingChangeStatus,
  type MetricChange,
  type ScreenshotPair,
  type SiteHistory,
} from '@audivra/contracts'
import { CSS_PALETTE, formatDelta, formatValue, LineChart } from '@audivra/report-ui'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, GitCompareArrows, History as HistoryIcon, ImageOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { COVERAGE_STATUS, SEVERITY_LABEL, SeverityBadge, StatusBadge } from '@/components/badges'
import { CountCell } from '@/components/metric'
import { Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { tagVariants } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { useAuditNav } from '@/features/audit/audit-nav'
import { artifactUrl, ApiError } from '@/lib/api'
import { formatDateTime, pluralize, urlPath } from '@/lib/format'
import { comparisonQuery, isFinished, siteHistoryQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const CHANGE: Record<FindingChangeStatus, { label: string; tone: string; hint: string }> = {
  regressed: { label: 'Regressed', tone: 'text-critical', hint: 'Still present and more severe than before' },
  new: { label: 'New', tone: 'text-high', hint: 'Not found in the earlier audit' },
  improved: { label: 'Improved', tone: 'text-low', hint: 'Still present but less severe' },
  resolved: { label: 'Resolved', tone: 'text-success', hint: 'Found earlier, not found now' },
  unchanged: { label: 'Unchanged', tone: 'text-muted', hint: 'Present in both audits at the same severity' },
}

const GROUP_ORDER: FindingChangeStatus[] = ['regressed', 'new', 'improved', 'resolved', 'unchanged']

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/* ------------------------------------------------------------------------------------------------ */

function ChangeSummary({ comparison }: { comparison: AuditComparison }) {
  return (
    <section
      aria-label="Change summary"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1"
    >
      {GROUP_ORDER.map((status) => {
        const count = comparison.summary[status]
        return (
          <div key={status} className="min-w-0 bg-surface px-4 py-3" title={CHANGE[status].hint}>
            <div className="text-xs text-muted">{CHANGE[status].label}</div>
            <div
              className={cn(
                'mt-1 font-mono text-xl font-medium tabular-nums',
                count ? CHANGE[status].tone : 'text-subtle',
              )}
            >
              {count}
            </div>
            <div className="mt-0.5 truncate text-xs text-subtle">{CHANGE[status].hint}</div>
          </div>
        )
      })}
    </section>
  )
}

function FindingChangeRow({
  change,
  previousAuditId,
  onOpenFinding,
}: {
  change: FindingChange
  previousAuditId: string
  onOpenFinding: (ref: string) => void
}) {
  const subject = change.current ?? change.previous
  if (!subject) return null
  const severityChanged =
    change.current && change.previous && change.current.severity !== change.previous.severity
  return (
    <li className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
      <SeverityBadge severity={subject.severity} className="mt-px" />
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm text-foreground', change.status === 'resolved' && 'text-muted')}>{subject.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <span>{subject.category}</span>
          {severityChanged ? (
            <span>
              <span className="text-subtle">·</span> {SEVERITY_LABEL[change.previous!.severity]} →{' '}
              <span className="text-foreground">{SEVERITY_LABEL[change.current!.severity]}</span>
            </span>
          ) : null}
          {change.matchedBy ? (
            <span className="text-subtle">
              · matched by {change.matchedBy === 'issue-key' ? 'issue key' : 'similarity'}
              {change.matchedBy === 'similarity' && change.matchScore !== null
                ? ` (${Math.round(change.matchScore * 100)}%)`
                : ''}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {change.previous ? (
          <Link
            to="/audits/$auditId"
            params={{ auditId: previousAuditId }}
            search={{ finding: change.previous.ref }}
            className={tagVariants({ kind: 'ref' })}
            title="Finding in the earlier audit"
          >
            was {change.previous.ref}
          </Link>
        ) : null}
        {change.current ? (
          <button
            type="button"
            onClick={() => onOpenFinding(change.current!.ref)}
            className={tagVariants({ kind: 'ref' })}
            title="Open finding"
          >
            {change.current.ref}
          </button>
        ) : null}
      </div>
    </li>
  )
}

function FindingChanges({
  comparison,
  onOpenFinding,
}: {
  comparison: AuditComparison
  onOpenFinding: (ref: string) => void
}) {
  const [showUnchanged, setShowUnchanged] = useState(false)
  const groups = GROUP_ORDER.map((status) => ({
    status,
    items: comparison.findings.filter((change) => change.status === status),
  })).filter((group) => group.items.length)
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Finding changes"
        description="Matched by stable issue key, or by similarity of title, category and pages"
      />
      {groups.length === 0 ? (
        <EmptyState compact title="Neither audit has findings" />
      ) : (
        groups.map((group) => {
          const collapsed = group.status === 'unchanged' && !showUnchanged
          return (
            <section key={group.status} className="border-b border-border last:border-b-0">
              <div className="flex h-9 items-center gap-2 border-b border-border bg-surface-muted px-4">
                <span className={cn('text-sm font-medium', CHANGE[group.status].tone)}>{CHANGE[group.status].label}</span>
                <span className="font-mono text-2xs text-subtle tabular-nums">{group.items.length}</span>
                {group.status === 'unchanged' ? (
                  <button
                    type="button"
                    onClick={() => setShowUnchanged((v) => !v)}
                    aria-expanded={showUnchanged}
                    className="ml-auto cursor-pointer text-xs text-muted hover:text-foreground"
                  >
                    {showUnchanged ? 'Hide' : 'Show'}
                  </button>
                ) : null}
              </div>
              {collapsed ? null : (
                <ul>
                  {group.items.map((change, index) => (
                    <FindingChangeRow
                      key={`${change.current?.ref ?? ''}-${change.previous?.ref ?? ''}-${index}`}
                      change={change}
                      previousAuditId={comparison.previous.id}
                      onOpenFinding={onOpenFinding}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
    </Panel>
  )
}

function MetricDeltaCell({ metric }: { metric: MetricChange }) {
  if (metric.delta === null || metric.direction === 'new' || metric.direction === 'missing') {
    return (
      <span className="text-xs text-subtle">
        {metric.direction === 'new' ? 'New measurement' : metric.direction === 'missing' ? 'Not measured now' : '—'}
      </span>
    )
  }
  if (metric.direction === 'unchanged') {
    return metric.delta === 0 ? (
      <span className="text-xs text-subtle">No change</span>
    ) : (
      <span className="font-mono text-xs text-subtle tabular-nums">
        {formatDelta(metric.delta, metric.unit)}
        <span className="ml-1.5 font-sans text-2xs">within normal variation</span>
      </span>
    )
  }
  const improved = metric.direction === 'improved'
  return (
    <span className={cn('font-mono text-xs tabular-nums', improved ? 'text-success' : 'text-critical')}>
      {formatDelta(metric.delta, metric.unit)}
      <span className="ml-1.5 font-sans text-2xs">{improved ? 'improved' : 'worse'}</span>
    </span>
  )
}

function MetricChanges({ comparison }: { comparison: AuditComparison }) {
  if (!comparison.metrics.length) return null
  const changed = comparison.metrics.filter((m) => m.direction === 'improved' || m.direction === 'regressed').length
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Measurements"
        description={
          changed
            ? `${pluralize(changed, 'measurement')} changed beyond normal lab variation`
            : 'No measurement changed beyond normal lab variation'
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="h-8 bg-surface-muted px-3 pl-4 text-left text-xs font-medium text-muted">
                Metric
              </th>
              <th scope="col" className="h-8 bg-surface-muted px-3 text-right text-xs font-medium text-muted">
                Before
              </th>
              <th scope="col" className="h-8 bg-surface-muted px-3 text-right text-xs font-medium text-muted">
                Now
              </th>
              <th scope="col" className="h-8 bg-surface-muted px-3 pr-4 text-left text-xs font-medium text-muted">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison.metrics.map((metric) => (
              <tr key={metric.key} className="border-b border-border last:border-b-0">
                <th scope="row" className="h-9 px-3 pl-4 text-left font-normal text-foreground">
                  {metric.label}
                  {metric.lowerIsBetter ? <span className="ml-1.5 text-2xs text-subtle">lower is better</span> : null}
                </th>
                <td className="px-3 text-right font-mono text-xs text-muted tabular-nums">
                  {metric.before === null ? '—' : formatValue(metric.before, metric.unit)}
                </td>
                <td className="px-3 text-right font-mono text-xs text-foreground tabular-nums">
                  {metric.after === null ? '—' : formatValue(metric.after, metric.unit)}
                </td>
                <td className="px-3 pr-4">
                  <MetricDeltaCell metric={metric} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function StackChanges({ comparison }: { comparison: AuditComparison }) {
  const { added, removed, unchanged } = comparison.technologies
  const coverage = comparison.coverage.filter((item) => item.before !== item.after)
  return (
    <Panel>
      <PanelHeader title="Technology & coverage" description="What the audits detected and ran" />
      <PanelBody className="flex flex-col gap-4">
        <div>
          <SectionLabel>Technologies</SectionLabel>
          {added.length || removed.length ? (
            <div className="flex flex-col gap-2 text-sm">
              {added.length ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-xs text-muted">Now detected</span>
                  {added.map((name) => (
                    <span key={name} className={tagVariants({ kind: 'label' })}>
                      {name}
                    </span>
                  ))}
                </div>
              ) : null}
              {removed.length ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-xs text-muted">No longer detected</span>
                  {removed.map((name) => (
                    <span key={name} className={cn(tagVariants({ kind: 'label' }), 'text-muted line-through')}>
                      {name}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="text-xs text-subtle">
                {pluralize(unchanged.length, 'technology', 'technologies')} unchanged. Names come from each audit’s
                detection, so rewording can appear as a change.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">Same technologies detected ({unchanged.length}).</p>
          )}
        </div>
        <div>
          <SectionLabel>Coverage</SectionLabel>
          {coverage.length ? (
            <ul className="flex flex-col gap-1 text-sm">
              {coverage.map((item) => (
                <li key={item.capability} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-foreground">{item.label}</span>
                  <span className="text-xs text-muted">
                    {item.before ? COVERAGE_STATUS[item.before].label : 'Not recorded'} →{' '}
                    <span className="text-foreground">
                      {item.after ? COVERAGE_STATUS[item.after].label : 'Not recorded'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Both audits covered the same capabilities.</p>
          )}
        </div>
      </PanelBody>
    </Panel>
  )
}

function Shot({ label, auditId, path, date }: { label: string; auditId: string; path: string; date: string }) {
  const [failed, setFailed] = useState(false)
  const src = artifactUrl(auditId, path)
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-subtle">{shortDate(date)}</span>
      </figcaption>
      {failed ? (
        <div className="flex aspect-video items-center justify-center gap-2 rounded-md border border-dashed border-border text-xs text-muted">
          <ImageOff className="size-4" />
          Screenshot unavailable
        </div>
      ) : (
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-md border border-border bg-surface-muted"
          aria-label={`${label} screenshot, opens full size`}
        >
          <img
            src={src}
            alt={`${label} screenshot`}
            loading="lazy"
            onError={() => setFailed(true)}
            className="mx-auto block max-h-80 w-auto max-w-full object-contain object-top"
          />
        </a>
      )}
    </figure>
  )
}

function ScreenshotPairs({ pairs }: { pairs: ScreenshotPair[] }) {
  if (!pairs.length) return null
  return (
    <Panel>
      <PanelHeader
        title="Before / after"
        description="Same page and viewport, captured by the baseline in each audit"
      />
      <PanelBody className="grid gap-6 xl:grid-cols-2">
        {pairs.map((pair) => (
          <div key={`${pair.url}-${pair.viewport}`} className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-xs text-foreground">{urlPath(pair.url)}</span>
              <span className="shrink-0 text-xs text-subtle">{pair.viewport}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Shot label="Before" auditId={pair.before.auditId} path={pair.before.artifactPath} date={pair.before.date} />
              <Shot label="After" auditId={pair.after.auditId} path={pair.after.artifactPath} date={pair.after.date} />
            </div>
          </div>
        ))}
      </PanelBody>
    </Panel>
  )
}

function Trends({ history }: { history: SiteHistory }) {
  const series = history.series.filter((s) => s.points.length >= MIN_TREND_POINTS)
  if (!series.length) return null
  return (
    <Panel>
      <PanelHeader
        title="Trends"
        description={`Measured values from ${pluralize(history.audits.length, 'audit')} of this site — nothing estimated between audits`}
      />
      <PanelBody className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
        {series.map((s) => {
          const points = s.points.map((p) => ({ x: p.at, value: p.value, auditId: p.auditId }))
          const last = points[points.length - 1]
          return (
            <figure key={s.key} className="m-0 min-w-0">
              <figcaption className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-sm text-foreground">{s.label}</span>
                <span className="shrink-0 font-mono text-xs text-muted tabular-nums">
                  {last ? formatValue(last.value, s.unit) : '—'}
                </span>
              </figcaption>
              <LineChart
                series={[{ label: s.label, points }]}
                unit={s.unit}
                palette={CSS_PALETTE}
                lowerIsBetter={s.lowerIsBetter}
                height={170}
                width={380}
              />
            </figure>
          )
        })}
      </PanelBody>
    </Panel>
  )
}

function SiteAudits({
  history,
  currentId,
  comparedId,
}: {
  history: SiteHistory
  currentId: string
  comparedId: string | null
}) {
  const audits = [...history.audits].reverse()
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Audits of this site" description={history.siteKey} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              {['Date', 'Status', 'Critical', 'High', 'Medium', 'Findings', ''].map((label, index) => (
                <th
                  key={index}
                  scope="col"
                  className={cn(
                    'h-8 bg-surface-muted px-3 text-xs font-medium whitespace-nowrap text-muted first:pl-4 last:pr-4',
                    index >= 2 && index <= 5 ? 'text-right' : 'text-left',
                    index >= 2 && index <= 4 && 'hidden sm:table-cell',
                  )}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {audits.map((item) => {
              const current = item.id === currentId
              return (
                <tr key={item.id} className={cn('border-b border-border last:border-b-0', current && 'bg-surface-selected')}>
                  <td className="h-10 px-3 pl-4 whitespace-nowrap">
                    {current ? (
                      <span className="text-foreground">{formatDateTime(item.createdAt)}</span>
                    ) : (
                      <Link
                        to="/audits/$auditId"
                        params={{ auditId: item.id }}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {formatDateTime(item.createdAt)}
                      </Link>
                    )}
                  </td>
                  <td className="px-3">
                    <StatusBadge status={item.status as AuditDetail['status']} />
                  </td>
                  <td className="hidden px-3 text-right sm:table-cell">
                    <CountCell value={item.severityCounts.critical ?? 0} tone="critical" />
                  </td>
                  <td className="hidden px-3 text-right sm:table-cell">
                    <CountCell value={item.severityCounts.high ?? 0} tone="high" />
                  </td>
                  <td className="hidden px-3 text-right sm:table-cell">
                    <CountCell value={item.severityCounts.medium ?? 0} tone="medium" />
                  </td>
                  <td className="px-3 text-right">
                    <CountCell value={item.findingCount} tone="default" />
                  </td>
                  <td className="px-3 pr-4 text-right text-xs whitespace-nowrap text-subtle">
                    {current ? 'This audit' : item.id === comparedId ? 'Compared' : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function FirstAudit({ audit, children }: { audit: AuditDetail; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <EmptyState
          icon={HistoryIcon}
          title={isFinished(audit.status) ? `First completed audit of ${audit.domain}` : 'History needs a finished audit'}
          description={
            isFinished(audit.status)
              ? 'Run another audit of this site later to see resolved, new, improved and regressed findings, measurement changes, before/after screenshots and trends.'
              : 'Comparison and trends become available when this audit completes.'
          }
        />
      </Panel>
      {children}
    </div>
  )
}

export function HistoryTab({
  audit,
  compareWith,
  onCompareWith,
}: {
  audit: AuditDetail
  compareWith: string | undefined
  onCompareWith: (id: string | undefined) => void
}) {
  const nav = useAuditNav()
  const finished = isFinished(audit.status)
  const history = useQuery({ ...siteHistoryQuery(audit.siteKey), enabled: finished })
  const earlier = (history.data?.audits ?? []).filter(
    (item) => item.id !== audit.id && new Date(item.createdAt) < new Date(audit.createdAt),
  )
  const canCompare = finished && (audit.previousAuditId !== null || earlier.length > 0)
  const comparison = useQuery({
    ...comparisonQuery(audit.id, compareWith),
    enabled: canCompare,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  })

  if (!canCompare) {
    return (
      <FirstAudit audit={audit}>
        {history.data && history.data.audits.length > 1 ? (
          <SiteAudits history={history.data} currentId={audit.id} comparedId={null} />
        ) : null}
      </FirstAudit>
    )
  }

  const compared = comparison.data?.previous.id ?? compareWith ?? audit.previousAuditId
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <GitCompareArrows className="size-4 text-subtle" aria-hidden />
        <span className="text-sm text-muted">Comparing this audit with</span>
        {earlier.length > 1 ? (
          <Select
            label="Earlier audit"
            value={compared ?? ''}
            onValueChange={(id) => onCompareWith(id === audit.previousAuditId ? undefined : id)}
            options={[...earlier].reverse().map((item) => ({
              value: item.id,
              label: `${shortDate(item.createdAt)} · ${pluralize(item.findingCount, 'finding')}`,
            }))}
          />
        ) : comparison.data ? (
          <Link
            to="/audits/$auditId"
            params={{ auditId: comparison.data.previous.id }}
            className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:underline"
          >
            {formatDateTime(comparison.data.previous.createdAt)}
            <ArrowRight className="size-3.5 text-subtle" />
          </Link>
        ) : null}
        {comparison.data ? (
          <span className="text-xs text-subtle">
            {pluralize(comparison.data.previous.findingCount, 'finding')} then ·{' '}
            {pluralize(comparison.data.current.findingCount, 'finding')} now
          </span>
        ) : null}
      </div>

      {comparison.isError ? (
        <Panel>
          <ErrorState
            title="Could not compare audits"
            error={comparison.error}
            onRetry={() => void comparison.refetch()}
          />
        </Panel>
      ) : comparison.isLoading || !comparison.data ? (
        <Panel>
          <LoadingState rows={6} />
        </Panel>
      ) : (
        <>
          <ChangeSummary comparison={comparison.data} />
          <FindingChanges comparison={comparison.data} onOpenFinding={(ref) => nav?.openFinding(ref)} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
            <MetricChanges comparison={comparison.data} />
            <StackChanges comparison={comparison.data} />
          </div>
          <ScreenshotPairs pairs={comparison.data.screenshots} />
        </>
      )}
      {history.data ? <Trends history={history.data} /> : null}
      {history.data ? <SiteAudits history={history.data} currentId={audit.id} comparedId={compared ?? null} /> : null}
      <p className="text-xs text-subtle">
        Benchmark audits are excluded. Trends only include measurements that exist in at least {MIN_TREND_POINTS}{' '}
        completed audits; nothing is estimated between audits.
      </p>
    </div>
  )
}
