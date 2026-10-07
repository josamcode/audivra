import { TOOL_STATES, type SystemStatus } from '@audivra/contracts'
import { Bot } from 'lucide-react'
import { TOOL_STATE, ToolStateBadge } from '@/components/badges'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { ToolStatusTable } from '@/components/tool-status'

/** Local capabilities: the AI runtime, state counts and the full tool registry. */
export function ToolsPanel({ data, isLoading }: { data: SystemStatus | undefined; isLoading: boolean }) {
  const tools = data?.tools ?? []
  const claude = tools.find((tool) => tool.id === 'claude')
  const others = tools.filter((tool) => tool.id !== 'claude')
  const count = (state: string) => others.filter((tool) => tool.state === state).length
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="AI runtime"
          description="Runs the auditor, reviewer, finalizer, artifact planner and report composer"
        />
        <PanelBody className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-md border border-border text-muted">
              <Bot className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{claude?.name ?? 'Claude Code'}</span>
                {claude ? <ToolStateBadge state={claude.state} /> : null}
              </div>
              <p className="text-xs text-muted">
                {isLoading ? 'Checking…' : (claude?.detail ?? 'Not detected')}
                {claude?.version ? <span className="font-mono"> · v{claude.version}</span> : null}
                {claude?.via ? <span> · {claude.via}</span> : null}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-7 gap-y-3 sm:ml-auto">
            {TOOL_STATES.map((state) => (
              <Metric
                key={state}
                label={TOOL_STATE[state].label}
                value={isLoading ? '—' : count(state)}
                tone={
                  isLoading || count(state) === 0
                    ? 'muted'
                    : state === 'ready'
                      ? 'success'
                      : state === 'needs-setup'
                        ? 'medium'
                        : state === 'error'
                          ? 'critical'
                          : 'default'
                }
              />
            ))}
          </div>
        </PanelBody>
      </Panel>
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Tool registry"
          description="Optional tools that are missing never fail an audit — the capability is reported as not run."
        />
        <ToolStatusTable tools={others} isLoading={isLoading} />
      </Panel>
    </div>
  )
}
