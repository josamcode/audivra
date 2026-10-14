import { type RetestBlockerKind, type RetestCase, type RetestResult, type RetestState, type SecurityEngagementDetail } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { SeverityBadge } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { engagementRetestCasesQuery, engagementRetestResultsQuery } from '@/lib/queries'
import { formatRelative } from '@/lib/format'

/*
 * Phase 6C — the Retesting view. It shows a target assessment's retest cases (with eligibility and the exact
 * blocker when they cannot run), and the historical retest results with their state. FIXED and
 * CANNOT_REPRODUCE are visually distinct: a fix is a positive, evidence-backed outcome; cannot-reproduce is a
 * gap, never a fix.
 */

export const RETEST_STATE: Record<RetestState, { label: string; tone: BadgeTone; hint: string }> = {
  fixed: { label: 'Fixed', tone: 'success', hint: 'The retest ran, the control still worked, and the vulnerable behaviour is gone' },
  'still-present': { label: 'Still present', tone: 'high', hint: 'The vulnerable behaviour was reproduced' },
  regressed: { label: 'Regressed', tone: 'critical', hint: 'Previously fixed and present again' },
  changed: { label: 'Changed', tone: 'info', hint: 'The same issue persists with changed scope/surface' },
  'cannot-reproduce': { label: 'Cannot reproduce', tone: 'medium', hint: 'The condition could not be reconstructed — NOT a fix' },
  blocked: { label: 'Blocked', tone: 'neutral', hint: 'Policy/scope/capability stopped the replay — NOT a fix' },
  'not-tested': { label: 'Not tested', tone: 'neutral', hint: 'No retest was run — absence is not proof of a fix' },
  inconclusive: { label: 'Inconclusive', tone: 'medium', hint: 'The replay was inconclusive' },
}

const BLOCKER_LABEL: Record<RetestBlockerKind, string> = {
  'environment-changed': 'environment changed',
  'scope-excludes-target': 'out of scope',
  'authorization-invalid': 'not authorized',
  'capability-unavailable': 'capability unavailable',
  'identity-unavailable': 'identity unavailable',
  'session-unavailable': 'session unavailable',
  'resource-missing': 'resource missing',
  'unsupported-reproduction': 'not replayable',
}

export function RetestStateBadge({ state }: { state: RetestState }) {
  const s = RETEST_STATE[state]
  return (
    <Badge tone={s.tone} dot title={s.hint}>
      {s.label}
    </Badge>
  )
}

function buildCaseColumns(onRetest: (c: RetestCase) => void, running: boolean) {
  const col = createColumnHelper<RetestCase>()
  return [
    col.accessor('originalSeverity', { header: 'Severity', cell: (c) => <SeverityBadge severity={c.getValue()} /> }),
    col.accessor('title', {
      header: 'Retest case',
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-fg">{c.getValue()}</div>
          <div className="truncate text-2xs text-subtle">
            {c.row.original.reproductionFormat}
            {c.row.original.resourceRef ? ` · ${c.row.original.resourceRef}` : ''}
          </div>
        </div>
      ),
    }),
    col.display({
      id: 'eligibility',
      header: 'Eligibility',
      cell: (c) => {
        const e = c.row.original.eligibility
        return e.eligible ? (
          <Badge tone="success" dot title={e.reason}>
            Replayable
          </Badge>
        ) : (
          <Badge tone="medium" dot title={e.reason}>
            {e.blocker ? BLOCKER_LABEL[e.blocker] : 'blocked'}
          </Badge>
        )
      },
    }),
    col.display({ id: 'planned', header: 'Planned', cell: (c) => <span className="text-xs text-muted">{c.row.original.planned ? 'yes' : '—'}</span> }),
    col.display({
      id: 'action',
      header: '',
      cell: (c) => (
        <Button size="sm" variant="ghost" disabled={running || !c.row.original.eligibility.eligible} onClick={() => onRetest(c.row.original)} title={c.row.original.eligibility.eligible ? 'Replay this case' : c.row.original.eligibility.reason}>
          <RefreshCw className="size-3.5" /> Retest
        </Button>
      ),
    }),
  ]
}

