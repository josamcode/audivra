import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'
import { useCallback } from 'react'
import { EmptyState, ErrorState } from '@/components/states'
import { FindingDrawer } from '@/components/finding-drawer'
import { buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TabPanel, Tabs } from '@/components/ui/tabs'
import { ActivityTab } from '@/features/audit/activity-tab'
import { AuditHeader } from '@/features/audit/audit-header'
import { EvidenceTab, type EvidenceView } from '@/features/audit/evidence-tab'
import { FindingsTab } from '@/features/audit/findings-tab'
import { OverviewTab } from '@/features/audit/overview-tab'
import { RunsTab } from '@/features/audit/runs-tab'
import { ApiError } from '@/lib/api'
import { useNow } from '@/lib/hooks'
import { auditQuery, eventsQuery, evidenceQuery, findingsQuery, isTerminal } from '@/lib/queries'
import { useAuditStream } from '@/lib/use-audit-stream'

const TABS = ['overview', 'findings', 'evidence', 'activity', 'runs'] as const
type AuditTab = (typeof TABS)[number]

export interface AuditSearch {
  tab?: AuditTab
  /** Finding ref open in the drawer. */
  finding?: string
  /** Evidence ref selected in the evidence tab. */
  ev?: string
  view?: EvidenceView
}

export const Route = createFileRoute('/audits/$auditId')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    tab: TABS.includes(search.tab as AuditTab) ? (search.tab as AuditTab) : undefined,
    finding: typeof search.finding === 'string' && search.finding ? search.finding : undefined,
    ev: typeof search.ev === 'string' && search.ev ? search.ev : undefined,
    view: search.view === 'gallery' ? 'gallery' : undefined,
  }),
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(auditQuery(params.auditId))
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw notFound()
      throw error
    }
  },
  notFoundComponent: () => (
    <EmptyState
      icon={FileQuestion}
      title="Audit not found"
      description="It may have been deleted, or the link is wrong."
      action={
        <Link to="/" className={buttonVariants({ size: 'sm' })}>
          Back to audits
        </Link>
      }
    />
  ),
  pendingComponent: AuditSkeleton,
  component: AuditPage,
})

function AuditSkeleton() {
  return (
    <div>
      <div className="border-b border-border bg-surface px-4 pt-4 pb-3 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-3 w-72" />
          <Skeleton className="mt-2 h-4 w-full max-w-xl" />
        </div>
      </div>
    </div>
  )
}

function AuditPage() {
  const { auditId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab: AuditTab = search.tab ?? 'overview'

  const audit = useQuery(auditQuery(auditId))
  const live = audit.data ? !isTerminal(audit.data.status) : false
  const events = useQuery(eventsQuery(auditId))
  const stream = useAuditStream(auditId, live, events.isSuccess)
  // Fallback polling only when the live stream is not connected.
  useQuery({ ...auditQuery(auditId), refetchInterval: live && stream !== 'live' ? 5000 : false })
  const findings = useQuery(findingsQuery(auditId))
  const evidence = useQuery(evidenceQuery(auditId))
  const now = useNow(live)

  const setSearch = useCallback(
    (patch: Partial<AuditSearch>, replace = false) =>
      void navigate({ search: (previous) => ({ ...previous, ...patch }), replace, resetScroll: false }),
    [navigate],
  )
  const openFinding = useCallback((ref: string) => setSearch({ finding: ref }), [setSearch])

  if (audit.isError && !audit.data) {
    return (
      <ErrorState
        title="Could not load this audit"
        error={audit.error}
        onRetry={() => void audit.refetch()}
      />
    )
  }
  if (!audit.data) return <AuditSkeleton />
  const data = audit.data
  const findingList = findings.data ?? []
  const selectedFinding = search.finding ? (findingList.find((f) => f.ref === search.finding) ?? null) : null

  return (
    <div className="pb-10">
      <AuditHeader audit={data} now={now} stream={stream} />
      <Tabs
        value={tab}
        onValueChange={(next) => setSearch({ tab: next, ev: undefined, view: undefined })}
        barClassName="bg-surface px-4 sm:px-6"
        listClassName="mx-auto max-w-7xl"
        items={[
          { value: 'overview', label: 'Overview' },
          {
            value: 'findings',
            label: 'Findings',
            count: findings.data ? findingList.length : data.findingCount,
          },
          { value: 'evidence', label: 'Evidence', count: evidence.data?.length ?? data.evidenceCount },
          { value: 'activity', label: 'Activity', count: events.data?.length ?? null },
          { value: 'runs', label: 'Runs' },
        ]}
      >
        <div className="mx-auto max-w-7xl sm:px-6 px-4 pt-4">
          <TabPanel value="overview">
            <OverviewTab audit={data} findings={findingList} onOpenFinding={openFinding} />
          </TabPanel>
          <TabPanel value="findings">
            <FindingsTab
              audit={data}
              findings={findingList}
              isLoading={findings.isLoading}
              error={findings.error}
              onRetry={() => void findings.refetch()}
              selectedRef={search.finding ?? null}
              onSelect={openFinding}
            />
          </TabPanel>
          <TabPanel value="evidence">
            <EvidenceTab
              audit={data}
              evidence={evidence.data ?? []}
              isLoading={evidence.isLoading}
              error={evidence.error}
              onRetry={() => void evidence.refetch()}
              selectedRef={search.ev ?? null}
              view={search.view ?? 'list'}
              onSelect={(ref) => setSearch({ ev: ref ?? undefined }, true)}
              onViewChange={(view) => setSearch({ view: view === 'list' ? undefined : view }, true)}
            />
          </TabPanel>
          <TabPanel value="activity">
            <ActivityTab
              audit={data}
              events={events.data ?? []}
              isLoading={events.isLoading}
              error={events.error}
              onRetry={() => void events.refetch()}
              now={now}
            />
          </TabPanel>
          <TabPanel value="runs">
            <RunsTab audit={data} />
          </TabPanel>
        </div>
      </Tabs>
      <FindingDrawer
        auditId={auditId}
        finding={selectedFinding}
        findings={findingList}
        evidence={evidence.data ?? []}
        onClose={() => setSearch({ finding: undefined })}
        onSelect={(ref) => setSearch({ finding: ref }, true)}
      />
    </div>
  )
}
