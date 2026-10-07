import type { AgentRunItem, AuditDetail, PageItem, ToolRunItem } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Bot, FileText, Globe, Wrench } from 'lucide-react'
import { DataTable, useDataTable } from '@/components/data-table'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Tooltip } from '@/components/ui/tooltip'
import { artifactUrl } from '@/lib/api'
import { durationBetween, formatCost, formatDuration, humanizeKey, titleCase, urlPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { agentRunsQuery, pagesQuery, toolRunsQuery } from '@/lib/queries'

const RUN_TONE: Record<string, BadgeTone> = {
  running: 'running',
  completed: 'success',
  failed: 'critical',
  cancelled: 'neutral',
  skipped: 'neutral',
}

function RunStatus({ status }: { status: string }) {
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
    cell: ({ getValue }) => (
      <span className="font-medium whitespace-nowrap text-foreground">{titleCase(getValue())}</span>
    ),
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
  agentColumn.accessor((run) => durationBetween(run.startedAt, run.finishedAt) ?? 0, {
    id: 'duration',
    header: 'Duration',
    cell: ({ row }) => (
      <span className="font-mono text-xs whitespace-nowrap text-muted tabular-nums">
        {formatDuration(durationBetween(row.original.startedAt, row.original.finishedAt))}
      </span>
    ),
    meta: { className: 'w-1', align: 'right' },
  }),
  agentColumn.accessor('numTurns', {
    header: 'Turns',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-muted tabular-nums">{getValue() ?? '—'}</span>
    ),
    meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
  }),
  agentColumn.accessor('costUsd', {
    header: 'Cost',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-muted tabular-nums">{formatCost(getValue())}</span>
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
        <div className="font-medium whitespace-nowrap text-foreground">{row.original.tool}</div>
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

const pageColumn = createColumnHelper<PageItem>()
const pageColumns = [
  pageColumn.accessor('url', {
    header: 'URL',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <a
          href={row.original.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-xs text-foreground hover:underline"
          title={row.original.url}
        >
          {urlPath(row.original.url)}
        </a>
        {row.original.title ? (
          <div className="truncate text-2xs text-subtle">{row.original.title}</div>
        ) : null}
      </div>
    ),
    meta: { className: 'w-full max-w-0' },
  }),
  pageColumn.accessor('status', {
    header: 'HTTP',
    cell: ({ getValue }) => {
      const status = getValue()
      return (
        <span
          className={
            status && status >= 400 ? 'font-mono text-xs text-critical' : 'font-mono text-xs text-muted'
          }
        >
          {status ?? '—'}
        </span>
      )
    },
    meta: { className: 'w-1', align: 'right' },
  }),
  pageColumn.accessor('depth', {
    header: 'Depth',
    cell: ({ getValue }) => <span className="font-mono text-xs text-muted">{getValue()}</span>,
    meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
  }),
  pageColumn.accessor('source', {
    header: 'Found via',
    cell: ({ getValue }) => <span className="text-xs whitespace-nowrap text-muted">{getValue()}</span>,
    meta: { className: 'hidden w-1 sm:table-cell' },
  }),
  pageColumn.accessor('inspectedInBrowser', {
    header: 'Browser',
    cell: ({ getValue }) =>
      getValue() ? <Badge tone="neutral">Inspected</Badge> : <span className="text-xs text-subtle">—</span>,
    meta: { className: 'w-1' },
  }),
]

export function RunsTab({ audit }: { audit: AuditDetail }) {
  const agentRuns = useQuery(agentRunsQuery(audit.id))
  const toolRuns = useQuery(toolRunsQuery(audit.id))
  const pages = useQuery(pagesQuery(audit.id))

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
  const pageTable = useDataTable({
    data: pages.data ?? [],
    columns: pageColumns,
    getRowId: (page) => page.url,
    initialSorting: [{ id: 'depth', desc: false }],
  })

  return (
    <div className="flex flex-col gap-4">
      <Panel className="overflow-hidden">
        <PanelHeader
          title="AI runs"
          description="Auditor, reviewer, revision and finalizer runs with model, prompt version and validation results"
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
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Pages"
          description={pages.data ? `${pages.data.length} discovered` : 'Discovered during the crawl'}
        />
        {pages.isError ? (
          <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
        ) : (
          <DataTable
            table={pageTable}
            isLoading={pages.isLoading}
            minWidth="min-w-0"
            empty={<EmptyState icon={Globe} compact title="No pages discovered yet" />}
          />
        )}
      </Panel>
    </div>
  )
}
