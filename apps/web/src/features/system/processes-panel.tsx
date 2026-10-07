import type { OwnedProcessItem } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { Cpu } from 'lucide-react'
import { DataTable, useDataTable } from '@/components/data-table'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { durationBetween, formatDateTime, formatDuration, formatRelative } from '@/lib/format'

const STATUS: Record<OwnedProcessItem['status'], { label: string; tone: BadgeTone; hint: string }> = {
  running: { label: 'Running', tone: 'running', hint: 'Still running' },
  exited: { label: 'Exited', tone: 'neutral', hint: 'Finished on its own' },
  killed: { label: 'Stopped', tone: 'medium', hint: 'Stopped by Audivra (timeout or cancellation)' },
  reaped: {
    label: 'Cleaned up',
    tone: 'neutral',
    hint: 'Left running by an earlier worker; verified as the same process and stopped',
  },
  gone: { label: 'Gone', tone: 'neutral', hint: 'Had already ended when an earlier worker’s records were checked' },
}

const column = createColumnHelper<OwnedProcessItem>()
const columns = [
  column.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => (
      <Badge tone={STATUS[getValue()].tone} dot title={STATUS[getValue()].hint}>
        {STATUS[getValue()].label}
      </Badge>
    ),
    meta: { className: 'w-1' },
  }),
  column.accessor('tool', {
    header: 'Tool',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div className="font-medium whitespace-nowrap text-foreground">{row.original.tool}</div>
        <div className="font-mono text-2xs text-subtle tabular-nums">
          PID {row.original.pid}
          {row.original.containerName ? ` · ${row.original.containerName}` : ''}
        </div>
      </div>
    ),
    meta: { className: 'w-1' },
  }),
  column.accessor('command', {
    header: 'Command',
    enableSorting: false,
    cell: ({ getValue }) => (
      <span className="block max-w-xl truncate font-mono text-2xs text-muted" title={getValue()}>
        {getValue()}
      </span>
    ),
    meta: { className: 'hidden w-full max-w-0 md:table-cell' },
  }),
  column.accessor('auditId', {
    header: 'Audit',
    cell: ({ getValue }) => {
      const id = getValue()
      return id ? (
        <Link
          to="/audits/$auditId"
          params={{ auditId: id }}
          className="font-mono text-xs text-link hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {id}
        </Link>
      ) : (
        <span className="text-xs text-subtle">—</span>
      )
    },
    meta: { className: 'w-1' },
  }),
  column.accessor('startedAt', {
    header: 'Started',
    cell: ({ getValue }) => (
      <span className="text-xs whitespace-nowrap text-muted" title={formatDateTime(getValue())}>
        {formatRelative(getValue())}
      </span>
    ),
    meta: { className: 'hidden w-1 sm:table-cell' },
  }),
  column.accessor((p) => durationBetween(p.startedAt, p.endedAt) ?? 0, {
    id: 'ran',
    header: 'Ran for',
    cell: ({ row }) => (
      <span className="font-mono text-xs whitespace-nowrap text-muted tabular-nums">
        {formatDuration(durationBetween(row.original.startedAt, row.original.endedAt))}
      </span>
    ),
    meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
  }),
  column.accessor('exitCode', {
    header: 'Exit',
    cell: ({ getValue }) => {
      const code = getValue()
      return (
        <span className={code ? 'font-mono text-xs text-critical' : 'font-mono text-xs text-subtle'}>
          {code ?? '—'}
        </span>
      )
    },
    meta: { className: 'w-1', align: 'right' },
  }),
]

/** Processes and containers Audivra started; it only ever stops what it owns. */
export function ProcessesPanel({
  processes,
  isLoading,
  error,
  onRetry,
}: {
  processes: OwnedProcessItem[]
  isLoading: boolean
  error: unknown
  onRetry: () => void
}) {
  const table = useDataTable({
    data: processes,
    columns,
    getRowId: (p) => p.id,
    initialSorting: [{ id: 'startedAt', desc: true }],
  })
  const running = processes.filter((p) => p.status === 'running').length
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Owned processes"
        description="Browsers, scanners and containers Audivra started. Cleanup only targets these, by recorded PID or container name — never by process name."
        actions={
          <span className="font-mono text-xs text-muted tabular-nums">
            {running} running · {processes.length} recent
          </span>
        }
      />
      {error ? (
        <ErrorState title="Could not load processes" error={error} onRetry={onRetry} />
      ) : (
        <DataTable
          table={table}
          isLoading={isLoading}
          minWidth="min-w-0"
          empty={
            <EmptyState
              icon={Cpu}
              compact
              title="No processes recorded"
              description="Tool processes appear here while audits run and stay listed afterwards."
            />
          }
        />
      )}
    </Panel>
  )
}
