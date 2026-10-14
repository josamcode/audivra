import { type SpecialistAvailabilityState, type SpecialistRun, type SpecialistRunState, type SecurityEngagementDetail } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { SeverityBadge } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { engagementSpecialistAvailabilityQuery, engagementSpecialistRunsQuery, specialistRunQuery } from '@/lib/queries'
import { formatRelative } from '@/lib/format'

/*
 * Phase 6D — the Specialist (Strix) section. It keeps Audivra terminology primary: a specialist is an optional
 * research engine whose results are SIGNALS, never verified findings. It shows availability + version + enabled
 * modes, the runs with their completion state, and per run the imported signals (and any Audivra finding they
 * eventually corroborated through verification). A clean/partial run never means the app is secure.
 */

const AVAIL_TONE: Record<SpecialistAvailabilityState, BadgeTone> = {
  ready: 'success',
  'needs-setup': 'medium',
  missing: 'neutral',
  'version-mismatch': 'medium',
  'provider-not-configured': 'medium',
  'docker-unavailable': 'medium',
  disabled: 'neutral',
  error: 'critical',
}

const RUN_TONE: Record<SpecialistRunState, BadgeTone> = {
  requested: 'neutral',
  preparing: 'running',
  running: 'running',
  collecting: 'running',
  completed: 'success',
  partial: 'medium',
  'budget-stopped': 'medium',
  cancelled: 'neutral',
  failed: 'critical',
  unavailable: 'neutral',
}

const runColumns = (() => {
  const col = createColumnHelper<SpecialistRun>()
  return [
    col.accessor('mode', { header: 'Mode', cell: (c) => <span className="text-xs text-fg">{c.getValue()}</span> }),
    col.accessor('state', { header: 'State', cell: (c) => <Badge tone={RUN_TONE[c.getValue()]} dot>{c.getValue()}</Badge> }),
    col.display({ id: 'completion', header: 'Completion', cell: (c) => <span className="text-2xs text-subtle">{c.row.original.completion ?? '—'}</span> }),
    col.display({ id: 'signals', header: 'Signals', cell: (c) => <span className="text-xs text-muted">{c.row.original.imported.observations + c.row.original.imported.merged}</span> }),
    col.display({ id: 'targets', header: 'Targets', cell: (c) => <span className="text-xs text-muted">{c.row.original.targets.filter((t) => t.inScope).length}</span> }),
    col.accessor('createdAt', { header: 'When', cell: (c) => <span className="text-2xs text-subtle">{formatRelative(c.getValue())}</span> }),
  ]
})()

function RunDetail({ runId }: { runId: string }) {
  const query = useQuery(specialistRunQuery(runId))
  const detail = query.data
  if (query.isError) return <ErrorState title="Could not load the run" error={query.error} onRetry={() => void query.refetch()} />
  if (!detail) return <PanelBody className="text-xs text-subtle">Loading…</PanelBody>
  const { run } = detail
  return (
    <PanelBody className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RUN_TONE[run.state]} dot>{run.state}</Badge>
        <span className="text-2xs text-subtle">{run.engine} {run.engineVersion ?? ''} · {run.mode}</span>
        {run.providerModel ? <span className="text-2xs text-subtle">model {run.providerModel}</span> : null}
      </div>
      <div className="text-xs text-muted">{run.stateReason}</div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-2xs text-subtle">
        <span>results {run.imported.vulnerabilities}</span>
        <span>new {run.imported.observations}</span>
        <span>corroborating {run.imported.merged}</span>
        <span>gaps {run.imported.gaps}</span>
        <span>out-of-scope {run.imported.outOfScope}</span>
      </div>
      {detail.signals.length ? (
        <div>
          <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Signals ({detail.signals.length})</div>
          <ul className="flex flex-col gap-1">
            {detail.signals.map((s) => (
              <li key={s.nativeId} className="text-xs text-muted">
                <span className="font-mono text-2xs text-subtle">[{s.action}]</span> {s.title} <span className="text-subtle">· native {s.nativeSeverity}</span>
                {s.finding ? (
                  <span className="ml-1">→ <SeverityBadge severity={s.finding.severity} className="mr-1" /> {s.finding.title} <span className="text-subtle">({s.finding.verificationState})</span></span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail.artifacts.length ? (
        <div>
          <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Artifacts</div>
          <ul className="flex flex-col gap-1">
            {detail.artifacts.map((a) => (
              <li key={a.ref} className="text-xs text-muted">
                <span className="font-mono text-2xs text-subtle">{a.ref}</span> {a.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PanelBody>
  )
}

export function SpecialistTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const availability = useQuery(engagementSpecialistAvailabilityQuery(engagement.id))
  const runs = useQuery(engagementSpecialistRunsQuery(engagement.id))
  const rows = runs.data ?? []
  const table = useDataTable({ data: rows, columns: runColumns, getRowId: (row) => row.id })
  const avail = availability.data

  const request = useMutation({
    mutationFn: () => api.requestSpecialistRun(engagement.id, { engine: 'strix', mode: 'source-only', findingIds: [], resourceRefs: [], stagedSourceRef: null, focus: 'broad' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id, 'specialist', 'runs'] }),
  })

  const ready = avail?.state === 'ready'
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Specialist engine (Strix)"
          description="An optional external research engine. Audivra constructs every input and authorizes the target set; results are signals that pass through Audivra verification — they are never inserted as verified findings. Live-target modes are disabled until containment is proven."
          actions={
            <Button size="sm" onClick={() => request.mutate()} disabled={request.isPending || !ready} title={ready ? 'Request a source-only specialist run' : avail?.reason ?? 'Specialist engine not ready'}>
              {request.isPending ? 'Requesting…' : 'Request run'}
            </Button>
          }
        />
        <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
          <Metric label="Availability" value={avail?.state ?? '—'} tone={avail ? (avail.state === 'ready' ? 'success' : 'muted') : 'muted'} />
          <Metric label="Version" value={avail?.installedVersion ?? '—'} tone="muted" />
          <Metric label="Modes" value={avail?.enabledModes.join(', ') || 'none'} tone="muted" />
          <Metric label="Runs" value={rows.length} tone="default" />
        </PanelBody>
        {avail ? (
          <PanelBody className="pt-0 text-xs">
            <Badge tone={AVAIL_TONE[avail.state]} dot>{avail.state}</Badge> <span className="ml-1 text-subtle">{avail.reason}</span>
          </PanelBody>
        ) : null}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,24rem)]">
        <Panel>
          {runs.isError ? (
            <ErrorState title="Could not load specialist runs" error={runs.error} onRetry={() => void runs.refetch()} />
          ) : (
            <DataTable
              table={table}
              isLoading={runs.isLoading}
              minWidth="min-w-150"
              onRowClick={(row) => setSelected(row.id)}
              empty={<EmptyState icon={FlaskConical} title="No specialist runs yet" description="Request a run when the engine is ready. Its structured results become observations and pass through Audivra verification." />}
            />
          )}
        </Panel>
        {selected ? (
          <Panel>
            <PanelHeader title="Run detail" actions={<button className="text-xs text-subtle hover:text-fg" onClick={() => setSelected(null)}>Close</button>} />
            <RunDetail runId={selected} />
          </Panel>
        ) : null}
      </div>
    </div>
  )
}
