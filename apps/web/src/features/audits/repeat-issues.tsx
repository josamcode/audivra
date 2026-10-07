import type { RepeatSite } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState } from '@/components/states'
import { Tooltip } from '@/components/ui/tooltip'
import { pluralize } from '@/lib/format'
import { SeverityBars, SiteMark, TrendLabel, trendHint } from './signals'

/** Websites that stay unhealthy over time: issues of the latest audit already found in the audit before it. */
export function RepeatIssues({ sites }: { sites: RepeatSite[] }) {
  return (
    <Panel>
      <PanelHeader title="Sites with repeat issues" description="Issues found again in the latest audit" />
      {sites.length ? (
        <ul className="divide-y divide-border">
          {sites.map((site) => {
            const recurring = site.changes.unchanged + site.changes.improved + site.changes.regressed
            const [previous, current] = site.history.slice(-2)
            return (
              <li key={site.siteKey}>
                <Link
                  to="/audits/$auditId"
                  params={{ auditId: site.latestAuditId }}
                  search={{ tab: 'history' }}
                  className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover"
                >
                  <SiteMark domain={site.domain} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="mr-auto truncate text-sm font-medium text-foreground group-hover:underline">{site.domain}</span>
                      <Tooltip content={trendHint(previous!, current!)}>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <SeverityBars points={site.history} className="h-4" />
                          <TrendLabel direction={site.direction} />
                        </span>
                      </Tooltip>
                    </div>
                    <div className="truncate text-xs text-muted">
                      {pluralize(site.audits, 'audit')} · {recurring} recurring
                      {site.changes.regressed ? <span className="text-critical"> · {site.changes.regressed} regressed</span> : null}
                    </div>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <EmptyState
          compact
          title="No repeat issues"
          description="Websites appear here when a later audit finds issues from the audit before it."
        />
      )}
    </Panel>
  )
}
