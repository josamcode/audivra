import type { AuditDetail } from '@audivra/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Loader2, NotebookPen, RotateCw, Square } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { StatusBadge } from '@/components/badges'
import { pageFrame } from '@/components/page-header'
import { StageProgress } from '@/components/stage-progress'
import { Dot } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { api } from '@/lib/api'
import { durationBetween, formatDateTime, formatDuration } from '@/lib/format'
import { isFinished, isTerminal, queryKeys } from '@/lib/queries'
import type { StreamState } from '@/lib/use-audit-stream'
import { cn } from '@/lib/utils'
import { ClientBriefSheet } from './client-brief'
import { ExportMenu } from './export-menu'
import { ViewToggle } from './view-toggle'

function LiveIndicator({ state }: { state: StreamState }) {
  if (state === 'idle') return null
  const live = state === 'live'
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted"
      title={live ? 'Receiving live events' : 'Reconnecting to live events'}
    >
      <Dot tone={live ? 'running' : 'neutral'} className={live ? 'animate-pulse' : undefined} />
      {live ? 'Live' : 'Reconnecting'}
    </span>
  )
}

export function AuditHeader({
  audit,
  now,
  stream,
}: {
  audit: AuditDetail
  now: number
  stream: StreamState
}) {
  const queryClient = useQueryClient()
  const onSuccess = (next: AuditDetail) => {
    queryClient.setQueryData(queryKeys.audit(audit.id), next)
    void queryClient.invalidateQueries({ queryKey: queryKeys.audits })
  }
  const cancel = useMutation({
    mutationFn: () => api.cancelAudit(audit.id),
    onSuccess: (next) => {
      onSuccess(next)
      toast('Cancellation requested')
    },
    onError: (error) => toast.error('Could not cancel', { description: error.message }),
  })
  const retry = useMutation({
    mutationFn: () => api.retryAudit(audit.id),
    onSuccess: (next) => {
      onSuccess(next)
      toast.success('Retrying from the failed stage')
    },
    onError: (error) => toast.error('Could not retry', { description: error.message }),
  })

  const [briefOpen, setBriefOpen] = useState(false)
  const terminal = isTerminal(audit.status)
  const duration = durationBetween(audit.startedAt, audit.finishedAt, now)

  return (
    <header className="bg-surface">
      <div className={cn(pageFrame, 'pt-5')}>
        <div className="mb-1 text-xs text-muted">
          <Link to="/" className="hover:text-foreground">
            Audits
          </Link>
          <span className="px-1.5 text-subtle">/</span>
          <span className="font-mono">{audit.id}</span>
        </div>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          {/* As in PageHeader: on phones the actions wrap below the title instead of truncating it. */}
          <div className="min-w-60 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                {audit.domain}
              </h1>
              <StatusBadge status={audit.status} />
              {!audit.aiEnabled ? <span className="text-xs text-subtle">Baseline only</span> : null}
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted">
              <a
                href={audit.normalizedUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-w-0 items-center gap-1 font-mono text-xs hover:text-foreground"
              >
                <span className="truncate">{audit.normalizedUrl}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
              {audit.clientName ? (
                <>
                  <span className="text-subtle">·</span>
                  <span className="truncate">{audit.clientName}</span>
                </>
              ) : null}
              {audit.template ? (
                <>
                  <span className="text-subtle">·</span>
                  <span className="truncate" title={`Audit focus (template v${audit.template.version})`}>
                    {audit.template.name}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!terminal ? (
              <Button variant="danger" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? <Loader2 className="animate-spin" /> : <Square />}
                Cancel
              </Button>
            ) : null}
            {audit.status === 'failed' || audit.status === 'partial' ? (
              <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
                {retry.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
                Retry failed stage
              </Button>
            ) : null}
            {isFinished(audit.status) ? (
              <>
                <ViewToggle auditId={audit.id} active="internal" />
                {audit.aiEnabled ? (
                  <Button size="sm" onClick={() => setBriefOpen(true)}>
                    <NotebookPen />
                    <span className="hidden sm:inline">Client brief</span>
                  </Button>
                ) : null}
                <ExportMenu audit={audit} />
              </>
            ) : null}
            <a
              href={audit.normalizedUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
              aria-label="Open site in a new tab"
              title="Open site"
            >
              <ExternalLink />
            </a>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
          <div className="min-w-0 flex-1 md:flex-none">
            <StageProgress steps={audit.steps} now={now} />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted md:ml-auto">
            <span title="Started">
              <span className="text-subtle">Started </span>
              {formatDateTime(audit.startedAt ?? audit.createdAt)}
            </span>
            <Separator vertical />
            <span title="Duration">
              <span className="text-subtle">Duration </span>
              <span className="font-mono tabular-nums">{formatDuration(duration)}</span>
            </span>
            <LiveIndicator state={stream} />
          </div>
        </div>
      </div>
      {audit.aiEnabled && isFinished(audit.status) ? <ClientBriefSheet audit={audit} open={briefOpen} onOpenChange={setBriefOpen} /> : null}
    </header>
  )
}
