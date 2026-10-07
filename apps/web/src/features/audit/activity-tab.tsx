import type { ActivityEvent, AuditDetail } from '@audivra/contracts'
import { History } from 'lucide-react'
import { useState } from 'react'
import { ActivityTimeline, matchesFilter, type ActivityFilter } from '@/components/activity-timeline'
import { Toolbar, ToolbarSpacer } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { SegmentedControl } from '@/components/ui/segmented-control'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'ai', label: 'AI' },
  { value: 'tools', label: 'Tools' },
  { value: 'evidence', label: 'Evidence' },
  { value: 'issues', label: 'Warnings' },
] as const satisfies readonly { value: ActivityFilter; label: string }[]

export function ActivityTab({
  audit,
  events,
  isLoading,
  error,
  onRetry,
  now,
}: {
  audit: AuditDetail
  events: ActivityEvent[]
  isLoading: boolean
  error: unknown
  onRetry: () => void
  now: number
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const count = events.filter((event) => matchesFilter(event, filter)).length

  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <SegmentedControl
          label="Filter activity"
          value={filter}
          onValueChange={setFilter}
          options={FILTERS}
        />
        <ToolbarSpacer />
        <span className="text-xs text-muted tabular-nums">{count} events</span>
      </Toolbar>
      <Panel className="overflow-hidden">
        {error ? (
          <ErrorState title="Could not load activity" error={error} onRetry={onRetry} />
        ) : isLoading ? (
          <LoadingState rows={8} />
        ) : count === 0 ? (
          <EmptyState
            icon={History}
            compact
            title={events.length ? 'No events match this filter' : 'No activity yet'}
          />
        ) : (
          <ActivityTimeline events={events} steps={audit.steps} filter={filter} now={now} />
        )}
      </Panel>
      <p className="text-xs text-subtle">
        The log records actions, tool runs, evidence and concise decision summaries. Model reasoning is never
        stored.
      </p>
    </div>
  )
}
