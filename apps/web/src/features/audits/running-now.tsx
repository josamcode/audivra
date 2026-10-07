import type { ActiveAudit, SystemHealth } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/badges'
import { Panel, PanelHeader } from '@/components/panel'
import { StageProgress } from '@/components/stage-progress'
import { Notice } from '@/components/states'
import { durationBetween, formatDuration } from '@/lib/format'
import { SiteMark, TargetTag } from './signals'

/** Audits in flight, with their real stage. Rendered only while something is queued or running. */
export function RunningNow({ audits, now, engine }: { audits: ActiveAudit[]; now: number; engine?: SystemHealth['engine'] }) {
  const running = audits.filter((audit) => audit.status === 'running').length
  const queued = audits.length - running
  return (
    <Panel>
      <PanelHeader
        title="Running now"
        description={[running && `${running} running`, queued && `${queued} queued`].filter(Boolean).join(' · ')}
      />
      {engine?.state === 'stopped' ? (
        <div className="px-4 pt-3">
          <Notice tone="warning" icon={AlertTriangle} title="The audit engine is not running">
            Queued stages wait until the worker is started again (it runs with <code className="font-mono text-xs">pnpm dev</code>).
          </Notice>
        </div>
      ) : null}
      <ul className="divide-y divide-border">
        {audits.map((audit) => {
          const elapsed = durationBetween(audit.status === 'queued' ? audit.createdAt : (audit.startedAt ?? audit.createdAt), null, now)
          return (
            <li key={audit.id} className="px-4 py-3">
              <Link
                to="/audits/$auditId"
                params={{ auditId: audit.id }}
                className="group flex min-w-0 items-center gap-3 rounded-md"
              >
                <SiteMark domain={audit.domain} benchmark={audit.benchmark} local={audit.local} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-foreground group-hover:underline">{audit.domain}</span>
                    <TargetTag benchmark={audit.benchmark} local={audit.local} />
                  </div>
                  <div className="truncate text-xs text-muted">{audit.clientName ?? audit.url}</div>
                </div>
                <StatusBadge status={audit.status} stage={audit.stage} />
                <span
                  className="hidden font-mono text-sm text-muted tabular-nums xs:inline"
                  title={audit.status === 'queued' ? 'Waiting since the audit was created' : 'Elapsed since the audit started'}
                >
                  {formatDuration(elapsed)}
                </span>
                <ChevronRight className="size-4 shrink-0 text-subtle group-hover:text-foreground" aria-hidden />
              </Link>
              {audit.steps.length ? (
                <div className="mt-2.5 sm:pl-10">
                  <StageProgress steps={audit.steps} now={now} />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
