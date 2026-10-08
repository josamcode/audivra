import type { SecurityEngagementDetail, SecurityEventItem } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, History } from 'lucide-react'
import { useState } from 'react'
import { DecisionBadge } from '@/components/badges'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { formatDateTime, formatRelative, humanizeKey } from '@/lib/format'
import { engagementEventsQuery, engagementEvidenceQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const actorText = (event: SecurityEventItem) =>
  event.actor.kind === 'agent' ? `Agent ${event.actor.agentRunId ?? ''}` : event.actor.kind === 'system' ? 'Audivra' : (event.actor.id ?? 'User')

function EventRow({ event }: { event: SecurityEventItem }) {
  const [open, setOpen] = useState(false)
  const decision = event.decision
  const summary = (
    <>
      <ChevronRight className={cn('mt-0.5 size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90', !decision && 'invisible')} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-2xs text-subtle">{event.type}</span>
          {decision ? <DecisionBadge decision={decision.decision} /> : null}
          <span className="text-xs text-subtle">{actorText(event)}</span>
        </div>
        <p className={cn('text-sm text-break', event.level === 'error' ? 'text-critical' : 'text-foreground')}>{event.message}</p>
      </div>
      <span className="shrink-0 text-xs whitespace-nowrap text-muted" title={formatDateTime(event.createdAt)}>
        {formatRelative(event.createdAt)}
      </span>
    </>
  )
  return (
    <li className="px-4 py-2.5">
      {/* Only decisions expand; other events are plain rows. */}
      {decision ? (
        <button type="button" className="flex w-full cursor-pointer items-start gap-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {summary}
        </button>
      ) : (
        <div className="flex items-start gap-3">{summary}</div>
      )}
      {open && decision ? (
        <div className="mt-2 ml-6 rounded-md border border-border bg-surface-muted p-3">
          <p className="mb-2 text-xs text-muted">
            Decided at stage <span className="font-medium text-foreground">{decision.stage}</span> by rule <span className="font-mono">{decision.rule}</span> · config v
            {decision.configVersion ?? '—'} · scope v{decision.scope?.version ?? '—'}
          </p>
          <ol className="flex flex-col gap-1">
            {decision.checks.map((check, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span className={cn('w-12 shrink-0 font-medium', check.outcome === 'pass' ? 'text-success' : check.outcome === 'fail' ? 'text-critical' : 'text-subtle')}>
                  {check.outcome}
                </span>
                <span className="w-24 shrink-0 text-muted">{humanizeKey(check.stage)}</span>
                <span className="min-w-0 text-foreground text-break">{check.reason}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </li>
  )
}

export function ActivityTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const events = useQuery(engagementEventsQuery(engagement.id))
  const evidence = useQuery(engagementEvidenceQuery(engagement.id))
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <Panel>
        <PanelHeader title="Security audit trail" description="Append-only: configuration changes and every capability decision, with the reason it was allowed or denied." />
        {events.isError ? (
          <ErrorState title="Could not load the audit trail" error={events.error} onRetry={() => void events.refetch()} />
        ) : events.isLoading ? (
          <LoadingState rows={5} />
        ) : events.data?.length ? (
          <ol className="divide-y divide-border">
            {[...events.data].reverse().map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ol>
        ) : (
          <EmptyState compact icon={History} title="No events yet" />
        )}
      </Panel>
      <Panel className="self-start">
        <PanelHeader title="Evidence" description="Recorded only by allowed capability executions, with full provenance." />
        {evidence.data?.length ? (
          <ul className="divide-y divide-border">
            {evidence.data.map((item) => (
              <li key={item.id} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-mono text-2xs text-muted">{item.ref}</span>
                  <span className="truncate text-sm text-foreground">{item.title}</span>
                </div>
                <p className="text-xs text-muted text-break">{item.summary}</p>
                <p className="font-mono text-2xs text-subtle">
                  {item.provenance.capabilityId} · {item.provenance.executionId} · scope v{item.provenance.scopeVersion}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact title="No evidence" description="Nothing has been executed for this engagement." />
        )}
      </Panel>
    </div>
  )
}
