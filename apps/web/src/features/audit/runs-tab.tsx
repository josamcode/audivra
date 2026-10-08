import type { AgentRunItem, AuditDetail, ToolRunItem } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Bot, FileText, Wrench } from 'lucide-react'
import { ROLE_LABELS } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Tooltip } from '@/components/ui/tooltip'
import { artifactUrl } from '@/lib/api'
import { durationBetween, formatCost, formatDuration, humanizeKey, titleCase, urlPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { agentRunsQuery, toolRunsQuery } from '@/lib/queries'

const COST_HINT = 'API-equivalent estimate (subscription usage is metered differently)'

const TERMINATION: Record<string, { label: string; tone: string }> = {
  completed: { label: 'Completed', tone: 'text-muted' },
  'budget-wrapup': { label: 'Wrapped up at budget', tone: 'text-medium' },
  'max-turns': { label: 'Hit max turns', tone: 'text-medium' },
  timeout: { label: 'Timed out', tone: 'text-critical' },
  cancelled: { label: 'Cancelled', tone: 'text-muted' },
  error: { label: 'Error', tone: 'text-critical' },
  'invalid-output': { label: 'Invalid output', tone: 'text-critical' },
}

function runDuration(run: AgentRunItem): number | null {
  return run.durationMs ?? durationBetween(run.startedAt, run.finishedAt)
}

function toolCallSummary(calls: Record<string, number> | null): string | null {
  if (!calls) return null
  const entries = Object.entries(calls).filter(([, count]) => count > 0)
  if (!entries.length) return null
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${kind}`)
    .join(' · ')
}

const RUN_TONE: Record<string, BadgeTone> = {
  running: 'running',
  completed: 'success',
  failed: 'critical',
  cancelled: 'neutral',
  skipped: 'neutral',
}

export function RunStatus({ status }: { status: string }) {
  return (
    <Badge tone={RUN_TONE[status] ?? 'neutral'} dot>
      {titleCase(status)}
    </Badge>
  )
}

function validationSummary(validation: Record<string, unknown> | null): string | null {
  if (!validation) return null
  const parts: string[] = []
  for (const [key, value] of Object.entries(validation)) {
    if (Array.isArray(value)) {
      if (value.length) parts.push(`${humanizeKey(key)}: ${value.length}`)
    } else if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      parts.push(`${humanizeKey(key)}: ${String(value)}`)
    }
  }
  return parts.length ? parts.join(' · ') : null
}

function validationDetail(validation: Record<string, unknown> | null): string | null {
  if (!validation) return null
  const lines: string[] = []
  for (const [key, value] of Object.entries(validation)) {
    if (Array.isArray(value))
      for (const item of value.slice(0, 12))
        lines.push(`${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)
  }
  return lines.length ? lines.join('\n') : null
}

const agentColumn = createColumnHelper<AgentRunItem>()
const agentColumns = [
  agentColumn.accessor('role', {
    header: 'Role',
    cell: ({ row }) => {
      const termination = row.original.terminationReason
      const known = termination ? TERMINATION[termination] : undefined
      return (
        <div className="min-w-0 py-1">
          <div className="font-medium whitespace-nowrap text-foreground">
            {ROLE_LABELS[row.original.role] ?? titleCase(row.original.role)}
          </div>
          {termination && termination !== 'completed' ? (
            <div className={cn('text-2xs whitespace-nowrap', known?.tone ?? 'text-muted')}>
              {known?.label ?? titleCase(termination)}
            </div>
          ) : null}
        </div>
      )
    },
    meta: { className: 'w-1' },
  }),
  agentColumn.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => <RunStatus status={getValue()} />,
    meta: { className: 'w-1' },
  }),
  agentColumn.accessor('model', {
    header: 'Model',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-foreground">{row.original.model ?? 'default'}</div>
        <div className="truncate text-2xs text-subtle">
          {row.original.provider} · prompt {row.original.promptVersion}
        </div>
      </div>
    ),
    meta: { className: 'max-w-56' },
  }),
  agentColumn.accessor((run) => runDuration(run) ?? 0, {
    id: 'duration',
    header: 'Duration',
    cell: ({ row }) => (
      <span className="font-mono text-xs whitespace-nowrap text-muted tabular-nums">
        {formatDuration(runDuration(row.original))}
      </span>
    ),
    meta: { className: 'w-1', align: 'right' },
  }),
  agentColumn.accessor((run) => toolCallSummary(run.toolCalls) ?? '', {
    id: 'tools',
    header: 'Tool calls',
    enableSorting: false,
    cell: ({ row }) => {
      const summary = toolCallSummary(row.original.toolCalls)
      return summary ? (
        <span className="block text-xs text-muted">{summary}</span>
      ) : (
        <span className="text-xs text-subtle">—</span>
      )
    },
    meta: { className: 'hidden min-w-32 lg:table-cell' },
  }),
  agentColumn.accessor('numTurns', {
    header: 'Turns',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-muted tabular-nums">{getValue() ?? '—'}</span>
    ),
    meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
  }),
  agentColumn.accessor('costUsd', {
    // Not sortable: a sort button would wrap the focusable hint below.
    enableSorting: false,
    header: () => (
      <Tooltip content={COST_HINT}>
        <span tabIndex={0} className="underline decoration-border-strong decoration-dotted underline-offset-2 outline-none">
          Cost est.
        </span>
      </Tooltip>
    ),
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-muted tabular-nums" title={COST_HINT}>
        {formatCost(getValue())}
      </span>
    ),
    meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
  }),
  agentColumn.display({
    id: 'notes',
    header: 'Validation / error',
    cell: ({ row }) => {
      const error = row.original.error
      if (error) return <span className="block text-xs text-critical text-break">{error}</span>
      const summary = validationSummary(row.original.validation)
      const detail = validationDetail(row.original.validation)
      if (!summary) return <span className="text-xs text-subtle">—</span>
      return (
        <Tooltip
          content={detail ? <pre className="font-mono text-2xs whitespace-pre-wrap">{detail}</pre> : null}
        >
          <span className="block text-xs text-muted text-break">{summary}</span>
        </Tooltip>
      )
    },
    meta: { className: 'hidden min-w-56 md:table-cell' },
  }),
]

