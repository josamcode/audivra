import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Bot, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { ToolStateBadge } from '@/components/badges'
import { Metric } from '@/components/metric'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { ErrorState } from '@/components/states'
import { ToolStatusTable } from '@/components/tool-status'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { queryKeys, systemQuery } from '@/lib/queries'

export const Route = createFileRoute('/system')({
  component: SystemPage,
})

function SystemPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, error, refetch } = useQuery(systemQuery())
  const [refreshing, setRefreshing] = useState(false)
  const tools = data?.tools ?? []
  const claude = tools.find((tool) => tool.id === 'claude')
  const others = tools.filter((tool) => tool.id !== 'claude')
  const count = (state: string) => others.filter((tool) => tool.state === state).length

  const refresh = async () => {
    setRefreshing(true)
    try {
      queryClient.setQueryData(queryKeys.system, await api.systemTools(true))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="mx-auto max-w-7xl pb-10">
      <PageHeader
        title="System"
        description={
          data ? `Local capabilities · checked ${formatRelative(data.checkedAt)}` : 'Local capabilities'
        }
        actions={
          <Button onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            Re-check
          </Button>
        }
      />
      {isError ? (
        <div className="px-4 sm:px-6">
          <Panel>
            <ErrorState title="Could not load tool status" error={error} onRetry={() => void refetch()} />
          </Panel>
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-4 sm:px-6">
          <Panel>
            <PanelHeader title="AI runtime" description="Runs the auditor, reviewer and finalizer" />
            <PanelBody className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-md border border-border text-muted">
                  <Bot className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {claude?.name ?? 'Claude Code'}
                    </span>
                    {claude ? <ToolStateBadge state={claude.state} /> : null}
                  </div>
                  <p className="text-xs text-muted">
                    {isLoading ? 'Checking…' : (claude?.detail ?? 'Not detected')}
                    {claude?.version ? <span className="font-mono"> · v{claude.version}</span> : null}
                  </p>
                </div>
              </div>
              <div className="flex gap-8 sm:ml-auto">
                <Metric label="Ready" value={isLoading ? '—' : count('ready')} tone="success" />
                <Metric label="Available" value={isLoading ? '—' : count('available')} />
                <Metric label="Missing" value={isLoading ? '—' : count('missing')} tone="muted" />
                <Metric label="Disabled" value={isLoading ? '—' : count('disabled')} tone="muted" />
              </div>
            </PanelBody>
          </Panel>
          <Panel className="overflow-hidden">
            <PanelHeader
              title="Tool registry"
              description="Missing optional tools never fail an audit — the capability is marked as skipped."
            />
            <ToolStatusTable tools={others} isLoading={isLoading} />
          </Panel>
        </div>
      )}
    </div>
  )
}
