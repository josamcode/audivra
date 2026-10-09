import {
  OBSERVATION_FAMILIES,
  OBSERVATION_SCOPE_CLASSES,
  OBSERVATION_TYPES,
  type ObservationFamily,
  type ObservationScopeClass,
  type ObservationType,
  type SecurityEngagementDetail,
  type SecurityObservation,
  type SensorCoverageItem,
} from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Link2, Radar } from 'lucide-react'
import { useState } from 'react'
import { DataTable, useDataTable } from '@/components/data-table'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { engagementObservationCorrelationQuery, engagementObservationSummaryQuery, engagementObservationsQuery, engagementSensorCoverageQuery } from '@/lib/queries'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/*
 * Observations: the normalized, deduplicated, evidence-backed signals that sensors have recorded for an
 * engagement. An observation is NOT a finding — it is a signal a later layer may correlate and verify.
 * This view is read-only. A discovered destination is classified against the engagement scope; being
 * observed never authorizes it.
 */

const TYPE_LABEL: Record<ObservationType, string> = {
  technology: 'Technology',
  endpoint: 'Endpoint',
  'http-response': 'HTTP response',
  'http-header': 'HTTP header',
  redirect: 'Redirect',
  form: 'Form',
  'tls-config': 'TLS config',
  dependency: 'Dependency',
  'source-finding': 'Source finding',
  service: 'Service',
  'api-operation': 'API operation',
  'api-validation': 'API validation',
  'api-workflow': 'API workflow',
  'web-signal': 'Web signal',
  'oast-interaction': 'OAST interaction',
  'traffic-flow': 'Traffic flow',
  'dependency-vulnerability': 'Dependency vuln',
}

const SCOPE_TONE: Record<ObservationScopeClass, string> = {
  'in-scope': 'border-success/40 bg-success/10 text-success',
  'out-of-scope': 'border-medium/40 bg-medium/10 text-medium',
  'third-party': 'border-border bg-surface text-muted',
  unknown: 'border-border bg-surface text-subtle',
}

function ScopeBadge({ value }: { value: ObservationScopeClass | null }) {
  if (!value) return <span className="text-subtle">—</span>
  return <span className={cn('inline-flex rounded-sm border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap', SCOPE_TONE[value])}>{value}</span>
}

const column = createColumnHelper<SecurityObservation>()
const columns = [
  column.accessor('type', {
    header: 'Type',
    cell: ({ getValue }) => <span className="whitespace-nowrap text-muted">{TYPE_LABEL[getValue()]}</span>,
    meta: { className: 'w-1' },
  }),
  column.accessor('title', {
    header: 'Observation',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div className="truncate font-medium text-foreground">{row.original.title}</div>
        <div className="truncate font-mono text-2xs text-subtle">{row.original.asset}</div>
      </div>
    ),
    meta: { className: 'w-full max-w-0' },
  }),
  column.accessor('scopeClass', {
    header: 'Scope',
    cell: ({ getValue }) => <ScopeBadge value={getValue()} />,
    meta: { className: 'w-1' },
  }),
  column.accessor((row) => [...new Set(row.contributions.map((c) => c.tool))].join(', '), {
    id: 'tools',
    header: 'Sensor',
    cell: ({ getValue }) => <span className="font-mono text-2xs whitespace-nowrap text-muted">{getValue()}</span>,
    meta: { className: 'hidden w-1 md:table-cell' },
  }),
  column.accessor('confidence', {
    header: 'Confidence',
    cell: ({ getValue }) => <span className="font-mono text-xs tabular-nums text-muted">{getValue().toFixed(2)}</span>,
    meta: { className: 'hidden w-1 lg:table-cell', align: 'right' },
  }),
  column.accessor('lastSeenAt', {
    header: 'Last seen',
    cell: ({ getValue }) => <span className="text-xs whitespace-nowrap text-muted">{formatRelative(getValue())}</span>,
    meta: { className: 'w-1' },
  }),
]

function Select<T extends string>({ label, value, options, onChange, render }: { label: string; value: T | 'all'; options: readonly T[]; onChange: (v: T | 'all') => void; render: (v: T) => string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T | 'all')}
        className="rounded-sm border border-border bg-surface px-1.5 py-1 text-xs text-foreground"
      >
        <option value="all">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {render(o)}
          </option>
        ))}
      </select>
    </label>
  )
}

const COVERAGE_TONE: Record<SensorCoverageItem['status'], string> = {
  ran: 'border-success/40 bg-success/10 text-success',
  partial: 'border-medium/40 bg-medium/10 text-medium',
  skipped: 'border-border bg-surface text-subtle',
  failed: 'border-critical/40 bg-critical/10 text-critical',
  unavailable: 'border-border bg-surface text-muted',
  blocked: 'border-medium/40 bg-medium/10 text-medium',
  'missing-input': 'border-border bg-surface text-muted',
  'not-applicable': 'border-border bg-surface text-subtle',
}

