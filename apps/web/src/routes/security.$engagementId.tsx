import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ShieldOff } from 'lucide-react'
import { PageFrame, pageFrame } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { buttonVariants } from '@/components/ui/button'
import { TabPanel, Tabs } from '@/components/ui/tabs'
import { ActivityTab } from '@/features/security/activity-tab'
import { AuthorizationTab } from '@/features/security/authorization-tab'
import { EngagementHeader } from '@/features/security/engagement-header'
import { ExecutionsTab } from '@/features/security/executions-tab'
import { OverviewTab } from '@/features/security/overview-tab'
import { PolicyTab } from '@/features/security/policy-tab'
import { ScopeTab } from '@/features/security/scope-tab'
import { ApiError } from '@/lib/api'
import { engagementQuery } from '@/lib/queries'

const TABS = ['overview', 'scope', 'authorization', 'policy', 'executions', 'activity'] as const
type EngagementTab = (typeof TABS)[number]

export const Route = createFileRoute('/security/$engagementId')({
  validateSearch: (search: Record<string, unknown>): { tab?: EngagementTab } => ({
    tab: TABS.includes(search.tab as EngagementTab) ? (search.tab as EngagementTab) : undefined,
  }),
  component: EngagementPage,
})

function EngagementPage() {
  const { engagementId } = Route.useParams()
  const navigate = Route.useNavigate()
  const tab: EngagementTab = Route.useSearch().tab ?? 'overview'
  const query = useQuery(engagementQuery(engagementId))

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404
    return (
      <PageFrame className="pt-5">
        <Panel>
          {missing ? (
            <EmptyState
              icon={ShieldOff}
              title="Engagement not found"
              action={
                <Link to="/security" className={buttonVariants({ size: 'sm' })}>
                  Back to security assessments
                </Link>
              }
            />
          ) : (
            <ErrorState title="Could not load the engagement" error={query.error} onRetry={() => void query.refetch()} />
          )}
        </Panel>
      </PageFrame>
    )
  }
  const engagement = query.data
  if (!engagement) {
    return (
      <PageFrame className="pt-5">
        <Panel>
          <LoadingState rows={8} />
        </Panel>
      </PageFrame>
    )
  }
  const notReady = engagement.readiness.checks.filter((c) => !c.ok).length
  return (
    <div className="pb-10">
      <EngagementHeader engagement={engagement} />
      <Tabs
        value={tab}
        onValueChange={(next) => void navigate({ search: { tab: next === 'overview' ? undefined : next }, replace: true })}
        listClassName={pageFrame}
        barClassName="bg-surface"
        items={[
          { value: 'overview', label: 'Overview', count: notReady || null },
          { value: 'scope', label: 'Scope' },
          { value: 'authorization', label: 'Authorization' },
          { value: 'policy', label: 'Policy' },
          { value: 'executions', label: 'Executions' },
          { value: 'activity', label: 'Audit trail' },
        ]}
      >
        <PageFrame className="pt-4">
          <TabPanel value="overview">
            <OverviewTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="scope">
            <ScopeTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="authorization">
            <AuthorizationTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="policy">
            <PolicyTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="executions">
            <ExecutionsTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="activity">
            <ActivityTab engagement={engagement} />
          </TabPanel>
        </PageFrame>
      </Tabs>
    </div>
  )
}
