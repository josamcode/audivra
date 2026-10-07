import type { ActivityEvent, AuditStage, AuditStep } from '@audivra/contracts'
import {
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  FileCode2,
  Flag,
  Globe,
  MessageSquareText,
  MinusCircle,
  Paperclip,
  Play,
  Plus,
  ScanSearch,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { STAGE_LABELS, StepIcon } from '@/components/badges'
import { Button } from '@/components/ui/button'
import { durationBetween, formatDuration, formatTime, titleCase } from '@/lib/format'
import { cn } from '@/lib/utils'

export type ActivityFilter = 'all' | 'ai' | 'tools' | 'evidence' | 'issues'

export function matchesFilter(event: ActivityEvent, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'ai':
      return (
        event.type.startsWith('agent.') ||
        event.type.startsWith('review.') ||
        event.type === 'finding.created'
      )
    case 'tools':
      return event.type.startsWith('tool.') || event.type.startsWith('baseline.')
    case 'evidence':
      return event.type === 'evidence.created' || event.type === 'finding.created'
    case 'issues':
      return event.level !== 'info'
    default:
      return true
  }
}

const KIND_ICON: Record<string, LucideIcon> = {
  browser: Globe,
  terminal: SquareTerminal,
  file: FileCode2,
  evidence: Paperclip,
  search: Search,
}

function iconFor(event: ActivityEvent): { icon: LucideIcon; className: string } {
  const failed = event.level === 'error'
  const muted = 'text-subtle'
  switch (event.type) {
    case 'audit.created':
      return { icon: Plus, className: muted }
    case 'audit.started':
    case 'stage.started':
      return { icon: Play, className: 'text-running' }
    case 'audit.completed':
    case 'stage.completed':
    case 'baseline.completed':
      return { icon: CheckCircle2, className: 'text-success' }
    case 'audit.failed':
    case 'stage.failed':
      return { icon: XCircle, className: 'text-critical' }
    case 'audit.cancelled':
      return { icon: Ban, className: 'text-medium' }
    case 'stage.skipped':
    case 'tool.skipped':
      return { icon: MinusCircle, className: muted }
    case 'baseline.started':
      return { icon: ScanSearch, className: muted }
    case 'tool.started':
    case 'tool.completed':
      return { icon: Wrench, className: muted }
    case 'tool.failed':
      return { icon: Wrench, className: 'text-critical' }
    case 'agent.started':
    case 'agent.completed':
      return { icon: Bot, className: muted }
    case 'agent.failed':
      return { icon: Bot, className: 'text-critical' }
    case 'agent.note':
      return { icon: MessageSquareText, className: 'text-foreground' }
    case 'evidence.created':
      return { icon: Paperclip, className: muted }
    case 'finding.created':
      return { icon: Flag, className: muted }
    case 'review.started':
    case 'review.completed':
      return { icon: ClipboardCheck, className: muted }
    case 'agent.activity': {
      const kind = typeof event.data?.kind === 'string' ? event.data.kind : 'other'
      return { icon: KIND_ICON[kind] ?? CircleDot, className: failed ? 'text-critical' : muted }
    }
    default:
      return { icon: CircleDot, className: failed ? 'text-critical' : muted }
  }
}

const HIDDEN_DATA_KEYS = new Set(['stage', 'role', 'kind', 'agentRunId', 'toolRunId'])

function roleLabel(event: ActivityEvent): string | null {
  const role = event.data?.role
  return typeof role === 'string' ? titleCase(role) : null
}

