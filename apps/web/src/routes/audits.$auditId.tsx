import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { EmptyState, ErrorState } from '@/components/states'
import { FindingDrawer } from '@/components/finding-drawer'
import { PageFrame, pageFrame } from '@/components/page-header'
import { buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TabPanel, Tabs } from '@/components/ui/tabs'
import { ActivityTab } from '@/features/audit/activity-tab'
import { AuditHeader } from '@/features/audit/audit-header'
import { AUDIT_TABS, AuditNavContext, type AuditNav, type AuditTab } from '@/features/audit/audit-nav'
import { EvidenceTab, type EvidenceView } from '@/features/audit/evidence-tab'
import { FindingsTab } from '@/features/audit/findings-tab'
import { defaultGraphFocus } from '@/features/audit/evidence-graph'
import { HistoryTab } from '@/features/audit/history-tab'
import { JourneysTab } from '@/features/audit/journeys-tab'
import { OverviewTab } from '@/features/audit/overview-tab'
import { PagesTab } from '@/features/audit/pages-tab'
import { RunsTab } from '@/features/audit/runs-tab'
import { VisualsTab } from '@/features/audit/visuals-tab'
import { ApiError } from '@/lib/api'
import { useNow } from '@/lib/hooks'
import {
  auditQuery,
  eventsQuery,
  evidenceQuery,
  findingsQuery,
  isPresenting,
  isTerminal,
  journeysQuery,
  pagesQuery,
  queryKeys,
  visualsQuery,
} from '@/lib/queries'
import { useAuditStream } from '@/lib/use-audit-stream'
import { cn } from '@/lib/utils'

export interface AuditSearch {
  tab?: AuditTab
  /** Finding ref open in the drawer. */
  finding?: string
  /** Evidence ref selected in the evidence tab. */
  ev?: string
  view?: EvidenceView
  /** Evidence graph focus, e.g. "finding:F3" (graph view). */
  focus?: string
  /** Where the graph was opened, once it has been re-centred (for Reset). */
  origin?: string
  /** Journey ref selected in the Journeys tab. */
  journey?: string
  /** Findings filtered to one affected page (opened from the Pages tab). */
  page?: string
  /** Earlier audit to compare with in the History tab (defaults to the previous one). */
  cmp?: string
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

export const Route = createFileRoute('/audits/$auditId')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    tab: AUDIT_TABS.includes(search.tab as AuditTab) ? (search.tab as AuditTab) : undefined,
    finding: text(search.finding),
    ev: text(search.ev),
    view: search.view === 'gallery' || search.view === 'graph' ? search.view : undefined,
    focus: text(search.focus),
    origin: text(search.origin),
    journey: text(search.journey),
    page: text(search.page),
    cmp: text(search.cmp),
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
      <div className="border-b border-border bg-surface">
        <div className={cn(pageFrame, 'flex flex-col gap-2 pt-5 pb-3')}>
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
  const queryClient = useQueryClient()
  const tab: AuditTab = search.tab ?? 'overview'

  const audit = useQuery(auditQuery(auditId))
  const live = audit.data ? !isTerminal(audit.data.status) : false
  const presenting = audit.data ? isPresenting(audit.data) : false
  const events = useQuery(eventsQuery(auditId))
  const stream = useAuditStream(auditId, live, events.isSuccess)
  // Fallback polling when the live stream is not connected, and while visuals are regenerated for a
  // finished audit (there is no stream then).
  useQuery({
    ...auditQuery(auditId),
    refetchInterval: (live && stream !== 'live') || presenting ? 4000 : false,
  })
  const findings = useQuery(findingsQuery(auditId))
  const evidence = useQuery(evidenceQuery(auditId))
  const visuals = useQuery({ ...visualsQuery(auditId), refetchInterval: presenting ? 4000 : false })
  // Read-only view of the pages cache (filled by the Pages tab) for the tab count.
  const pages = useQuery({ ...pagesQuery(auditId), enabled: false })
  const journeys = useQuery({ ...journeysQuery(auditId), enabled: !live })
  const now = useNow(live)

  // When regeneration finishes, refresh everything it produced.
  const wasPresenting = useRef(presenting)
  useEffect(() => {
    if (wasPresenting.current && !presenting) {
      for (const key of [
        queryKeys.visuals(auditId),
        queryKeys.report(auditId),
        queryKeys.exports(auditId),
        queryKeys.agentRuns(auditId),
        queryKeys.events(auditId),
      ])
        void queryClient.invalidateQueries({ queryKey: key })
    }
    wasPresenting.current = presenting
  }, [presenting, auditId, queryClient])

