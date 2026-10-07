import type { ActivityKind, DashboardActivity } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, CircleDot, Loader2, MinusCircle, Plus, XCircle, type LucideIcon } from 'lucide-react'
import { STAGE_LABELS } from '@/components/badges'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState } from '@/components/states'
import { formatDateTime, formatRelative, pluralize } from '@/lib/format'
import { cn } from '@/lib/utils'

const KIND: Record<ActivityKind, { label: string; icon: LucideIcon; className: string }> = {
  created: { label: 'Audit created', icon: Plus, className: 'text-muted' },
  started: { label: 'Audit running', icon: Loader2, className: 'animate-spin text-running' },
  completed: { label: 'Audit completed', icon: CheckCircle2, className: 'text-success' },
  partial: { label: 'Audit finished with gaps', icon: CircleDot, className: 'text-medium' },
  failed: { label: 'Audit failed', icon: XCircle, className: 'text-critical' },
  cancelled: { label: 'Audit cancelled', icon: MinusCircle, className: 'text-subtle' },
}

function detail(item: DashboardActivity): string {
  switch (item.kind) {
    case 'completed':
    case 'partial':
      return item.aiEnabled ? pluralize(item.findingCount, 'finding') : 'baseline only'
    case 'failed':
      return item.error ?? `stopped at ${STAGE_LABELS[item.stage]}`
    case 'started':
      return STAGE_LABELS[item.stage]
    case 'created':
      return 'waiting to start'
    default:
      return ''
  }
}

/** Global product activity: the latest state change of each recent audit (no tool-level noise). */
export function RecentActivity({ items, now }: { items: DashboardActivity[]; now: number }) {
  return (
    <Panel>
      <PanelHeader title="Recent activity" />
      {items.length ? (
        <ol className="divide-y divide-border">
          {items.map((item) => {
            const config = KIND[item.kind]
            const Icon = config.icon
            const text = detail(item)
            return (
              <li key={item.auditId}>
                <Link
                  to="/audits/$auditId"
                  params={{ auditId: item.auditId }}
                  search={item.kind === 'failed' ? { tab: 'activity' } : {}}
                  className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-surface-hover"
                >
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', config.className)} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm text-foreground">{config.label}</span>
                      <time className="shrink-0 text-xs text-subtle" dateTime={item.at} title={formatDateTime(item.at)}>
                        {formatRelative(item.at, now)}
                      </time>
                    </div>
                    <div className="truncate text-xs text-muted" title={text || undefined}>
                      {item.domain}
                      {item.benchmark ? ' · benchmark' : item.local ? ' · local' : ''}
                      {text ? ` · ${text}` : ''}
                    </div>
                  </div>
                </Link>
              </li>
            )
          })}
        </ol>
      ) : (
        <EmptyState compact title="No activity yet" />
      )}
    </Panel>
  )
}
