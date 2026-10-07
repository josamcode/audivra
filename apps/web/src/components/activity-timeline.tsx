import type { ActivityEvent, AgentRole, AuditStage, AuditStep } from '@audivra/contracts'
import {
  Ban,
  Bot,
  ChartColumn,
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
  FileText,
  Timer,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { ROLE_LABELS, STAGE_LABELS, StepIcon } from '@/components/badges'
import { Button } from '@/components/ui/button'
import { durationBetween, formatDuration, formatTime, pluralize, titleCase } from '@/lib/format'
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
    case 'artifact.created':
      return { icon: ChartColumn, className: muted }
    case 'report.ready':
      return { icon: FileText, className: 'text-success' }
    case 'agent.budget':
      return { icon: Timer, className: 'text-medium' }
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
  if (typeof role !== 'string') return null
  return ROLE_LABELS[role as AgentRole] ?? titleCase(role)
}

/** Friendlier wording for raw tool names that older runs logged verbatim. */
function displayMessage(event: ActivityEvent): string {
  const raw = /^Browser: run code unsafe/i
  if (raw.test(event.message)) return event.message.replace(raw, 'Browser: Ran Playwright code')
  const tool = typeof event.data?.tool === 'string' ? event.data.tool : ''
  if (!event.message && tool.endsWith('browser_run_code_unsafe')) return 'Browser: Ran Playwright code'
  return event.message
}

function EventRow({ event, grouped = false }: { event: ActivityEvent; grouped?: boolean }) {
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
            {role && !grouped ? <span className="mr-1.5 text-xs font-medium text-subtle">{role}</span> : null}
            {displayMessage(event)}
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

type TimelineItem =
  | { kind: 'event'; event: ActivityEvent }
  | { kind: 'burst'; key: string; role: string | null; events: ActivityEvent[] }

const BURST_MIN = 3

/** Collapses runs of consecutive tool actions by the same AI role into one expandable row. */
export function groupBursts(events: ActivityEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let run: ActivityEvent[] = []
  const flush = () => {
    if (run.length >= BURST_MIN) {
      const first = run[0]!
      items.push({ kind: 'burst', key: `burst-${first.id}`, role: roleLabel(first), events: run })
    } else {
      for (const event of run) items.push({ kind: 'event', event })
    }
    run = []
  }
  for (const event of events) {
    if (event.type === 'agent.activity') {
      const previous = run[run.length - 1]
      if (previous && previous.data?.role !== event.data?.role) flush()
      run.push(event)
    } else {
      flush()
      items.push({ kind: 'event', event })
    }
  }
  flush()
  return items
}

const KIND_LABEL: Record<string, string> = {
  browser: 'browser',
  terminal: 'terminal',
  file: 'file',
  evidence: 'evidence',
  search: 'search',
}

function BurstRow({ role, events }: { role: string | null; events: ActivityEvent[] }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const event of events) {
    const kind = typeof event.data?.kind === 'string' ? event.data.kind : 'other'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${KIND_LABEL[kind] ?? 'other'}`)
    .join(' · ')
  const failed = events.filter((event) => event.level === 'error').length
  const first = events[0]!
  const last = events[events.length - 1]!
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-1.5 text-left transition-colors hover:bg-surface-hover"
      >
        <time className="w-16 shrink-0 pt-px font-mono text-2xs text-subtle tabular-nums" dateTime={first.createdAt}>
          {formatTime(first.createdAt)}
        </time>
        <Bot className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-muted">
            {role ? <span className="mr-1.5 text-xs font-medium text-subtle">{role}</span> : null}
            {pluralize(events.length, 'action')}
            <span className="text-subtle"> — {breakdown}</span>
            {failed ? <span className="text-critical"> · {failed} failed</span> : null}
            <span className="ml-1.5 font-mono text-2xs text-subtle tabular-nums">
              {formatDuration(new Date(last.createdAt).getTime() - new Date(first.createdAt).getTime())}
            </span>
          </span>
          {open ? null : (
            <span className="block truncate text-xs text-subtle">Latest: {displayMessage(last)}</span>
          )}
        </span>
        <ChevronRight
          className={cn('mt-0.5 size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')}
          aria-hidden
        />
      </button>
      {open ? (
        <ol className="bg-surface-muted py-1" aria-label={`${pluralize(events.length, 'action')}${role ? ` by ${role}` : ''}`}>
          {events.map((event) => (
            <EventRow key={event.id} event={event} grouped />
          ))}
        </ol>
      ) : null}
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
            {groupBursts(shown).map((item) =>
              item.kind === 'burst' ? (
                <BurstRow key={item.key} role={item.role} events={item.events} />
              ) : (
                <EventRow key={item.event.id} event={item.event} />
              ),
            )}
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
