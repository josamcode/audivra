import { type EdgeVerificationState, type ImpactClass, type PathState, type SecurityAttackPath, type SecurityEngagementDetail } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Download, Route } from 'lucide-react'
import { useState } from 'react'
import { SeverityBadge, Confidence } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, attackPathExportUrl } from '@/lib/api'
import { engagementAttackPathCoverageQuery, engagementAttackPathsQuery, securityAttackPathQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

/*
 * Phase 6B: evidence-backed attack paths. A path is a structured route from a known start condition to a
 * structured impact; every step carries its own verification state, so the view makes proven vs assumed
 * instantly legible and never presents an inferred or speculative route as a demonstrated compromise. This
 * view is read-only except for a button that queues a (deterministic, idempotent) analysis.
 */

const PATH_STATE: Record<PathState, { label: string; tone: BadgeTone; hint: string }> = {
  verified: { label: 'Verified', tone: 'success', hint: 'Every step is verified' },
  'partially-verified': { label: 'Partially verified', tone: 'info', hint: 'Verified steps with at least one inferred step' },
  supported: { label: 'Supported', tone: 'info', hint: 'The weakest step is supported, not fully verified' },
  speculative: { label: 'Speculative', tone: 'medium', hint: 'A required connecting edge is missing' },
  rejected: { label: 'Rejected', tone: 'neutral', hint: 'A step is contradicted by stored evidence' },
}

const EDGE_TONE: Record<EdgeVerificationState, string> = {
  verified: 'border-success/40 bg-success/10 text-success',
  supported: 'border-info/40 bg-info/10 text-info',
  inferred: 'border-medium/40 bg-medium/10 text-medium',
  missing: 'border-border bg-surface text-subtle',
  contradicted: 'border-critical/40 bg-critical/10 text-critical',
}

const IMPACT_LABEL: Record<ImpactClass, string> = {
  'unauthorized-data-access': 'Unauthorized data access',
  'cross-tenant-access': 'Cross-tenant access',
  'unauthorized-state-change': 'Unauthorized state change',
  'privilege-boundary-crossed': 'Privilege boundary crossed',
  'sensitive-capability-reached': 'Sensitive capability reached',
  'security-control-bypassed': 'Security control bypassed',
}

function PathStateBadge({ state }: { state: PathState }) {
  const s = PATH_STATE[state]
  return (
    <Badge tone={s.tone} dot title={s.hint}>
      {s.label}
    </Badge>
  )
}

function EdgeBadge({ state }: { state: EdgeVerificationState }) {
  return <span className={cn('inline-flex rounded-sm border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap', EDGE_TONE[state])}>{state}</span>
}

const columns = (() => {
  const col = createColumnHelper<SecurityAttackPath>()
  return [
    col.accessor('impactPriority', { header: 'Priority', cell: (c) => <SeverityBadge severity={c.getValue()} /> }),
    col.accessor('title', {
      header: 'Attack path',
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-fg">{c.getValue()}</div>
          <div className="truncate text-2xs text-subtle">
            {c.row.original.start.label} → {c.row.original.end.label}
          </div>
        </div>
      ),
    }),
    col.accessor('state', { header: 'State', cell: (c) => <PathStateBadge state={c.getValue()} /> }),
    col.display({ id: 'steps', header: 'Steps', cell: (c) => <span className="text-xs text-muted">{c.row.original.steps.length}</span> }),
    col.display({ id: 'findings', header: 'Findings', cell: (c) => <span className="text-xs text-muted">{c.row.original.findingIds.length}</span> }),
    col.accessor('confidence', { header: 'Confidence', cell: (c) => <Confidence value={c.getValue()} /> }),
    col.display({ id: 'gaps', header: 'Gaps', cell: (c) => <span className={cn('text-xs', c.row.original.missingEvidence.length ? 'text-medium' : 'text-subtle')}>{c.row.original.missingEvidence.length || '—'}</span> }),
  ]
})()