const toolColumn = createColumnHelper<ToolRunItem>()
const toolColumns = [
  toolColumn.accessor('tool', {
    header: 'Tool',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div className="font-medium whitespace-nowrap text-foreground">
          {row.original.tool}
          {row.original.via ? <span className="ml-1.5 text-2xs font-normal text-subtle">via {row.original.via}</span> : null}
        </div>
        <div className="truncate text-2xs text-subtle">{row.original.purpose}</div>
      </div>
    ),
    meta: { className: 'max-w-64' },
  }),
  toolColumn.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => <RunStatus status={getValue()} />,
    meta: { className: 'w-1' },
  }),
  toolColumn.accessor('url', {
    header: 'Target',
    cell: ({ getValue }) => {
      const url = getValue()
      return url ? (
        <span className="block max-w-56 truncate font-mono text-xs text-muted" title={url}>
          {urlPath(url)}
        </span>
      ) : (
        <span className="text-subtle">—</span>
      )
    },
    meta: { className: 'hidden md:table-cell' },
  }),
  toolColumn.accessor('durationMs', {
    header: 'Duration',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs whitespace-nowrap text-muted tabular-nums">
        {formatDuration(getValue())}
      </span>
    ),
    meta: { className: 'w-1', align: 'right' },
  }),
  toolColumn.display({
    id: 'output',
    header: 'Output',
    cell: ({ row, table }) => {
      const auditId = table.options.meta?.auditId ?? ''
      if (row.original.error) {
        return (
          <span
            className={cn(
              'block text-xs text-break',
              row.original.status === 'failed' ? 'text-critical' : 'text-muted',
            )}
          >
            {row.original.error}
          </span>
        )
      }
      if (!row.original.artifactPaths.length) return <span className="text-xs text-subtle">—</span>
      return (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          {row.original.artifactPaths.slice(0, 4).map((path) => (
            <a
              key={path}
              href={artifactUrl(auditId, path)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-2xs text-link hover:underline"
            >
              <FileText className="size-3" />
              {path.split('/').pop()}
            </a>
          ))}
        </div>
      )
    },
    meta: { className: 'hidden min-w-48 sm:table-cell' },
  }),
]

export function RunsTab({ audit }: { audit: AuditDetail }) {
  const agentRuns = useQuery(agentRunsQuery(audit.id))
  const toolRuns = useQuery(toolRunsQuery(audit.id))

  const agentTable = useDataTable({
    data: agentRuns.data ?? [],
    columns: agentColumns,
    getRowId: (run) => run.id,
  })
  const toolTable = useDataTable({
    data: toolRuns.data ?? [],
    columns: toolColumns,
    getRowId: (run) => run.id,
    meta: { auditId: audit.id },
  })

  return (
    <div className="flex flex-col gap-4">
      <Panel className="overflow-hidden">
        <PanelHeader
          title="AI runs"
          description="Auditor, reviewer, revision, finalizer, artifact planner and report composer — with model, prompt version, tool use and validation"
        />
        {agentRuns.isError ? (
          <ErrorState error={agentRuns.error} onRetry={() => void agentRuns.refetch()} />
        ) : (
          <DataTable
            table={agentTable}
            isLoading={agentRuns.isLoading}
            minWidth="min-w-0"
            empty={
              <EmptyState
                icon={Bot}
                compact
                title={audit.aiEnabled ? 'No AI runs yet' : 'AI disabled for this audit'}
                description={audit.aiEnabled ? 'AI runs start after the baseline completes.' : undefined}
              />
            }
          />
        )}
      </Panel>
      <Panel className="overflow-hidden">
        <PanelHeader title="Tool runs" description="Deterministic baseline tools and their raw outputs" />
        {toolRuns.isError ? (
          <ErrorState error={toolRuns.error} onRetry={() => void toolRuns.refetch()} />
        ) : (
          <DataTable
            table={toolTable}
            isLoading={toolRuns.isLoading}
            minWidth="min-w-0"
            empty={<EmptyState icon={Wrench} compact title="No tool runs yet" />}
          />
        )}
      </Panel>
      <p className="text-xs text-subtle">
        Costs are an {COST_HINT}. Tool calls are counted by Audivra per
        kind; model reasoning is never stored.
      </p>
    </div>
  )
}
