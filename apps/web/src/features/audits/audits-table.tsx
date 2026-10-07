import type { AuditListItem } from '@audivra/contracts'
import { useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { useMemo } from 'react'
import { StatusBadge } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { CountCell } from '@/components/metric'
import { useNow } from '@/lib/hooks'
import { durationBetween, formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { isTerminal } from '@/lib/queries'
import type { ReactNode } from 'react'

const column = createColumnHelper<AuditListItem>()

export function AuditsTable({
  audits,
  isLoading,
  empty,
}: {
  audits: AuditListItem[]
  isLoading: boolean
  empty: ReactNode
}) {
  const navigate = useNavigate()
  const anyRunning = audits.some((audit) => !isTerminal(audit.status))
  const now = useNow(anyRunning, 1000)

  const columns = useMemo(
    () => [
      column.accessor('domain', {
        header: 'Website',
        cell: ({ row }) => (
          <div className="min-w-0 py-1">
            <div className="truncate font-medium text-foreground">{row.original.domain}</div>
            <div className="truncate text-xs text-muted">{row.original.clientName ?? row.original.url}</div>
          </div>
        ),
        meta: { className: 'w-full max-w-0 min-w-36' },
      }),
      column.accessor('status', {
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={row.original.status} stage={row.original.stage} />,
        meta: { className: 'w-1' },
      }),
      column.accessor((audit) => audit.startedAt ?? audit.createdAt, {
        id: 'started',
        header: 'Started',
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap text-muted" title={formatDateTime(getValue())}>
            {formatRelative(getValue(), now)}
          </span>
        ),
        meta: { className: 'hidden w-1 sm:table-cell' },
      }),
      column.accessor((audit) => durationBetween(audit.startedAt, audit.finishedAt, now) ?? -1, {
        id: 'duration',
        header: 'Duration',
        cell: ({ getValue }) => {
          const value = getValue()
          return (
            <span className="font-mono text-sm whitespace-nowrap text-muted tabular-nums">
              {value < 0 ? '—' : formatDuration(value)}
            </span>
          )
        },
        meta: { className: 'hidden w-1 lg:table-cell', align: 'right' },
      }),
      column.accessor((audit) => audit.severityCounts.critical, {
        id: 'critical',
        header: 'Critical',
        cell: ({ getValue }) => <CountCell value={getValue()} tone="critical" />,
        meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
      }),
      column.accessor((audit) => audit.severityCounts.high, {
        id: 'high',
        header: 'High',
        cell: ({ getValue }) => <CountCell value={getValue()} tone="high" />,
        meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
      }),
      column.accessor((audit) => audit.severityCounts.medium, {
        id: 'medium',
        header: 'Medium',
        cell: ({ getValue }) => <CountCell value={getValue()} tone="medium" />,
        meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
      }),
      column.accessor('findingCount', {
        header: 'Findings',
        cell: ({ getValue }) => <CountCell value={getValue()} tone="default" />,
        meta: { className: 'w-1', align: 'right' },
      }),
    ],
    [now],
  )

  const table = useDataTable({
    data: audits,
    columns,
    getRowId: (audit) => audit.id,
    initialSorting: [{ id: 'started', desc: true }],
  })

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      minWidth="min-w-0"
      empty={empty}
      onRowClick={(audit) => void navigate({ to: '/audits/$auditId', params: { auditId: audit.id } })}
    />
  )
}
