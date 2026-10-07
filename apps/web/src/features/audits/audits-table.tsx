import type { AuditStatus, DashboardAudit } from '@audivra/contracts'
import { useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { ChevronRight, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { StatusBadge } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Panel } from '@/components/panel'
import { EmptyState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { durationBetween, formatDateTime, formatDuration, formatRelative, pluralize } from '@/lib/format'
import { isTerminal } from '@/lib/queries'
import { SeverityBars, SeverityCountsText, SiteMark, TargetTag, TrendLabel, trendHint } from './signals'

type StatusFilter = 'all' | 'active' | Exclude<AuditStatus, 'queued' | 'running'>
type StartedFilter = 'any' | '24h' | '7d' | '30d'
type SeverityFilter = 'any' | 'critical' | 'high' | 'medium'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Running or queued' },
  { value: 'completed', label: 'Completed' },
  { value: 'partial', label: 'Partial' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]
const STARTED_OPTIONS: { value: StartedFilter; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]
const SEVERITY_OPTIONS: { value: SeverityFilter; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'critical', label: 'Has critical' },
  { value: 'high', label: 'High or worse' },
  { value: 'medium', label: 'Medium or worse' },
]
const WINDOW_MS: Record<Exclude<StartedFilter, 'any'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }

/** Rows shown before "Show all" (filters and search always show every match). */
const RECENT_ROWS = 10

const startedAt = (audit: DashboardAudit) => audit.startedAt ?? audit.createdAt

function findingsSummary(audit: DashboardAudit): string {
  if (!isTerminal(audit.status)) return 'in progress'
  if (!audit.aiEnabled) return 'baseline only'
  return pluralize(audit.findingCount, 'finding')
}

function FindingsCell({ audit }: { audit: DashboardAudit }) {
  if (!isTerminal(audit.status)) return <span className="text-xs text-subtle">In progress</span>
  if (!audit.aiEnabled) {
    return (
      <span className="text-xs text-subtle" title="AI was off for this audit: baseline measurements only, no findings">
        Baseline only
      </span>
    )
  }
  if (audit.findingCount === 0 && audit.status !== 'completed') return <span className="text-sm text-subtle">—</span>
  return (
    <div className="min-w-0 py-1">
      <div className="text-sm whitespace-nowrap text-foreground">
        <span className="font-mono font-medium tabular-nums">{audit.findingCount}</span>{' '}
        <span className="text-muted">{audit.findingCount === 1 ? 'finding' : 'findings'}</span>
      </div>
      <SeverityCountsText counts={audit.severityCounts} className="flex-nowrap" />
    </div>
  )
}

function TrendCell({ audit }: { audit: DashboardAudit }) {
  const trend = audit.trend
  if (!trend) {
    return (
      <span className="text-sm text-subtle" title="No earlier finished AI audit of this site to compare with">
        —
      </span>
    )
  }
  const [previous, current] = trend.history.slice(-2)
  return (
    <Tooltip content={trendHint(previous!, current!)}>
      <span className="inline-flex items-center gap-2">
        <SeverityBars points={trend.history} />
        <TrendLabel direction={trend.direction} />
      </span>
    </Tooltip>
  )
}

const column = createColumnHelper<DashboardAudit>()