function PathDetail({ pathId }: { pathId: string }) {
  const query = useQuery(securityAttackPathQuery(pathId))
  if (query.isError) return <ErrorState title="Could not load the path" error={query.error} onRetry={() => void query.refetch()} />
  const detail = query.data
  if (!detail) return <PanelBody className="text-xs text-subtle">Loading…</PanelBody>
  const { path } = detail
  return (
    <PanelBody className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={path.impactPriority} />
        <PathStateBadge state={path.state} />
        <Confidence value={path.confidence} />
        <span className="text-2xs text-subtle">{IMPACT_LABEL[path.impactClass]}</span>
      </div>
      {path.explanation ? <p className="text-sm text-muted">{path.explanation}</p> : null}

      {/* The ordered, verification-coded route. */}
      <div className="flex flex-col gap-0">
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg">Start: {path.start.label}</div>
        {path.steps.map((s) => (
          <div key={s.index} className="flex flex-col">
            <div className="ml-4 border-l border-dashed border-border py-1 pl-3 text-2xs text-subtle">
              {s.relationship} <EdgeBadge state={s.edgeVerification} />
              {s.boundaryCrossed ? <span className="ml-1 text-medium">· crosses {s.boundaryCrossed} boundary</span> : null}
            </div>
            <div className={cn('rounded-md border px-3 py-2 text-xs', s.edgeVerification === 'missing' || s.edgeVerification === 'contradicted' ? 'border-dashed border-border bg-surface text-subtle' : 'border-border bg-surface text-fg')}>{s.toCondition}</div>
          </div>
        ))}
      </div>

      {path.missingEvidence.length ? (
        <div>
          <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Missing evidence ({path.missingEvidence.length})</div>
          <ul className="flex flex-col gap-1">
            {path.missingEvidence.map((m, i) => (
              <li key={i} className="text-xs text-medium">
                {m.kind}: {m.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.findings.length ? (
        <div>
          <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Findings correlated ({detail.findings.length})</div>
          <ul className="flex flex-col gap-1">
            {detail.findings.map((f) => (
              <li key={f.id} className="text-xs text-muted">
                <SeverityBadge severity={f.severity} className="mr-1" /> {f.title} <span className="text-subtle">({f.verificationState})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PanelBody>
  )
}

export function AttackPathsTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const paths = useQuery(engagementAttackPathsQuery(engagement.id))
  const coverage = useQuery(engagementAttackPathCoverageQuery(engagement.id))
  const rows = paths.data ?? []
  const table = useDataTable({ data: rows, columns, getRowId: (row) => row.id, initialSorting: [{ id: 'impactPriority', desc: false }] })

  const analyze = useMutation({
    mutationFn: () => api.analyzeAttackPaths(engagement.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id, 'attack-paths'] })
    },
  })

  const byState = coverage.data?.byState ?? {}
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Attack paths"
          description="Evidence-backed routes that correlate verified findings and graph relationships. A path with any inferred or missing step is shown as partial or speculative — never as demonstrated compromise."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <a href={attackPathExportUrl(engagement.id, 'json')} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                <Download className="size-3.5" /> JSON
              </a>
              <a href={attackPathExportUrl(engagement.id, 'csv')} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                <Download className="size-3.5" /> CSV
              </a>
              <Button size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
                {analyze.isPending ? 'Queuing…' : 'Run analysis'}
              </Button>
            </div>
          }
        />
        <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
          <Metric label="Verified" value={byState.verified ?? 0} tone={byState.verified ? 'success' : 'muted'} />
          <Metric label="Partially verified" value={byState['partially-verified'] ?? 0} tone="default" />
          <Metric label="Supported" value={byState.supported ?? 0} tone="default" />
          <Metric label="Speculative" value={byState.speculative ?? 0} tone="muted" />
          <Metric label="Evidence gaps" value={coverage.data?.missingEvidenceEdges ?? 0} tone={coverage.data?.missingEvidenceEdges ? 'medium' : 'muted'} />
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,24rem)]">
        <Panel>
          {paths.isError ? (
            <ErrorState title="Could not load attack paths" error={paths.error} onRetry={() => void paths.refetch()} />
          ) : (
            <DataTable
              table={table}
              isLoading={paths.isLoading}
              minWidth="min-w-150"
              onRowClick={(row) => setSelected(row.id)}
              empty={
                <EmptyState
                  icon={Route}
                  title="No attack paths yet"
                  description="Paths appear here as verification produces findings and the analysis correlates them. Run the analysis once findings exist."
                />
              }
            />
          )}
        </Panel>
        {selected ? (
          <Panel>
            <PanelHeader title="Path detail" actions={<button className="text-xs text-subtle hover:text-fg" onClick={() => setSelected(null)}>Close</button>} />
            <PathDetail pathId={selected} />
          </Panel>
        ) : null}
      </div>
    </div>
  )
}
