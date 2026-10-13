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
import { AccessTab } from '@/features/security/access-tab'
import { DomainTab } from '@/features/security/domain-tab'
import { GraphTab } from '@/features/security/graph-tab'
import { HypothesesTab } from '@/features/security/hypotheses-tab'
import { IdentitiesTab } from '@/features/security/identities-tab'
import { ObservationsTab } from '@/features/security/observations-tab'
import { OverviewTab } from '@/features/security/overview-tab'
import { PolicyTab } from '@/features/security/policy-tab'
import { ScopeTab } from '@/features/security/scope-tab'
import { ApiError } from '@/lib/api'
import { engagementQuery } from '@/lib/queries'

const TABS = ['overview', 'scope', 'authorization', 'identities', 'domain', 'access', 'policy', 'executions', 'observations', 'graph', 'hypotheses', 'activity'] as const
type EngagementTab = (typeof TABS)[number]
const ENTITY_ID = /^gn_[0-9a-z]{14}$/
const HYPOTHESIS_ID = /^hy_[0-9a-z]{14}$/

export const Route = createFileRoute('/security/$engagementId')({
  validateSearch: (search: Record<string, unknown>): { tab?: EngagementTab; entity?: string; hypothesis?: string } => ({
    tab: TABS.includes(search.tab as EngagementTab) ? (search.tab as EngagementTab) : undefined,
    entity: typeof search.entity === 'string' && ENTITY_ID.test(search.entity) ? search.entity : undefined,
    hypothesis: typeof search.hypothesis === 'string' && HYPOTHESIS_ID.test(search.hypothesis) ? search.hypothesis : undefined,
  }),
  component: EngagementPage,
})

function EngagementPage() {
  const { engagementId } = Route.useParams()
  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const tab: EngagementTab = search.tab ?? 'overview'
  // Cross-navigation between the graph and the hypotheses keeps the selection in the URL.
  const showEntity = (entity: string) => void navigate({ search: { tab: 'graph', entity }, replace: true })
  const showHypothesis = (hypothesis: string) => void navigate({ search: { tab: 'hypotheses', hypothesis }, replace: true })
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
          { value: 'identities', label: 'Identities' },
          { value: 'domain', label: 'Domain' },
          { value: 'access', label: 'Access' },
          { value: 'policy', label: 'Policy' },
          { value: 'executions', label: 'Executions' },
          { value: 'observations', label: 'Observations' },
          { value: 'graph', label: 'Graph' },
          { value: 'hypotheses', label: 'Hypotheses' },
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
          <TabPanel value="identities">
            <IdentitiesTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="domain">
            <DomainTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="access">
            <AccessTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="policy">
            <PolicyTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="executions">
            <ExecutionsTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="observations">
            <ObservationsTab engagement={engagement} />
          </TabPanel>
          <TabPanel value="graph">
            <GraphTab engagement={engagement} entity={search.entity} onEntity={showEntity} onHypothesis={showHypothesis} />
          </TabPanel>
          <TabPanel value="hypotheses">
            <HypothesesTab engagement={engagement} hypothesis={search.hypothesis} onHypothesis={showHypothesis} onEntity={showEntity} />
          </TabPanel>
          <TabPanel value="activity">
            <ActivityTab engagement={engagement} />
          </TabPanel>
        </PageFrame>
      </Tabs>
    </div>
  )
}
