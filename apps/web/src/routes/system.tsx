import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { PageFrame, PageHeader, pageFrame } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { ErrorState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { TabPanel, Tabs } from '@/components/ui/tabs'
import { ProcessesPanel } from '@/features/system/processes-panel'
import { QualityPanel } from '@/features/system/quality-panel'
import { ToolsPanel } from '@/features/system/tools-panel'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { benchmarksQuery, processesQuery, queryKeys, systemQuery } from '@/lib/queries'

const SYSTEM_TABS = ['tools', 'quality', 'processes'] as const
type SystemTab = (typeof SYSTEM_TABS)[number]

export const Route = createFileRoute('/system')({
  validateSearch: (search: Record<string, unknown>): { tab?: SystemTab } => ({
    tab: SYSTEM_TABS.includes(search.tab as SystemTab) ? (search.tab as SystemTab) : undefined,
  }),
  component: SystemPage,
})

function SystemPage() {
  const queryClient = useQueryClient()
  const navigate = Route.useNavigate()
  const tab: SystemTab = Route.useSearch().tab ?? 'tools'
  const system = useQuery(systemQuery())
  const benchmarks = useQuery({ ...benchmarksQuery(), enabled: tab === 'quality' })
  const processes = useQuery({ ...processesQuery(), enabled: tab === 'processes' })
  const [refreshing, setRefreshing] = useState(false)

  const recheck = async () => {
    setRefreshing(true)
    try {
      queryClient.setQueryData(queryKeys.system, await api.systemTools(true))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="pb-10">
      <PageHeader
        title="System"
        description={
          system.data
            ? `Local capabilities, audit quality and owned processes · tools checked ${formatRelative(system.data.checkedAt)}`
            : 'Local capabilities, audit quality and owned processes'
        }
        actions={
          tab === 'tools' ? (
            <Button onClick={() => void recheck()} disabled={refreshing}>
              <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
              Re-check tools
            </Button>
          ) : tab === 'processes' ? (
            <Button onClick={() => void processes.refetch()} disabled={processes.isFetching}>
              <RefreshCw className={processes.isFetching ? 'animate-spin' : undefined} />
              Refresh
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(next) => void navigate({ search: { tab: next === 'tools' ? undefined : next }, replace: true })}
        listClassName={pageFrame}
        items={[
          { value: 'tools', label: 'Tools', count: system.data?.tools.length ?? null },
          { value: 'quality', label: 'Quality' },
          { value: 'processes', label: 'Processes' },
        ]}
      >
        <PageFrame className="pt-4">
          <TabPanel value="tools">
            {system.isError ? (
              <Panel>
                <ErrorState
                  title="Could not load tool status"
                  error={system.error}
                  onRetry={() => void system.refetch()}
                />
              </Panel>
            ) : (
              <ToolsPanel data={system.data} isLoading={system.isLoading} />
            )}
          </TabPanel>
          <TabPanel value="quality">
            <QualityPanel
              runs={benchmarks.data ?? []}
              isLoading={benchmarks.isLoading}
              error={benchmarks.error}
              onRetry={() => void benchmarks.refetch()}
            />
          </TabPanel>
          <TabPanel value="processes">
            <ProcessesPanel
              processes={processes.data ?? []}
              isLoading={processes.isLoading}
              error={processes.error}
              onRetry={() => void processes.refetch()}
            />
          </TabPanel>
        </PageFrame>
      </Tabs>
    </div>
  )
}
