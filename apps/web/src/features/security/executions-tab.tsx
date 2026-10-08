import {
  isTerminalExecutionStatus,
  type SecurityEngagementDetail,
  type SecurityEventItem,
  type SecurityEvidenceItem,
  type SecurityExecutionDetail,
  type SecurityExecutionItem,
} from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Ban, FileText, Loader2, Workflow } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ENVIRONMENT_LABEL, ExecutionStatusBadge, FAILURE_KIND_LABEL } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { DefinitionList, Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState, Notice } from '@/components/states'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { api } from '@/lib/api'
import { formatBytes, formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { engagementExecutionsQuery, executionEventsQuery, executionEvidenceQuery, executionQuery, queryKeys } from '@/lib/queries'
import { cn } from '@/lib/utils'

/*
 * Executions of an engagement: durable runs of allowed capability requests. This view inspects them and
 * can cancel one; it cannot start anything — executions are created by Audivra through the broker.
 */

const column = createColumnHelper<SecurityExecutionItem>()
const columns = [
  column.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => <ExecutionStatusBadge status={getValue()} />,
    meta: { className: 'w-1' },
  }),
  column.accessor('capabilityName', {
    header: 'Capability',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div className="truncate font-medium text-foreground">{row.original.capabilityName}</div>
        <div className="truncate font-mono text-2xs text-subtle">
          {row.original.capabilityId} v{row.original.capabilityVersion}
        </div>
      </div>
    ),
    meta: { className: 'w-full max-w-0' },
  }),
  column.accessor('environment', {
    header: 'Environment',
    cell: ({ getValue }) => <span className="whitespace-nowrap text-muted">{ENVIRONMENT_LABEL[getValue()]}</span>,
    meta: { className: 'hidden w-1 md:table-cell' },
  }),
  column.accessor('createdAt', {
    header: 'Created',
    cell: ({ getValue }) => (
      <span className="text-xs whitespace-nowrap text-muted" title={formatDateTime(getValue())}>
        {formatRelative(getValue())}
      </span>
    ),
    meta: { className: 'w-1' },
  }),
  column.accessor('durationMs', {
    header: 'Duration',
    cell: ({ getValue }) => <span className="font-mono text-xs whitespace-nowrap text-muted tabular-nums">{formatDuration(getValue())}</span>,
    meta: { className: 'w-1', align: 'right' },
  }),
  column.accessor((row) => (row.failure ? FAILURE_KIND_LABEL[row.failure.kind] : ''), {
    id: 'failure',
    header: 'Failure',
    cell: ({ getValue }) => (getValue() ? <span className="whitespace-nowrap text-muted">{getValue()}</span> : <span className="text-subtle">—</span>),
    meta: { className: 'hidden w-1 lg:table-cell' },
  }),
]