function SensorCoverage({ engagementId }: { engagementId: string }) {
  const coverage = useQuery(engagementSensorCoverageQuery(engagementId))
  if (!coverage.data?.length) return null
  return (
    <Panel>
      <PanelHeader title="Sensor coverage" description="Each shipped sensor and the state of its most recent run for this engagement. A sensor that has not run is shown as skipped, never hidden." />
      <PanelBody className="flex flex-col gap-2">
        {coverage.data.map((item) => (
          <div key={item.capabilityId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={cn('inline-flex w-20 justify-center rounded-sm border px-1.5 py-0.5 text-2xs font-medium', COVERAGE_TONE[item.status])}>{item.status}</span>
            <span className="text-sm font-medium text-foreground">{item.name}</span>
            <span className="font-mono text-2xs text-subtle">{item.tool}</span>
            {item.status !== 'skipped' ? <span className="text-2xs text-muted">· {item.observations} observation{item.observations === 1 ? '' : 's'}</span> : null}
            {item.reason ? <span className="truncate text-2xs text-subtle">· {item.reason}</span> : null}
          </div>
        ))}
      </PanelBody>
    </Panel>
  )
}

function CorrelatedAssets({ engagementId }: { engagementId: string }) {
  const correlation = useQuery(engagementObservationCorrelationQuery(engagementId))
  const multi = (correlation.data ?? []).filter((c) => c.tools.length > 1)
  if (!multi.length) return null
  return (
    <Panel>
      <PanelHeader
        title="Correlated assets"
        description="Assets several independent sensors converged on. Supporting sensors are kept together for later verification; no sensor result is treated as a verified finding."
      />
      <PanelBody className="flex flex-col gap-2">
        {multi.slice(0, 20).map((c) => (
          <div key={c.asset} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link2 className="size-3.5 shrink-0 text-subtle" aria-hidden />
            <span className="truncate font-mono text-2xs text-foreground">{c.asset}</span>
            <span className="text-2xs text-muted">{c.tools.join(', ')}</span>
            <span className="text-2xs text-subtle">· {c.observations.length} observation{c.observations.length === 1 ? '' : 's'}</span>
          </div>
        ))}
      </PanelBody>
    </Panel>
  )
}

export function ObservationsTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const [type, setType] = useState<ObservationType | 'all'>('all')
  const [scopeClass, setScopeClass] = useState<ObservationScopeClass | 'all'>('all')
  const [family, setFamily] = useState<ObservationFamily | 'all'>('all')
  const summary = useQuery(engagementObservationSummaryQuery(engagement.id))
  const observations = useQuery(
    engagementObservationsQuery(engagement.id, {
      type: type === 'all' ? undefined : type,
      scopeClass: scopeClass === 'all' ? undefined : scopeClass,
      family: family === 'all' ? undefined : family,
    }),
  )
  const rows = observations.data ?? []
  const table = useDataTable({ data: rows, columns, getRowId: (row) => row.id, initialSorting: [{ id: 'type', desc: false }] })

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Observations" description="Normalized, evidence-backed signals sensors recorded. Signals to review and correlate — not verified findings." />
        <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
          <Metric label="Total" value={summary.data?.total ?? '—'} tone={summary.data?.total ? 'default' : 'muted'} />
          <Metric label="In scope" value={summary.data?.byScopeClass['in-scope'] ?? 0} tone="success" />
          <Metric label="Out of scope" value={summary.data?.byScopeClass['out-of-scope'] ?? 0} tone="medium" />
          <Metric label="Third party" value={summary.data?.byScopeClass['third-party'] ?? 0} tone="muted" />
          <Metric label="Endpoints" value={summary.data?.byType.endpoint ?? 0} tone="default" />
          <Metric label="Technologies" value={summary.data?.byType.technology ?? 0} tone="default" />
          <Metric label="Source findings" value={summary.data?.byType['source-finding'] ?? 0} tone="default" />
        </PanelBody>
      </Panel>
      <SensorCoverage engagementId={engagement.id} />
      <CorrelatedAssets engagementId={engagement.id} />
      <Panel>
        <PanelHeader
          title="Discovery"
          description="Every destination is classified against the engagement scope. A discovered destination is a signal only; it is never authorized by being observed."
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <Select label="Family" value={family} options={OBSERVATION_FAMILIES} onChange={setFamily} render={(f) => f} />
              <Select label="Type" value={type} options={OBSERVATION_TYPES} onChange={setType} render={(t) => TYPE_LABEL[t]} />
              <Select label="Scope" value={scopeClass} options={OBSERVATION_SCOPE_CLASSES} onChange={setScopeClass} render={(s) => s} />
            </div>
          }
        />
        {observations.isError ? (
          <ErrorState title="Could not load observations" error={observations.error} onRetry={() => void observations.refetch()} />
        ) : (
          <DataTable
            table={table}
            isLoading={observations.isLoading}
            minWidth="min-w-140"
            empty={
              <EmptyState
                icon={Radar}
                title="No observations yet"
                description="Observations appear here as sensor capabilities (httpx, katana, Semgrep) run through the broker and normalize their output."
              />
            }
          />
        )}
      </Panel>
    </div>
  )
}
