import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus, ScanSearch } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { AuditsTable } from '@/features/audits/audits-table'
import { PriorityFollowUps } from '@/features/audits/follow-ups'
import { RecentActivity } from '@/features/audits/recent-activity'
import { RepeatIssues } from '@/features/audits/repeat-issues'
import { RunningNow } from '@/features/audits/running-now'
import { SummaryStrip, SummaryStripSkeleton } from '@/features/audits/summary-strip'
import { SystemHealthPanel } from '@/features/audits/system-health'
import { pluralize } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { dashboardQuery, systemHealthQuery } from '@/lib/queries'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { benchmark?: boolean } => ({
    benchmark: search.benchmark === true || search.benchmark === '1' || search.benchmark === 'true' ? true : undefined,
  }),
  component: AuditsHome,
})

/** Main column and a ~25% rail on wide screens; the rail drops below the main column on narrow ones. */
const LAYOUT = 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start 2xl:grid-cols-[minmax(0,1fr)_22rem]'

function HomeSkeleton() {
  return (
    <>
      <SummaryStripSkeleton />
      <div className={LAYOUT}>
        <Panel>
          <LoadingState rows={8} />
        </Panel>
        <Panel>
          <LoadingState rows={5} />
        </Panel>
      </div>
    </>
  )
}

function AuditsHome() {
  const showBenchmark = Route.useSearch().benchmark === true
  const navigate = Route.useNavigate()
  const dashboard = useQuery(dashboardQuery(showBenchmark))
  const health = useQuery(systemHealthQuery())
  const data = dashboard.data
  const now = useNow(true, data?.active.length ? 1000 : 30_000)
  const benchmarkAudits = data?.summary.benchmarkAudits ?? 0
  const setShowBenchmark = (next: boolean) =>
    void navigate({ search: { benchmark: next ? true : undefined }, replace: true })

  return (
    <div className="mx-auto max-w-screen-2xl pb-10">
      <PageHeader
        title="Audits"
        description="Track recent audits, site health, activity, and follow-up opportunities."
        actions={
          <>
            {benchmarkAudits || showBenchmark ? (
              <Switch
                checked={showBenchmark}
                onCheckedChange={setShowBenchmark}
                label="Show benchmark audits"
                hint={benchmarkAudits ? String(benchmarkAudits) : undefined}
              />
            ) : null}
            <Link to="/audits/new" className={buttonVariants({ variant: 'primary' })}>
              <Plus />
              New audit
            </Link>
          </>
        }
      />
      <div className="flex flex-col gap-4 px-4 sm:px-6">
        {dashboard.isError ? (
          <div className={LAYOUT}>
            <Panel>
              <ErrorState title="Could not load audits" error={dashboard.error} onRetry={() => void dashboard.refetch()} />
            </Panel>
            <SystemHealthPanel now={now} />
          </div>
        ) : !data ? (
          <HomeSkeleton />
        ) : data.summary.totalAudits === 0 ? (
          <div className={LAYOUT}>
            <Panel>
              <EmptyState
                icon={ScanSearch}
                title="No audits yet"
                description="Run your first website audit to inspect performance, SEO, UX, security, tracking and business opportunities."
                action={
                  <div className="flex flex-col items-center gap-2">
                    <Link to="/audits/new" className={buttonVariants({ variant: 'primary' })}>
                      <Plus />
                      Start first audit
                    </Link>
                    {!showBenchmark && benchmarkAudits ? (
                      <Button variant="ghost" size="sm" onClick={() => setShowBenchmark(true)}>
                        Show {pluralize(benchmarkAudits, 'benchmark audit')}
                      </Button>
                    ) : null}
                  </div>
                }
              />
            </Panel>
            <SystemHealthPanel now={now} />
          </div>
        ) : (
          <>
            <SummaryStrip summary={data.summary} />
            <div className={LAYOUT}>
              <div className="flex min-w-0 flex-col gap-4">
                {data.active.length ? <RunningNow audits={data.active} now={now} engine={health.data?.engine} /> : null}
                <AuditsTable audits={data.audits} now={now} />
                <PriorityFollowUps items={data.followUps} websites={data.summary.websites} />
              </div>
              <div className="grid min-w-0 gap-4 md:grid-cols-2 md:items-start xl:grid-cols-1">
                <SystemHealthPanel now={now} />
                <RecentActivity items={data.activity} now={now} />
                <RepeatIssues sites={data.repeatSites} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
