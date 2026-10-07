import type { AuditDetail, PageItem } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { ExternalLink, Globe, Search, SearchX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DataTable, useDataTable } from '@/components/data-table'
import { Toolbar, ToolbarSpacer } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useAuditNav } from '@/features/audit/audit-nav'
import { pluralize, titleCase, urlPath } from '@/lib/format'
import { isTerminal, pagesQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

type All = 'all'
type StatusFilter = All | 'ok' | 'redirect' | 'error' | 'unfetched'
type InspectFilter = All | 'inspected' | 'not-inspected' | 'with-findings'

const SOURCE_LABEL: Record<string, string> = {
  start: 'Start URL',
  link: 'Internal link',
  sitemap: 'Sitemap',
  ai: 'AI auditor',
  katana: 'Katana crawl',
}

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? titleCase(source)
}

function statusGroup(status: number | null): Exclude<StatusFilter, All> {
  if (status === null) return 'unfetched'
  if (status >= 400) return 'error'
  if (status >= 300) return 'redirect'
  return 'ok'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const column = createColumnHelper<PageItem>()

export function PagesTab({ audit }: { audit: AuditDetail }) {
  const pages = useQuery(pagesQuery(audit.id))
  const nav = useAuditNav()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [source, setSource] = useState<string>('all')
  const [lang, setLang] = useState<string>('all')
  const [inspect, setInspect] = useState<InspectFilter>('all')

  const list = useMemo(() => pages.data ?? [], [pages.data])
  const siteHost = hostOf(audit.normalizedUrl)
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return list.filter(
      (page) =>
        (status === 'all' || statusGroup(page.status) === status) &&
        (source === 'all' || page.source === source) &&
        (lang === 'all' || (page.lang ?? 'none') === lang) &&
        (inspect === 'all' ||
          (inspect === 'inspected' && page.inspectedInBrowser) ||
          (inspect === 'not-inspected' && !page.inspectedInBrowser) ||
          (inspect === 'with-findings' && page.findingCount > 0)) &&
        (!needle || `${page.url} ${page.title ?? ''} ${page.pageType ?? ''}`.toLowerCase().includes(needle)),
    )
  }, [list, search, status, source, lang, inspect])

  const columns = useMemo(
    () => [
      column.accessor('url', {
        header: 'Page',
        cell: ({ row }) => {
          const page = row.original
          const external = siteHost && hostOf(page.url) !== siteHost
          return (
            <div className="min-w-0 py-1">
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex max-w-full items-center gap-1 font-mono text-xs text-foreground hover:underline"
                title={page.url}
              >
                <span className="truncate">{external ? page.url.replace(/^https?:\/\//, '') : urlPath(page.url)}</span>
                <ExternalLink className="size-3 shrink-0 text-subtle opacity-0 group-hover:opacity-100" />
              </a>
              {page.title ? (
                <div className="truncate text-2xs text-subtle" dir="auto" title={page.title}>
                  {page.title}
                </div>
              ) : null}
            </div>
          )
        },
        meta: { className: 'w-full max-w-0 min-w-48' },
      }),
      column.accessor((page) => page.pageType ?? '', {
        id: 'type',
        header: 'Type',
        cell: ({ getValue }) =>
          getValue() ? (
            <span className="text-xs whitespace-nowrap text-muted">{getValue()}</span>
          ) : (
            <span className="text-subtle">—</span>
          ),
        meta: { className: 'hidden w-1 lg:table-cell' },
      }),
      column.accessor((page) => page.status ?? -1, {
        id: 'status',
        header: 'HTTP',
        cell: ({ row }) => {
          const value = row.original.status
          return (
            <span
              className={cn(
                'font-mono text-xs tabular-nums',
                value === null ? 'text-subtle' : value >= 400 ? 'text-critical' : value >= 300 ? 'text-medium' : 'text-muted',
              )}
              title={value === null ? 'Not fetched by the crawler' : undefined}
            >
              {value ?? '—'}
            </span>
          )
        },
        meta: { className: 'w-1', align: 'right' },
      }),
      column.accessor((page) => page.lang ?? '', {
        id: 'lang',
        header: 'Lang',
        cell: ({ row }) =>
          row.original.lang ? (
            <span className="font-mono text-xs whitespace-nowrap text-muted">
              {row.original.lang}
              {row.original.dir === 'rtl' ? <span className="text-subtle"> · rtl</span> : null}
            </span>
          ) : (
            <span className="text-subtle">—</span>
          ),
        meta: { className: 'hidden w-1 sm:table-cell' },
      }),
      column.accessor('depth', {
        header: 'Depth',
        cell: ({ getValue }) => <span className="font-mono text-xs text-muted tabular-nums">{getValue()}</span>,
        meta: { className: 'hidden w-1 md:table-cell', align: 'right' },
      }),
      column.accessor('source', {
        header: 'Found via',
        cell: ({ getValue }) => <span className="text-xs whitespace-nowrap text-muted">{sourceLabel(getValue())}</span>,
        meta: { className: 'hidden w-1 md:table-cell' },
      }),
      column.accessor('inspectedInBrowser', {
        header: 'Browser',
        cell: ({ getValue }) =>
          getValue() ? <Badge tone="neutral">Inspected</Badge> : <span className="text-xs text-subtle">—</span>,
        meta: { className: 'hidden w-1 sm:table-cell' },
      }),
      column.accessor('findingCount', {
        header: 'Findings',
        cell: ({ row }) => {
          const count = row.original.findingCount
          if (!count) return <span className="font-mono text-sm text-subtle">–</span>
          return (
            <button
              type="button"
              onClick={() => nav?.showPageFindings(row.original.url)}
              className="cursor-pointer font-mono text-sm font-medium text-foreground tabular-nums underline-offset-2 hover:underline"
              aria-label={`${pluralize(count, 'finding')} on ${urlPath(row.original.url)}`}
            >
              {count}
            </button>
          )
        },
        meta: { className: 'w-1', align: 'right' },
      }),
    ],
    [nav, siteHost],
  )

  const table = useDataTable({
    data: filtered,
    columns,
    getRowId: (page) => page.url,
    initialSorting: [{ id: 'depth', desc: false }],
  })

  if (pages.isError) {
    return (
      <Panel>
        <ErrorState title="Could not load pages" error={pages.error} onRetry={() => void pages.refetch()} />
      </Panel>
    )
  }

  const sources = [...new Set(list.map((page) => page.source))]
  const langs = [...new Set(list.map((page) => page.lang ?? 'none'))].sort()
  const errors = list.filter((page) => page.status !== null && page.status >= 400).length
  const inspected = list.filter((page) => page.inspectedInBrowser).length
  const filtering = search.trim() !== '' || status !== 'all' || source !== 'all' || lang !== 'all' || inspect !== 'all'
  const clear = () => {
    setSearch('')
    setStatus('all')
    setSource('all')
    setLang('all')
    setInspect('all')
  }

  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <Input
          icon={<Search />}
          placeholder="Search URL or title"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full sm:w-60"
          aria-label="Search pages"
        />
        <Select
          label="HTTP"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ok', label: '2xx' },
            { value: 'redirect', label: '3xx' },
            { value: 'error', label: '4xx / 5xx' },
            { value: 'unfetched', label: 'Not fetched' },
          ]}
        />
        <Select
          label="Found via"
          value={source}
          onValueChange={setSource}
          options={[{ value: 'all', label: 'All' }, ...sources.map((s) => ({ value: s, label: sourceLabel(s) }))]}
        />
        {langs.length > 1 ? (
          <Select
            label="Lang"
            value={lang}
            onValueChange={setLang}
            options={[
              { value: 'all', label: 'All' },
              ...langs.map((l) => ({ value: l, label: l === 'none' ? 'Not declared' : l })),
            ]}
          />
        ) : null}
        <Select
          label="Show"
          value={inspect}
          onValueChange={setInspect}
          options={[
            { value: 'all', label: 'All pages' },
            { value: 'inspected', label: 'Inspected in a browser' },
            { value: 'not-inspected', label: 'Not inspected' },
            { value: 'with-findings', label: 'With findings' },
          ]}
        />
        {filtering ? (
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        ) : null}
        <ToolbarSpacer />
        <span className="text-xs text-muted tabular-nums">
          {filtering ? `${filtered.length} of ${list.length}` : list.length} pages · {inspected} inspected
          {errors ? <span className="text-critical"> · {errors} with errors</span> : null}
        </span>
      </Toolbar>
      <Panel className="overflow-hidden">
        <DataTable
          table={table}
          isLoading={pages.isLoading}
          minWidth="min-w-0"
          empty={
            filtering ? (
              <EmptyState
                icon={SearchX}
                compact
                title="No pages match these filters"
                action={
                  <Button size="sm" onClick={clear}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Globe}
                compact
                title={isTerminal(audit.status) ? 'No pages were recorded' : 'Pages appear as the crawl runs'}
              />
            )
          }
        />
      </Panel>
      <p className="text-xs text-subtle">
        Pages come from the crawl (start URL, internal links, sitemap) and from pages the AI auditor opened. Pages the
        crawler did not fetch have no HTTP status.
      </p>
    </div>
  )
}