/** The backend the execution runs on, and for an isolated one the profile of its container. */
function runtimeText(detail: SecurityExecutionDetail): { label: string; profile: string | null } {
  const { isolation } = detail.trusted
  if (isolation.mode !== 'isolated-container') return { label: 'In process (trusted platform code)', profile: null }
  const limits = isolation.container
  return {
    label: `Isolated container · ${isolation.runtimeId ?? 'approved runtime'}${isolation.runtimeVersion ? ` v${isolation.runtimeVersion}` : ''}`,
    profile: [
      isolation.network === 'none' ? 'no network' : null,
      'read-only root',
      'non-root',
      limits ? `${limits.memoryMb} MB memory` : null,
      limits ? `${limits.cpus} CPU` : null,
      limits ? `${limits.pidsLimit} processes` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }
}

/** Container outcome and whether Audivra's cleanup removed it. */
function containerText(detail: SecurityExecutionDetail): string | null {
  if (detail.trusted.isolation.mode !== 'isolated-container') return null
  const container = detail.exit?.runtime?.container
  if (!container) return detail.status === 'queued' ? 'Not created yet' : detail.finishedAt ? 'No container was created' : 'In use'
  const outcome = container.oomKilled ? 'stopped at its memory limit' : container.exitCode === null ? 'did not report an exit code' : `exited with code ${container.exitCode}`
  return `${outcome} · ${container.removed ? 'removed' : 'not removed — kept for a later cleanup'}`
}

const actorText = (actor: SecurityExecutionDetail['requestedBy']) =>
  actor.kind === 'agent' ? `Agent run ${actor.agentRunId ?? ''}` : actor.kind === 'system' ? 'Audivra' : (actor.id ?? 'User')

function EventList({ events }: { events: SecurityEventItem[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {events.map((event) => (
        <li key={event.id} className="flex items-start gap-3">
          <span
            className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', event.level === 'error' ? 'bg-critical' : event.level === 'warn' ? 'bg-medium' : 'bg-subtle')}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-2xs text-subtle">{event.type}</span>
              <span className="text-2xs text-subtle" title={formatDateTime(event.createdAt)}>
                {new Date(event.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <p className={cn('text-sm text-break', event.level === 'error' ? 'text-critical' : 'text-foreground')}>{event.message}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function EvidenceList({ executionId, items }: { executionId: string; items: SecurityEvidenceItem[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const artifact = item.metadata.artifact as { bytes?: number; sha256?: string } | undefined
        return (
          <li key={item.id} className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-2xs text-muted">{item.ref}</span>
              <span className="truncate text-sm font-medium text-foreground">{item.title}</span>
            </div>
            <p className="text-xs text-muted text-break">{item.summary}</p>
            {item.artifactPath ? (
              <a
                href={api.executionArtifactUrl(executionId, item.artifactPath)}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 text-xs text-foreground hover:border-border-strong"
              >
                <FileText className="size-3.5 shrink-0 text-subtle" />
                <span className="truncate font-mono text-2xs">{item.artifactPath.split('/').pop()}</span>
                {artifact?.bytes !== undefined ? <span className="shrink-0 text-2xs text-subtle">{formatBytes(artifact.bytes)}</span> : null}
              </a>
            ) : null}
            {artifact?.sha256 ? <p className="mt-0.5 truncate font-mono text-2xs text-subtle">sha256 {artifact.sha256}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

function ExecutionDetailPanel({ id, engagementId }: { id: string; engagementId: string }) {
  const queryClient = useQueryClient()
  const execution = useQuery(executionQuery(id))
  const status = execution.data?.status
  const active = status ? !isTerminalExecutionStatus(status) : false
  const events = useQuery(executionEventsQuery(id, active))
  const evidence = useQuery(executionEvidenceQuery(id, active))

  // A change of state brings new events and evidence; refresh them once more after the final one.
  useEffect(() => {
    if (!status) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.executionEvents(id) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.executionEvidence(id) })
  }, [status, id, queryClient])

  const cancel = useMutation({
    mutationFn: () => api.cancelExecution(id),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.execution(id), detail)
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementExecutions(engagementId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.executionEvents(id) })
      toast.success(detail.status === 'cancelled' ? 'Execution cancelled' : 'Cancellation requested')
    },
    onError: (error) => toast.error('Could not cancel the execution', { description: error instanceof Error ? error.message : String(error) }),
  })

  if (execution.isError) {
    return (
      <Panel className="self-start">
        <ErrorState title="Could not load the execution" error={execution.error} onRetry={() => void execution.refetch()} />
      </Panel>
    )
  }
  const detail = execution.data
  if (!detail) {
    return (
      <Panel className="self-start">
        <LoadingState rows={6} />
      </Panel>
    )
  }
  const { trusted, failure } = detail
  const runtime = runtimeText(detail)
  const container = containerText(detail)
  const isolated = trusted.isolation.mode === 'isolated-container'
  return (
    <Panel className="self-start" id="execution-detail">
      <PanelHeader
        title={detail.capabilityName}
        description={<span className="font-mono text-2xs">{detail.id}</span>}
        actions={
          detail.cancellable ? (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="danger" disabled={cancel.isPending}>
                  {cancel.isPending ? <Loader2 className="animate-spin" /> : <Ban />}
                  Cancel execution
                </Button>
              }
              title="Cancel this execution?"
              confirmLabel="Cancel execution"
              dismissLabel="Keep running"
              onConfirm={() => cancel.mutate()}
            >
              Audivra asks the capability to stop, terminates the processes this execution owns after a short grace period, cleans up and records
              it as cancelled. Other executions and processes are not affected.
            </ConfirmDialog>
          ) : null
        }
      />
      <PanelBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2" data-testid="execution-status">
          <ExecutionStatusBadge status={detail.status} />
          {detail.status === 'cancelling' ? <span className="text-xs text-muted">Stopping owned resources…</span> : null}
          {detail.result?.summary && detail.status === 'succeeded' ? <span className="text-xs text-muted text-break">{detail.result.summary}</span> : null}
        </div>
        {failure ? (
          <Notice tone={detail.status === 'cancelled' ? 'neutral' : detail.status === 'failed' ? 'critical' : 'warning'} title={FAILURE_KIND_LABEL[failure.kind]}>
            {failure.message} <span className="font-mono text-2xs text-subtle">({failure.rule})</span>
          </Notice>
        ) : null}
        <DefinitionList
          layout="text"
          items={[
            { label: 'Environment', value: ENVIRONMENT_LABEL[detail.environment] },
            {
              label: 'Runtime',
              value: (
                <span data-testid="execution-runtime">
                  {runtime.label}
                  {runtime.profile ? <span className="block text-xs text-muted">{runtime.profile}</span> : null}
                </span>
              ),
            },
            ...(container ? [{ label: 'Container', value: <span data-testid="execution-container">{container}</span> }] : []),
            { label: 'Requested by', value: actorText(detail.requestedBy) },
            { label: 'Created', value: formatDateTime(detail.createdAt) },
            { label: 'Started', value: formatDateTime(detail.startedAt) },
            { label: 'Finished', value: formatDateTime(detail.finishedAt) },
            { label: 'Duration', value: formatDuration(detail.durationMs) },
            {
              label: 'Approved under',
              value: `configuration v${detail.configVersion} · scope v${trusted.scopeVersion} · ${trusted.policyProfile.key} v${trusted.policyProfile.version}`,
            },
            {
              label: 'Limits',
              // Container limits are part of the runtime profile; the process limit is for in-process capabilities.
              value: `${formatDuration(trusted.runtime.timeoutSeconds * 1000)} · ${formatBytes(trusted.runtime.maxArtifactBytes)} of artifacts${
                isolated ? '' : ` · ${trusted.runtime.maxProcesses ? `up to ${trusted.runtime.maxProcesses} processes` : 'no processes'}`
              }`,
            },
            {
              label: 'Snapshot',
              value: (
                <span className="font-mono text-2xs" title={detail.snapshotHash}>
                  {detail.snapshotHash.slice(0, 16)}…
                </span>
              ),
            },
            ...(detail.exit
              ? [
                  {
                    label: 'Exit',
                    value: `${isolated ? '' : `${detail.exit.processes.started} process${detail.exit.processes.started === 1 ? '' : 'es'} started, ${detail.exit.processes.terminated + detail.exit.processes.reaped} stopped by Audivra · `}${detail.exit.artifacts.registered} artifact${detail.exit.artifacts.registered === 1 ? '' : 's'}${detail.exit.abandoned ? ' · code that ignored the stop request was abandoned' : ''}`,
                  },
                ]
              : []),
          ]}
        />
        <section className="border-t border-border pt-3">
          <SectionLabel>Evidence and artifacts</SectionLabel>
          {evidence.data?.length ? (
            <EvidenceList executionId={detail.id} items={evidence.data} />
          ) : (
            <p className="text-xs text-muted">{evidence.isLoading ? 'Loading…' : 'No evidence recorded by this execution.'}</p>
          )}
        </section>
        <section className="border-t border-border pt-3">
          <SectionLabel>Events</SectionLabel>
          {events.data?.length ? <EventList events={events.data} /> : <p className="text-xs text-muted">{events.isLoading ? 'Loading…' : 'No events.'}</p>}
        </section>
      </PanelBody>
    </Panel>
  )
}

export function ExecutionsTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const executions = useQuery(engagementExecutionsQuery(engagement.id))
  const rows = executions.data ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const current = selected && rows.some((row) => row.id === selected) ? selected : (rows[0]?.id ?? null)
  const table = useDataTable({ data: rows, columns, getRowId: (row) => row.id, initialSorting: [{ id: 'createdAt', desc: true }] })

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_28rem] xl:items-start">
      <Panel>
        <PanelHeader
          title="Executions"
          description="Durable runs of allowed capability requests. Each one runs from the trusted configuration it was approved under, in its own workspace."
        />
        {executions.isError ? (
          <ErrorState title="Could not load executions" error={executions.error} onRetry={() => void executions.refetch()} />
        ) : (
          <DataTable
            table={table}
            isLoading={executions.isLoading}
            selectedRowId={current}
            onRowClick={(row) => setSelected(row.id)}
            minWidth="min-w-140"
            empty={
              <EmptyState
                icon={Workflow}
                title="No executions yet"
                description={
                  <>
                    Executions are created by Audivra through the capability broker, never from this page. To exercise the runtime on this engagement:{' '}
                    <code className="font-mono text-xs text-foreground">pnpm security:runtime-check {engagement.id}</code>
                  </>
                }
              />
            }
          />
        )}
      </Panel>
      {current ? <ExecutionDetailPanel key={current} id={current} engagementId={engagement.id} /> : null}
    </div>
  )
}
