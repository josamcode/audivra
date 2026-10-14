import { type ResearchMode, type ResearchObjective, type ResearchRunState, type SecurityEngagementDetail, type SecurityResearchRun } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Bot } from 'lucide-react'
import { useState } from 'react'
import { DataTable, useDataTable } from '@/components/data-table'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { engagementResearchRunsQuery, researchRunQuery } from '@/lib/queries'
import { formatRelative } from '@/lib/format'

/*
 * Phase 6E — the Autonomous Assessment (Research) section. It shows what Audivra is doing and why: the run's
 * mode/objective/stage/iteration, budget used, a concise decision timeline, the actions proposed/executed, the
 * findings surfaced, residual uncertainty, and the exact stop reason. Audivra does not claim a complete
 * penetration test — residual uncertainty is always shown.
 */

const RUN_TONE: Record<ResearchRunState, BadgeTone> = {
  created: 'neutral',
  running: 'running',
  paused: 'medium',
  degraded: 'medium',
  stopped: 'success',
  failed: 'critical',
}

const runColumns = (() => {
  const col = createColumnHelper<SecurityResearchRun>()
  return [
    col.accessor('objective', { header: 'Objective', cell: (c) => <span className="text-xs text-fg">{c.getValue()}</span> }),
    col.accessor('mode', { header: 'Mode', cell: (c) => <span className="text-2xs text-subtle">{c.getValue()}</span> }),
    col.accessor('state', { header: 'State', cell: (c) => <Badge tone={RUN_TONE[c.getValue()]} dot>{c.getValue()}</Badge> }),
    col.display({ id: 'iter', header: 'Iterations', cell: (c) => <span className="text-xs text-muted">{c.row.original.usage.iterations}</span> }),
    col.display({ id: 'actions', header: 'Actions', cell: (c) => <span className="text-xs text-muted">{c.row.original.usage.actions}</span> }),
    col.display({ id: 'stop', header: 'Stop reason', cell: (c) => <span className="text-2xs text-subtle">{c.row.original.terminationReason ?? '—'}</span> }),
    col.accessor('createdAt', { header: 'When', cell: (c) => <span className="text-2xs text-subtle">{formatRelative(c.getValue())}</span> }),
  ]
})()