function EventRow({ event }: { event: ActivityEvent }) {
  const [open, setOpen] = useState(false)
  const { icon: Icon, className } = iconFor(event)
  const details = Object.entries(event.data ?? {}).filter(
    ([key, value]) => !HIDDEN_DATA_KEYS.has(key) && value !== null && value !== '',
  )
  const role = roleLabel(event)
  const note = event.type === 'agent.note'
  const stageEvent = event.type.startsWith('stage.') || event.type.startsWith('audit.')

  return (
    <li className="group">
      <div className={cn('flex items-start gap-3 px-4 py-1.5', note && 'py-2')}>
        <time
          className="w-16 shrink-0 pt-px font-mono text-2xs text-subtle tabular-nums"
          dateTime={event.createdAt}
        >
          {formatTime(event.createdAt)}
        </time>
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', className)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-sm text-break',
              // Long tool commands stay scannable; expanding the row shows them in full.
              event.type === 'agent.activity' && !open && 'line-clamp-2',
              note ? 'text-foreground' : 'text-muted',
              stageEvent && 'font-medium text-foreground',
              event.level === 'warn' && 'text-medium',
              event.level === 'error' && 'text-critical',
            )}
          >
            {role ? <span className="mr-1.5 text-xs font-medium text-subtle">{role}</span> : null}
            {event.message}
          </p>
          {open && details.length ? (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-border bg-surface-muted px-2.5 py-1.5">
              {details.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-2xs text-subtle">{key}</dt>
                  <dd className="font-mono text-2xs text-muted text-break">
                    {typeof value === 'string' ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        {details.length ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Hide details' : 'Show details'}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-subtle opacity-60 transition hover:bg-surface-hover hover:text-foreground group-hover:opacity-100"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : null}
      </div>
    </li>
  )
}

interface StageGroup {
  key: string
  stage: AuditStage | null
  events: ActivityEvent[]
}

/** Groups the chronological log by the stage that was running when each event happened. */
export function groupByStage(events: ActivityEvent[]): StageGroup[] {
  const groups: StageGroup[] = []
  let current: StageGroup = { key: 'queued', stage: null, events: [] }
  groups.push(current)
  for (const event of events) {
    const stage = typeof event.data?.stage === 'string' ? (event.data.stage as AuditStage) : null
    if (event.type === 'stage.started' && stage && stage !== current.stage) {
      current = { key: `${stage}-${event.id}`, stage, events: [] }
      groups.push(current)
    }
    current.events.push(event)
  }
  return groups.filter((group) => group.events.length > 0)
}

const GROUP_LIMIT = 150

function StageSection({
  group,
  step,
  filter,
  now,
}: {
  group: StageGroup
  step: AuditStep | undefined
  filter: ActivityFilter
  now: number
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const visible = group.events.filter((event) => matchesFilter(event, filter))
  if (visible.length === 0) return null
  const shown = showAll ? visible : visible.slice(-GROUP_LIMIT)
  const duration = step ? durationBetween(step.startedAt, step.finishedAt, now) : null
  return (
    <section className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="sticky top-0 z-10 flex h-9 w-full cursor-pointer items-center gap-2 border-b border-border bg-surface-muted px-4 text-left"
      >
        <ChevronRight
          className={cn('size-3.5 text-subtle transition-transform', !collapsed && 'rotate-90')}
        />
        {step ? <StepIcon status={step.status} className="size-3.5" /> : null}
        <span className="text-sm font-medium text-foreground">
          {group.stage ? STAGE_LABELS[group.stage] : 'Queued'}
        </span>
        <span className="font-mono text-2xs text-subtle tabular-nums">{visible.length}</span>
        {duration !== null && step?.status !== 'pending' ? (
          <span className="ml-auto font-mono text-2xs text-subtle tabular-nums">
            {formatDuration(duration)}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <>
          {visible.length > shown.length ? (
            <div className="px-4 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                Show {visible.length - shown.length} earlier events
              </Button>
            </div>
          ) : null}
          <ol className="py-1.5">
            {shown.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

/** The audit's activity log: concise actions, tool runs and AI decision summaries — never model reasoning. */
export function ActivityTimeline({
  events,
  steps,
  filter,
  now,
}: {
  events: ActivityEvent[]
  steps: AuditStep[]
  filter: ActivityFilter
  now: number
}) {
  const groups = groupByStage(events)
  const stepFor = (stage: AuditStage | null) =>
    stage ? steps.find((step) => step.stage === stage) : undefined
  return (
    <div>
      {groups.map((group) => (
        <StageSection key={group.key} group={group} step={stepFor(group.stage)} filter={filter} now={now} />
      ))}
    </div>
  )
}