const resultColumns = (() => {
  const col = createColumnHelper<RetestResult>()
  return [
    col.accessor('state', { header: 'Result', cell: (c) => <RetestStateBadge state={c.getValue()} /> }),
    col.accessor('issueKey', { header: 'Issue', cell: (c) => <span className="truncate font-mono text-2xs text-subtle">{c.getValue()}</span> }),
    col.display({ id: 'control', header: 'Control', cell: (c) => <span className={cnTone(c.row.original.controlValid)}>{c.row.original.controlValid ? 'valid' : '—'}</span> }),
    col.display({ id: 'adapted', header: 'Adapted', cell: (c) => <span className="text-xs text-muted">{c.row.original.adaptation ? c.row.original.adaptation.kind : '—'}</span> }),
    col.accessor('createdAt', { header: 'When', cell: (c) => <span className="text-2xs text-subtle">{formatRelative(c.getValue())}</span> }),
  ]
})()

const cnTone = (ok: boolean) => (ok ? 'text-xs text-success' : 'text-xs text-subtle')

export function RetestsTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const queryClient = useQueryClient()
  const [previous, setPrevious] = useState('')
  const cases = useQuery(engagementRetestCasesQuery(engagement.id))
  const results = useQuery(engagementRetestResultsQuery(engagement.id))

  const plan = useMutation({
    mutationFn: () => api.planRetests(engagement.id, previous.trim(), false),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id, 'retests'] }),
  })
  const run = useMutation({
    mutationFn: (testCase: RetestCase) => api.requestRetest(engagement.id, { findingId: testCase.findingId, targetEngagementId: engagement.id, allowAdaptation: false }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id, 'retests'] }),
  })

  const caseRows = cases.data ?? []
  const resultRows = results.data ?? []
  const caseTable = useDataTable({ data: caseRows, columns: buildCaseColumns((c) => run.mutate(c), run.isPending), getRowId: (row) => row.id })
  const resultTable = useDataTable({ data: resultRows, columns: resultColumns, getRowId: (row) => row.id })
  const tally = (s: RetestState) => resultRows.filter((r) => r.state === s).length

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Retesting"
          description="Replay verified findings through the normal runtime and record what actually happened. A fix is only recorded when the retest ran, the control still worked and the behaviour is gone — a missing session, changed route or unavailable tool is a gap, never a fix."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={previous}
                onChange={(e) => setPrevious(e.target.value)}
                placeholder="previous assessment id"
                className="w-44 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg"
              />
              <Button size="sm" onClick={() => plan.mutate()} disabled={plan.isPending || previous.trim().length < 6}>
                {plan.isPending ? 'Planning…' : 'Plan retests'}
              </Button>
            </div>
          }
        />
        <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
          <Metric label="Fixed" value={tally('fixed')} tone={tally('fixed') ? 'success' : 'muted'} />
          <Metric label="Still present" value={tally('still-present')} tone={tally('still-present') ? 'high' : 'muted'} />
          <Metric label="Regressed" value={tally('regressed')} tone={tally('regressed') ? 'critical' : 'muted'} />
          <Metric label="Cannot reproduce" value={tally('cannot-reproduce')} tone="medium" />
          <Metric label="Blocked" value={tally('blocked') + tally('not-tested')} tone="muted" />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Retest cases" description="Each verified finding as a replayable case. The eligibility column names the exact blocker when a case cannot run." />
        {cases.isError ? (
          <ErrorState title="Could not load retest cases" error={cases.error} onRetry={() => void cases.refetch()} />
        ) : (
          <DataTable
            table={caseTable}
            isLoading={cases.isLoading}
            minWidth="min-w-150"
            empty={<EmptyState icon={RefreshCw} title="No retest cases yet" description="Retest cases are derived from verified findings. Plan retests from a previous assessment, or build them from this assessment's findings." />}
          />
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Retest results" description="The historical outcome of each replay. Fixed and cannot-reproduce are deliberately distinct." />
        {results.isError ? (
          <ErrorState title="Could not load retest results" error={results.error} onRetry={() => void results.refetch()} />
        ) : (
          <DataTable table={resultTable} isLoading={results.isLoading} minWidth="min-w-150" empty={<EmptyState icon={RefreshCw} title="No retests run yet" description="Run a retest from a case above to record a historical result." />} />
        )}
      </Panel>
    </div>
  )
}
