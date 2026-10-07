import type { FollowUp } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { ArrowDownRight, ArrowUpRight, CircleDot, Repeat2, Sparkles } from 'lucide-react'
import { FINDING_TYPE, SEVERITY_LABEL, SeverityBadge } from '@/components/badges'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState } from '@/components/states'
import { cn } from '@/lib/utils'

/** How the issue relates to earlier audits of the site, in words. */
function History({ item }: { item: FollowUp }) {
  const previous = item.previousSeverity ? SEVERITY_LABEL[item.previousSeverity].toLowerCase() : null
  const parts: { text: string; icon: typeof Repeat2; className?: string }[] = []
  if (item.change === 'regressed') parts.push({ text: `Regressed from ${previous}`, icon: ArrowUpRight, className: 'text-critical' })
  if (item.change === 'improved') parts.push({ text: `Improved from ${previous}`, icon: ArrowDownRight })
  if (item.seenIn >= 2) parts.push({ text: `Found in ${item.seenIn} of ${item.auditsCompared} audits`, icon: Repeat2 })
  else if (item.change === 'new') parts.push({ text: 'New in the latest audit', icon: Sparkles })
  else if (item.change === 'first-audit') parts.push({ text: 'First audit of this site', icon: CircleDot })
  return (
    <>
      {parts.map((part) => {
        const Icon = part.icon
        return (
          <span key={part.text} className={cn('inline-flex items-center gap-1 whitespace-nowrap', part.className)}>
            <Icon className="size-3 shrink-0" aria-hidden />
            {part.text}
          </span>
        )
      })}
    </>
  )
}

function FollowUpRow({ item }: { item: FollowUp }) {
  const type = FINDING_TYPE[item.type]
  const TypeIcon = type.icon
  return (
    <li>
      <Link
        to="/audits/$auditId"
        params={{ auditId: item.auditId }}
        search={{ tab: 'findings', finding: item.ref }}
        className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-hover"
      >
        <SeverityBadge severity={item.severity} className="mt-px" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium text-foreground group-hover:underline">{item.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>
              <span className="font-medium text-foreground">{item.domain}</span> · {item.category}
              {item.businessImpactLevel === 'high' || item.businessImpactLevel === 'medium'
                ? ` · ${item.businessImpactLevel === 'high' ? 'High' : 'Medium'} impact`
                : ''}
            </span>
            <History item={item} />
            <span className="inline-flex items-center gap-1 whitespace-nowrap" title={type.hint}>
              <TypeIcon className="size-3 shrink-0" aria-hidden />
              {type.short}
            </span>
          </div>
        </div>
        <span className="hidden shrink-0 pt-0.5 text-xs whitespace-nowrap text-link group-hover:underline sm:inline">
          View finding →
        </span>
      </Link>
    </li>
  )
}

/** The few issues worth attention across the latest audit of each website, ranked by the API. */
export function PriorityFollowUps({ items, websites }: { items: FollowUp[]; websites: number }) {
  return (
    <Panel>
      <PanelHeader title="Priority follow-ups" description="Issues worth your attention based on the latest audits." />
      {items.length ? (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <FollowUpRow key={`${item.auditId}:${item.ref}`} item={item} />
          ))}
        </ul>
      ) : (
        <EmptyState
          compact
          title={websites ? 'Nothing needs follow-up' : 'No follow-ups yet'}
          description={
            websites
              ? 'The latest audits have no medium-or-worse, high-impact or regressed issues.'
              : 'Follow-ups appear once a public website has a finished AI audit.'
          }
        />
      )}
    </Panel>
  )
}