/** Recent audits: a dense, sortable table with a little more context per row than a plain list. */
export function AuditsTable({ audits, now }: { audits: DashboardAudit[]; now: number }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [started, setStarted] = useState<StartedFilter>('any')
  const [severity, setSeverity] = useState<SeverityFilter>('any')
  const [site, setSite] = useState('all')
  const [expanded, setExpanded] = useState(false)

  const siteOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const audit of audits) {
      if (!seen.has(audit.siteKey)) seen.set(audit.siteKey, audit.benchmark ? `${audit.siteKey} (benchmark)` : audit.local ? `${audit.siteKey} (local)` : audit.siteKey)
    }
    return [{ value: 'all', label: 'All' }, ...[...seen].map(([value, label]) => ({ value, label }))]
  }, [audits])

  const filtering = search.trim() !== '' || status !== 'all' || started !== 'any' || severity !== 'any' || site !== 'all'
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return audits.filter((audit) => {
      if (needle && ![audit.domain, audit.url, audit.clientName ?? ''].some((value) => value.toLowerCase().includes(needle))) return false
      if (status === 'active' ? isTerminal(audit.status) : status !== 'all' && audit.status !== status) return false
      if (started !== 'any' && now - new Date(startedAt(audit)).getTime() > WINDOW_MS[started]) return false
      const { critical, high, medium } = audit.severityCounts
      if (severity === 'critical' && critical === 0) return false
      if (severity === 'high' && critical + high === 0) return false
      if (severity === 'medium' && critical + high + medium === 0) return false
      return site === 'all' || audit.siteKey === site
    })
  }, [audits, search, status, started, severity, site, now])

  const columns = useMemo(
    () => [
      column.accessor('domain', {
        header: 'Website',
        cell: ({ row }) => {
          const audit = row.original
          return (
            <div className="flex min-w-0 items-center gap-3 py-1.5">
              <SiteMark domain={audit.domain} benchmark={audit.benchmark} local={audit.local} />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-foreground">{audit.domain}</span>
                  <TargetTag benchmark={audit.benchmark} local={audit.local} />
                </div>
                <div className="hidden truncate text-xs text-muted @2xl:block">{audit.clientName ?? audit.url}</div>
                <div className="truncate text-xs text-muted @2xl:hidden">
                  {formatRelative(startedAt(audit), now)} · {findingsSummary(audit)}
                </div>
              </div>
            </div>
          )
        },
        meta: { className: 'w-full max-w-0' },
      }),
      column.accessor('status', {
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={row.original.status} stage={row.original.stage} />,
        meta: { className: 'w-1' },
      }),
      column.accessor(startedAt, {
        id: 'started',
        header: 'Started',
        cell: ({ row, getValue }) => {
          const duration = durationBetween(row.original.startedAt, row.original.finishedAt, now)
          return (
            <div className="py-1 whitespace-nowrap">
              <div className="text-sm text-muted" title={formatDateTime(getValue())}>
                {formatRelative(getValue(), now)}
              </div>
              <div className="font-mono text-xs text-subtle tabular-nums" title="Duration">
                {duration === null ? '—' : formatDuration(duration)}
              </div>
            </div>
          )
        },
        meta: { className: 'hidden w-1 @2xl:table-cell' },
      }),
      column.accessor('findingCount', {
        header: 'Findings',
        cell: ({ row }) => <FindingsCell audit={row.original} />,
        meta: { className: 'hidden w-1 @2xl:table-cell' },
      }),
      column.display({
        id: 'trend',
        header: 'Trend',
        cell: ({ row }) => <TrendCell audit={row.original} />,
        meta: { className: 'hidden w-1 @3xl:table-cell' },
      }),
      column.display({
        id: 'open',
        header: () => <span className="sr-only">Open</span>,
        cell: () => (
          <ChevronRight className="size-4 text-subtle transition-colors group-hover/row:text-foreground group-focus-visible/row:text-foreground" />
        ),
        meta: { className: 'w-1' },
      }),
    ],
    [now],
  )

  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (audit) => audit.id,
    initialSorting: [{ id: 'started', desc: true }],
  })

  const limited = !filtering && !expanded && rows.length > RECENT_ROWS
  const clear = () => {
    setSearch('')
    setStatus('all')
    setStarted('any')
    setSeverity('any')
    setSite('all')
  }

  return (
    <Panel className="@container overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="mr-auto flex min-h-7 min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Recent audits</h2>
          {filtering ? (
            <span className="text-xs text-muted" aria-live="polite">
              {rows.length} of {pluralize(audits.length, 'audit')}
            </span>
          ) : null}
        </div>
        <Input
          icon={<Search />}
          placeholder="Search audits or sites"
          aria-label="Search audits or websites"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full @xl:w-48"
        />
        <Select label="Status" value={status} onValueChange={setStatus} options={STATUS_OPTIONS} />
        <Select label="Date" value={started} onValueChange={setStarted} options={STARTED_OPTIONS} />
        <Select label="Severity" value={severity} onValueChange={setSeverity} options={SEVERITY_OPTIONS} />
        <Select label="Website" value={site} onValueChange={setSite} options={siteOptions} className="max-w-56" />
        {filtering ? (
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </div>
      <DataTable
        table={table}
        minWidth="min-w-0"
        rowLimit={limited ? RECENT_ROWS : undefined}
        empty={
          <EmptyState
            compact
            icon={Search}
            title="No audits match"
            description="Change the search or filters to see more audits."
            action={
              <Button size="sm" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        }
        onRowClick={(audit) => void navigate({ to: '/audits/$auditId', params: { auditId: audit.id } })}
      />
      {limited || (expanded && !filtering && rows.length > RECENT_ROWS) ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted">
          <span>{limited ? `Showing the ${RECENT_ROWS} most recent` : `Showing all ${rows.length}`}</span>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {limited ? `Show all ${rows.length} audits` : 'Show fewer'}
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}
