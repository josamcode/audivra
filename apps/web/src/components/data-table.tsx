import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type RowData,
  type SortingState,
  type Table,
  type TableMeta,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { LoadingState } from '@/components/states'
import { cn } from '@/lib/utils'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Classes for both header and cells (width, alignment, responsive hiding). */
    className?: string
    align?: 'left' | 'right'
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    /** Audit the table belongs to (for building artifact links in cells). */
    auditId?: string
  }
}

export interface UseDataTableOptions<T> {
  data: T[]
  columns: ColumnDef<T, never>[] | ColumnDef<T>[]
  getRowId: (row: T) => string
  initialSorting?: SortingState
  columnFilters?: ColumnFiltersState
  globalFilter?: string
  globalFilterFn?: FilterFn<T>
  /** Columns that exist for sorting/filtering but are not displayed. */
  hiddenColumns?: string[]
  meta?: TableMeta<T>
}

/** Creates a TanStack table with sorting + filtering wired in. Filters are controlled by the caller. */
export function useDataTable<T>({
  data,
  columns,
  getRowId,
  initialSorting = [],
  columnFilters,
  globalFilter,
  globalFilterFn,
  hiddenColumns = [],
  meta,
}: UseDataTableOptions<T>): Table<T> {
  const [sorting, setSorting] = useState<SortingState>(initialSorting)
  // TanStack Table v8 returns non-memoizable functions; this app does not use the React Compiler.
  // eslint-disable-next-line react-hooks/incompatible-library
  return useReactTable<T>({
    data,
    columns: columns as ColumnDef<T>[],
    getRowId: (row) => getRowId(row),
    meta,
    state: { sorting, columnFilters: columnFilters ?? [], globalFilter: globalFilter ?? '' },
    initialState: { columnVisibility: Object.fromEntries(hiddenColumns.map((id) => [id, false])) },
    onSortingChange: setSorting,
    // No pagination here. Auto-reset queues a state update whenever `data` changes identity, which
    // loops forever if a render passes a fresh array (e.g. `data ?? []` while a route unmounts).
    autoResetAll: false,
    globalFilterFn: globalFilterFn ?? 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })
}

/** Filter function for columns whose filter value is a list of allowed values. */
export const inList: FilterFn<unknown> = (row, columnId, filterValue: string[] | undefined) =>
  !filterValue?.length || filterValue.includes(String(row.getValue(columnId)))

export function DataTable<T>({
  table,
  onRowClick,
  selectedRowId,
  isLoading = false,
  empty,
  className,
  minWidth = 'min-w-180',
}: {
  table: Table<T>
  onRowClick?: (row: T) => void
  selectedRowId?: string | null
  isLoading?: boolean
  empty?: ReactNode
  className?: string
  /** Minimum table width before horizontal scrolling kicks in on narrow screens. */
  minWidth?: string
}) {
  const rows = table.getRowModel().rows
  return (
    <div className={cn('relative w-full overflow-x-auto', className)}>
      <table className={cn('w-full border-collapse text-sm', minWidth)}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b border-border">
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta
                const sortable = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'h-8 bg-surface-muted px-3 text-left text-xs font-medium whitespace-nowrap text-muted first:pl-4 last:pr-4',
                      meta?.align === 'right' && 'text-right',
                      meta?.className,
                    )}
                  >
                    {header.isPlaceholder ? null : sortable ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          'group inline-flex cursor-pointer items-center gap-1 hover:text-foreground',
                          meta?.align === 'right' && 'flex-row-reverse',
                          sorted && 'text-foreground',
                        )}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        {!isLoading && rows.length > 0 ? (
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                data-selected={selectedRowId === row.id || undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onRowClick(row.original)
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                className={cn(
                  'border-b border-border last:border-b-0',
                  onRowClick &&
                    'cursor-pointer outline-none hover:bg-surface-hover focus-visible:bg-surface-hover',
                  'data-selected:bg-surface-selected',
                )}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta
                  return (
                    <td
                      key={cell.id}
                      className={cn(
                        'h-10 px-3 align-middle first:pl-4 last:pr-4',
                        meta?.align === 'right' && 'text-right',
                        meta?.className,
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        ) : null}
      </table>
      {isLoading ? <LoadingState /> : rows.length === 0 ? empty : null}
    </div>
  )
}
