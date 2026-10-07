import type { ToolStatus } from '@audivra/contracts'
import { createColumnHelper } from '@tanstack/react-table'
import { ToolStateBadge } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/states'

const column = createColumnHelper<ToolStatus>()

const columns = [
  column.accessor('name', {
    header: 'Tool',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div className="font-medium text-foreground">{row.original.name}</div>
        {row.original.command ? (
          <div className="truncate font-mono text-2xs text-subtle" title={row.original.command}>
            {row.original.command.replaceAll('`', '')}
          </div>
        ) : null}
      </div>
    ),
    meta: { className: 'w-64 max-w-64' },
  }),
  column.accessor('group', {
    header: 'Capability',
    cell: ({ getValue }) => <span className="whitespace-nowrap text-muted">{getValue()}</span>,
    meta: { className: 'hidden w-1 sm:table-cell' },
  }),
  column.accessor('state', {
    header: 'State',
    cell: ({ getValue }) => <ToolStateBadge state={getValue()} />,
    meta: { className: 'w-1' },
  }),
  column.accessor('version', {
    header: 'Version',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs whitespace-nowrap text-muted">{getValue() ?? '—'}</span>
    ),
    meta: { className: 'w-1' },
  }),
  column.accessor('via', {
    header: 'Provided by',
    cell: ({ getValue }) => <span className="text-xs whitespace-nowrap text-muted">{getValue() ?? '—'}</span>,
    meta: { className: 'hidden w-1 md:table-cell' },
  }),
  column.accessor('detail', {
    header: 'Detail',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block text-xs text-muted text-break">
        {[row.original.optional ? null : 'Required', row.original.detail].filter(Boolean).join(' · ')}
      </span>
    ),
    meta: { className: 'hidden min-w-64 lg:table-cell' },
  }),
]

/** Registry table of local auditing capabilities. */
export function ToolStatusTable({ tools, isLoading }: { tools: ToolStatus[]; isLoading: boolean }) {
  const table = useDataTable({ data: tools, columns, getRowId: (tool) => tool.id })
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      minWidth="min-w-0"
      empty={<EmptyState compact title="No tools registered" />}
    />
  )
}
