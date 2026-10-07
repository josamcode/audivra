import {
  CATEGORIES,
  FINDING_TYPES,
  SEVERITIES,
  SEVERITY_RANK,
  type AuditDetail,
  type Category,
  type FindingItem,
  type FindingType,
  type Severity,
} from '@audivra/contracts'
import { createColumnHelper, type ColumnFiltersState, type FilterFn } from '@tanstack/react-table'
import { ListFilter, Search, SearchX, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Confidence,
  FINDING_TYPE,
  FindingTypeBadge,
  SEVERITY_LABEL,
  SeverityBadge,
  VERIFICATION,
} from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Toolbar, ToolbarSpacer } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { urlPath } from '@/lib/format'
import { isTerminal } from '@/lib/queries'

const column = createColumnHelper<FindingItem>()

/** URL equality that ignores a trailing slash and the fragment. */
function sameUrl(a: string, b: string): boolean {
  const norm = (url: string) => url.split('#')[0]!.replace(/\/+$/, '')
  return norm(a) === norm(b)
}

const searchFilter: FilterFn<FindingItem> = (row, _columnId, value: string) => {
  const needle = value.trim().toLowerCase()
  if (!needle) return true
  const f = row.original
  return [f.ref, f.title, f.description, f.observed, f.recommendation, f.category, ...f.affectedUrls]
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

const columns = [
  column.accessor('severity', {
    header: 'Severity',
    cell: ({ getValue }) => <SeverityBadge severity={getValue()} />,
    sortingFn: (a, b) =>
      SEVERITY_RANK[a.original.severity] - SEVERITY_RANK[b.original.severity] ||
      a.original.rank - b.original.rank,
    filterFn: 'equalsString',
    meta: { className: 'w-1' },
  }),
  column.accessor('category', {
    header: 'Category',
    cell: ({ getValue }) => <span className="whitespace-nowrap text-muted">{getValue()}</span>,
    filterFn: 'equalsString',
    meta: { className: 'hidden w-1 md:table-cell' },
  }),
  column.accessor('title', {
    header: 'Finding',
    cell: ({ row }) => (
      <div className="min-w-0 py-1.5">
        <div
          className="line-clamp-2 font-medium text-foreground sm:block sm:truncate"
          title={row.original.title}
        >
          {row.original.title}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-subtle">
          <span className="font-mono">{row.original.ref}</span>
          <span className="truncate md:hidden">· {row.original.category}</span>
        </div>
      </div>
    ),
    meta: { className: 'w-full max-w-0' },
  }),
  column.accessor((finding) => finding.affectedUrls[0] ?? '', {
    id: 'page',
    header: 'Page',
    cell: ({ row }) => {
      const urls = row.original.affectedUrls
      if (!urls.length) return <span className="text-subtle">—</span>
      return (
        <span
          className="flex max-w-48 items-center gap-1 font-mono text-xs text-muted"
          title={urls.join('\n')}
        >
          <span className="truncate">{urlPath(urls[0] ?? '')}</span>
          {urls.length > 1 ? <span className="shrink-0 text-subtle">+{urls.length - 1}</span> : null}
        </span>
      )
    },
    meta: { className: 'hidden w-1 lg:table-cell' },
  }),
  column.accessor('type', {
    header: 'Verification',
    cell: ({ row }) => (
      <div
        className="flex flex-col items-start gap-0.5 py-1"
        title={VERIFICATION[row.original.verificationStatus].hint}
      >
        <FindingTypeBadge type={row.original.type} short />
        <span className="text-2xs whitespace-nowrap text-subtle">
          {VERIFICATION[row.original.verificationStatus].label}
        </span>
      </div>
    ),
    filterFn: 'equalsString',
    meta: { className: 'hidden w-1 sm:table-cell' },
  }),
  column.accessor('confidence', {
    header: 'Confidence',
    cell: ({ getValue }) => <Confidence value={getValue()} />,
    meta: { className: 'hidden w-1 lg:table-cell' },
  }),
  column.accessor((finding) => finding.evidenceRefs.length, {
    id: 'evidence',
    header: 'Evidence',
    cell: ({ getValue }) => {
      const count = getValue()
      return (
        <span
          className={
            count ? 'font-mono text-sm text-foreground tabular-nums' : 'font-mono text-sm text-subtle'
          }
        >
          {count || '–'}
        </span>
      )
    },
    meta: { className: 'w-1', align: 'right' },
  }),
  column.accessor('rank', { header: 'Rank', enableHiding: true }),
]

type All = 'all'

export function FindingsTab({
  audit,
  findings,
  isLoading,
  error,
  onRetry,
  selectedRef,
  onSelect,
  pageFilter,
  onClearPageFilter,
}: {
  audit: AuditDetail
  findings: FindingItem[]
  isLoading: boolean
  error: unknown
  onRetry: () => void
  selectedRef: string | null
  onSelect: (ref: string) => void
  /** Only findings affecting this page (set from the Pages tab). */
  pageFilter: string | null
  onClearPageFilter: () => void
}) {
  const [search, setSearch] = useState('')
  const [severity, setSeverity] = useState<Severity | All>('all')
  const [category, setCategory] = useState<Category | All>('all')
  const [type, setType] = useState<FindingType | All>('all')

  const columnFilters = useMemo<ColumnFiltersState>(() => {
    const filters: ColumnFiltersState = []
    if (severity !== 'all') filters.push({ id: 'severity', value: severity })
    if (category !== 'all') filters.push({ id: 'category', value: category })
    if (type !== 'all') filters.push({ id: 'type', value: type })
    return filters
  }, [severity, category, type])

  const pageFindings = useMemo(
    () =>
      pageFilter ? findings.filter((f) => f.affectedUrls.some((url) => sameUrl(url, pageFilter))) : findings,
    [findings, pageFilter],
  )

  const table = useDataTable({
    data: pageFindings,
    columns,
    getRowId: (finding) => finding.ref,
    initialSorting: [{ id: 'rank', desc: false }],
    columnFilters,
    globalFilter: search,
    globalFilterFn: searchFilter,
    // Rank (the finalizer's priority order) drives the default sort but is not displayed.
    hiddenColumns: ['rank'],
  })

  const presentCategories = CATEGORIES.filter((c) => findings.some((f) => f.category === c))
  const filtered = table.getFilteredRowModel().rows.length
  const filtering = columnFilters.length > 0 || search.trim() !== '' || pageFilter !== null
  const clear = () => {
    setSearch('')
    setSeverity('all')
    setCategory('all')
    setType('all')
    if (pageFilter) onClearPageFilter()
  }

  const emptyState = filtering ? (
    <EmptyState
      icon={SearchX}
      compact
      title="No findings match these filters"
      action={
        <Button size="sm" onClick={clear}>
          Clear filters
        </Button>
      }
    />
  ) : !isTerminal(audit.status) ? (
    <EmptyState
      icon={ListFilter}
      title="Findings appear when the audit is finalized"
      description="The auditor is still collecting evidence. Baseline evidence is already browsable in the Evidence tab."
    />
  ) : !audit.aiEnabled ? (
    <EmptyState
      icon={ListFilter}
      title="No findings — baseline-only audit"
      description="AI was disabled, so no findings were written. The baseline evidence is preserved in the Evidence tab."
    />
  ) : (
    <EmptyState
      icon={ListFilter}
      title="No findings"
      description={
        audit.status === 'completed'
          ? 'The audit completed without material findings.'
          : 'The AI stages did not produce findings. Baseline evidence is preserved in the Evidence tab.'
      }
    />
  )

  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <Input
          icon={<Search />}
          placeholder="Search findings"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full sm:w-64"
          aria-label="Search findings"
        />
        {pageFilter ? (
          <button
            type="button"
            onClick={onClearPageFilter}
            className="inline-flex h-8 max-w-64 cursor-pointer items-center gap-1.5 rounded-md border border-border-strong bg-surface-selected px-2.5 text-sm text-foreground hover:bg-surface-hover"
            aria-label={`Remove page filter ${pageFilter}`}
            title={pageFilter}
          >
            <span className="text-muted">Page</span>
            <span className="truncate font-mono text-xs">{urlPath(pageFilter)}</span>
            <X className="size-3.5 shrink-0 text-subtle" />
          </button>
        ) : null}
        <Select
          label="Severity"
          value={severity}
          onValueChange={setSeverity}
          options={[
            { value: 'all', label: 'All' },
            ...SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] })),
          ]}
        />
        <Select
          label="Category"
          value={category}
          onValueChange={setCategory}
          options={[
            { value: 'all', label: 'All' },
            ...presentCategories.map((c) => ({ value: c, label: c })),
          ]}
        />
        <Select
          label="Type"
          value={type}
          onValueChange={setType}
          options={[
            { value: 'all', label: 'All' },
            ...FINDING_TYPES.map((t) => ({ value: t, label: FINDING_TYPE[t].label })),
          ]}
        />
        {filtering ? (
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        ) : null}
        <ToolbarSpacer />
        <span className="text-xs text-muted tabular-nums">
          {filtering ? `${filtered} of ${findings.length}` : findings.length} findings
        </span>
      </Toolbar>
      <Panel className="overflow-hidden">
        {error ? (
          <ErrorState title="Could not load findings" error={error} onRetry={onRetry} />
        ) : (
          <DataTable
            table={table}
            isLoading={isLoading}
            minWidth="min-w-0"
            selectedRowId={selectedRef}
            onRowClick={(finding) => onSelect(finding.ref)}
            empty={emptyState}
          />
        )}
      </Panel>
    </div>
  )
}