  const setSearch = useCallback(
    (patch: Partial<AuditSearch>, replace = false) =>
      void navigate({ search: (previous) => ({ ...previous, ...patch }), replace, resetScroll: false }),
    [navigate],
  )
  const openFinding = useCallback((ref: string) => setSearch({ finding: ref }), [setSearch])
  const nav = useMemo<AuditNav>(() => {
    // Leaving a tab drops its own state (selected evidence, graph focus, journey).
    const tabReset = { ev: undefined, view: undefined, focus: undefined, origin: undefined, journey: undefined, page: undefined }
    return {
      auditId,
      openFinding,
      openEvidence: (ref) => setSearch({ ...tabReset, tab: 'evidence', ev: ref, finding: undefined }),
      openTab: (next) => setSearch({ ...tabReset, tab: next }),
      showPageFindings: (url) => setSearch({ ...tabReset, tab: 'findings', page: url }),
      openGraph: (focus) => setSearch({ ...tabReset, tab: 'evidence', view: 'graph', focus, finding: undefined }),
      openJourney: (ref) => setSearch({ ...tabReset, tab: 'journeys', journey: ref, finding: undefined }),
    }
  }, [auditId, openFinding, setSearch])

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
  const visualList = visuals.data ?? []
  const selectedFinding = search.finding ? (findingList.find((f) => f.ref === search.finding) ?? null) : null

  return (
    <AuditNavContext.Provider value={nav}>
      <div className="pb-10">
        <AuditHeader audit={data} now={now} stream={stream} />
        <Tabs
          value={tab}
          onValueChange={nav.openTab}
          barClassName="bg-surface"
          listClassName={pageFrame}
          items={[
            { value: 'overview', label: 'Overview' },
            {
              value: 'findings',
              label: 'Findings',
              count: findings.data ? findingList.length : data.findingCount,
            },
            { value: 'journeys', label: 'Journeys', count: journeys.data?.journeys.length || null },
            { value: 'visuals', label: 'Visuals', count: visuals.data ? visualList.length : data.artifactCount },
            { value: 'evidence', label: 'Evidence', count: evidence.data?.length ?? data.evidenceCount },
            { value: 'pages', label: 'Pages', count: pages.data?.length ?? null },
            { value: 'history', label: 'History', count: data.siteAuditCount > 1 ? data.siteAuditCount : null },
            { value: 'activity', label: 'Activity', count: events.data?.length ?? null },
            { value: 'runs', label: 'Runs' },
          ]}
        >
          <PageFrame className="pt-4">
            <TabPanel value="overview">
              <OverviewTab
                audit={data}
                findings={findingList}
                visuals={visualList}
                visualsLoading={visuals.isLoading}
                presenting={presenting}
                onOpenFinding={openFinding}
              />
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
                pageFilter={search.page ?? null}
                onClearPageFilter={() => setSearch({ page: undefined }, true)}
              />
            </TabPanel>
            <TabPanel value="journeys">
              <JourneysTab
                audit={data}
                findings={findingList}
                selectedRef={search.journey ?? null}
                onSelect={(ref) => setSearch({ journey: ref ?? undefined }, true)}
              />
            </TabPanel>
            <TabPanel value="visuals">
              <VisualsTab
                audit={data}
                visuals={visualList}
                isLoading={visuals.isLoading}
                error={visuals.error}
                onRetry={() => void visuals.refetch()}
                presenting={presenting}
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
                onViewChange={(view) => setSearch({ view: view === 'list' ? undefined : view, focus: undefined, origin: undefined }, true)}
                graphFocus={
                  search.focus ??
                  defaultGraphFocus({
                    evidenceRef: search.ev,
                    findingRefs: findingList.map((f) => f.ref),
                    evidenceRefs: (evidence.data ?? []).map((e) => e.ref),
                  })
                }
                graphOrigin={search.origin ?? null}
                onGraphFocusChange={(focus, origin) => setSearch({ focus, origin: origin ?? undefined })}
              />
            </TabPanel>
            <TabPanel value="pages">
              <PagesTab audit={data} />
            </TabPanel>
            <TabPanel value="history">
              <HistoryTab
                audit={data}
                compareWith={search.cmp}
                onCompareWith={(id) => setSearch({ cmp: id }, true)}
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
          </PageFrame>
        </Tabs>
        <FindingDrawer
          auditId={auditId}
          finding={selectedFinding}
          findings={findingList}
          evidence={evidence.data ?? []}
          visuals={visualList}
          onClose={() => setSearch({ finding: undefined })}
          onSelect={(ref) => setSearch({ finding: ref }, true)}
        />
      </div>
    </AuditNavContext.Provider>
  )
}
