import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { FlaskConical, Plus, ScanSearch } from 'lucide-react'
import { useMemo } from 'react'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { AuditsTable } from '@/features/audits/audits-table'
import { pluralize } from '@/lib/format'
import { auditsQuery, isTerminal } from '@/lib/queries'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { benchmark?: boolean } => ({
    benchmark: search.benchmark === true || search.benchmark === '1' || search.benchmark === 'true' ? true : undefined,
  }),
  component: AuditsPage,
})

function AuditsPage() {
  const { data, isLoading, isError, error, refetch } = useQuery(auditsQuery())
  const showBenchmark = Route.useSearch().benchmark === true
  const navigate = Route.useNavigate()
  const all = useMemo(() => data ?? [], [data])
  const benchmarkCount = all.filter((audit) => audit.benchmark).length
  // Benchmark audits (fixture sites run by System → Quality) are hidden unless asked for.
  const audits = useMemo(() => (showBenchmark ? all : all.filter((audit) => !audit.benchmark)), [all, showBenchmark])
  const running = audits.filter((audit) => !isTerminal(audit.status)).length

  return (
    <div className="mx-auto max-w-7xl pb-10">
      <PageHeader
        title="Audits"
        description={
          data
            ? `${pluralize(audits.length, 'audit')}${running ? ` · ${running} in progress` : ''}${
                benchmarkCount && !showBenchmark ? ` · ${benchmarkCount} benchmark hidden` : ''
              }`
            : 'Evidence-backed website audits'
        }
        actions={
          <>
            {benchmarkCount ? (
              <Button
                variant="ghost"
                aria-pressed={showBenchmark}
                onClick={() => void navigate({ search: { benchmark: showBenchmark ? undefined : true }, replace: true })}
              >
                <FlaskConical />
                {showBenchmark ? 'Hide benchmark audits' : `Show benchmark audits (${benchmarkCount})`}
              </Button>
            ) : null}
            <Link to="/audits/new" className={buttonVariants({ variant: 'primary' })}>
              <Plus />
              New audit
            </Link>
          </>
        }
      />
      <div className="px-4 sm:px-6">
        <Panel className="overflow-hidden">
          {isError ? (
            <ErrorState title="Could not load audits" error={error} onRetry={() => void refetch()} />
          ) : (
            <AuditsTable
              audits={audits}
              isLoading={isLoading}
              empty={
                <EmptyState
                  icon={ScanSearch}
                  title="No audits yet"
                  description="Paste a website URL to run a baseline inspection followed by an autonomous, evidence-backed AI audit."
                  action={
                    <Link to="/audits/new" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                      <Plus />
                      New audit
                    </Link>
                  }
                />
              }
            />
          )}
        </Panel>
      </div>
    </div>
  )
}