function RunDetail({ runId }: { runId: string }) {
  const queryClient = useQueryClient()
  const query = useQuery(researchRunQuery(runId))
  const detail = query.data
  const act = (fn: () => Promise<unknown>) => () => void fn().then(() => queryClient.invalidateQueries({ queryKey: ['security', 'research', 'run', runId] }))
  if (query.isError) return <ErrorState title="Could not load the run" error={query.error} onRetry={() => void query.refetch()} />
  if (!detail) return <PanelBody className="text-xs text-subtle">Loading…</PanelBody>
  const { run } = detail
  return (
    <PanelBody className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RUN_TONE[run.state]} dot>{run.state}</Badge>
        <span className="text-2xs text-subtle">stage {run.stage} · iteration {run.iteration}</span>
        {run.state === 'running' || run.state === 'degraded' ? (
          <Button size="sm" variant="ghost" onClick={act(() => api.pauseResearchRun(runId))}>Pause</Button>
        ) : run.state === 'paused' ? (
          <Button size="sm" variant="ghost" onClick={act(() => api.resumeResearchRun(runId))}>Resume</Button>
        ) : null}
        {run.state !== 'stopped' && run.state !== 'failed' ? <Button size="sm" variant="ghost" onClick={act(() => api.cancelResearchRun(runId))}>Cancel</Button> : null}
      </div>
      <div className="text-xs text-muted">{run.lastDecision}</div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-2xs text-subtle">
        <span>actions {run.usage.actions}/{run.budget.maxActions}</span>
        <span>AI calls {run.usage.aiCalls}/{run.budget.maxAiCalls}</span>
        <span>specialist {run.usage.specialistRuns}/{run.budget.maxSpecialistRuns}</span>
        {run.terminationReason ? <span className="text-fg">stopped: {run.terminationReason}</span> : null}
      </div>

      <section>
        <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Decision timeline ({detail.timeline.length})</div>
        <ol className="flex flex-col gap-1">
          {detail.timeline.map((e, i) => (
            <li key={i} className={`text-xs ${e.level === 'warn' ? 'text-medium' : 'text-muted'}`}>
              <span className="font-mono text-2xs text-subtle">{e.type}</span> {e.message}
            </li>
          ))}
          {detail.timeline.length === 0 ? <li className="text-xs text-subtle">No actions executed yet.</li> : null}
        </ol>
      </section>

      {detail.findings.length ? (
        <section>
          <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Findings ({detail.findings.length})</div>
          <ul className="flex flex-col gap-1">
            {detail.findings.map((f) => (
              <li key={f.id} className="text-xs text-muted">
                <span className="mr-1 font-medium text-fg">[{f.severity}]</span> {f.title} <span className="text-subtle">({f.verificationState})</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Residual uncertainty</div>
        <ResidualList label="Tested" items={run.residual.tested} tone="text-muted" />
        <ResidualList label="Partially tested" items={run.residual.partiallyTested} tone="text-medium" />
        <ResidualList label="Not tested" items={run.residual.notTested} tone="text-subtle" />
        <ResidualList label="Still unknown" items={run.residual.unknown} tone="text-subtle" />
      </section>
    </PanelBody>
  )
}

function ResidualList({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  if (!items.length) return null
  return (
    <div className="mb-1">
      <span className="text-2xs text-subtle">{label}:</span> <span className={`text-xs ${tone}`}>{items.join('; ')}</span>
    </div>
  )
}

export function ResearchTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<ResearchMode>('propose-only')
  const [objective, setObjective] = useState<ResearchObjective>('maximize-coverage')
  const runs = useQuery(engagementResearchRunsQuery(engagement.id))
  const rows = runs.data ?? []
  const table = useDataTable({ data: rows, columns: runColumns, getRowId: (row) => row.id })

  const create = useMutation({
    mutationFn: async () => {
      const run = await api.createResearchRun(engagement.id, { mode, objective, objectiveNote: null, objectiveDetail: {} })
      await api.startResearchRun(run.id) // propose-only produces proposals then stops; execution modes run the loop
      return run
    },
    onSuccess: (run) => {
      setSelected(run.id)
      void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id, 'research', 'runs'] })
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Autonomous assessment"
          description="A bounded, persistent research loop that orchestrates Audivra's existing capabilities. The AI proposes typed next actions; Audivra's broker/policy decide eligibility, 6A verifies, 6B builds paths. It optimizes for useful evidence and coverage — never for finding count — and always reports residual uncertainty."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <select value={mode} onChange={(e) => setMode(e.target.value as ResearchMode)} className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg">
                <option value="propose-only">propose-only</option>
                <option value="investigate">investigate</option>
                <option value="deep-authorized">deep-authorized</option>
              </select>
              <select value={objective} onChange={(e) => setObjective(e.target.value as ResearchObjective)} className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg">
                <option value="maximize-coverage">maximize-coverage</option>
                <option value="investigate-authorization">investigate-authorization</option>
                <option value="investigate-business-rules">investigate-business-rules</option>
                <option value="investigate-api-surface">investigate-api-surface</option>
                <option value="retest-previous">retest-previous</option>
              </select>
              <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? 'Starting…' : 'Start run'}
              </Button>
            </div>
          }
        />
        <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
          <Metric label="Runs" value={rows.length} tone="default" />
          <Metric label="Running" value={rows.filter((r) => r.state === 'running' || r.state === 'degraded').length} tone={rows.some((r) => r.state === 'running') ? 'default' : 'muted'} />
          <Metric label="Stopped" value={rows.filter((r) => r.state === 'stopped').length} tone="muted" />
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,26rem)]">
        <Panel>
          {runs.isError ? (
            <ErrorState title="Could not load research runs" error={runs.error} onRetry={() => void runs.refetch()} />
          ) : (
            <DataTable table={table} isLoading={runs.isLoading} minWidth="min-w-150" onRowClick={(row) => setSelected(row.id)} empty={<EmptyState icon={Bot} title="No research runs yet" description="Start a propose-only run to see the actions Audivra would take, or an investigate run to execute eligible work." />} />
          )}
        </Panel>
        {selected ? (
          <Panel>
            <PanelHeader title="Research run" actions={<button className="text-xs text-subtle hover:text-fg" onClick={() => setSelected(null)}>Close</button>} />
            <RunDetail runId={selected} />
          </Panel>
        ) : null}
      </div>
    </div>
  )
}
