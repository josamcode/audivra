import type { SecurityEngagementSummary } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { Plus, ShieldCheck } from 'lucide-react'
import { ENGAGEMENT_STATUS_LABEL, ENVIRONMENT_LABEL, ReadinessBadge } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { PageFrame, PageHeader, pageColumns } from '@/components/page-header'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { buttonVariants } from '@/components/ui/button'
import { formatDateTime, formatRelative } from '@/lib/format'
import { engagementsQuery } from '@/lib/queries'

export const Route = createFileRoute('/security/')({
  component: SecurityHome,
})

const column = createColumnHelper<SecurityEngagementSummary>()
const columns = [
  column.accessor('name', {
    header: 'Engagement',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div className="truncate font-medium text-foreground">{row.original.name}</div>
        <div className="truncate font-mono text-2xs text-subtle">{row.original.targetUrl}</div>
      </div>
    ),
    meta: { className: 'w-full max-w-0' },
  }),
  column.accessor((row) => row.readiness.state, {
    id: 'readiness',
    header: 'Readiness',
    cell: ({ row }) => <ReadinessBadge state={row.original.readiness.state} />,
    meta: { className: 'w-1' },
  }),
  column.accessor('environment', {
    header: 'Environment',
    cell: ({ getValue }) => {
      const env = getValue()
      return env ? <span className="whitespace-nowrap text-muted">{ENVIRONMENT_LABEL[env]}</span> : <span className="text-subtle">Not set</span>
    },
    meta: { className: 'w-1' },
  }),
  column.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => <span className="whitespace-nowrap text-muted">{ENGAGEMENT_STATUS_LABEL[getValue()]}</span>,
    meta: { className: 'hidden w-1 md:table-cell' },
  }),
  column.accessor((row) => row.policyProfile.name, {
    id: 'policy',
    header: 'Policy',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted">
        {row.original.policyProfile.name} <span className="font-mono text-2xs text-subtle">v{row.original.policyProfile.version}</span>
      </span>
    ),
    meta: { className: 'hidden w-1 lg:table-cell' },
  }),
  column.accessor('updatedAt', {
    header: 'Updated',
    cell: ({ getValue }) => (
      <span className="text-xs whitespace-nowrap text-muted" title={formatDateTime(getValue())}>
        {formatRelative(getValue())}
      </span>
    ),
    meta: { className: 'w-1', align: 'right' },
  }),
]

const STEPS = [
  { title: 'Target and environment', text: 'What is assessed and whether it is production, staging or an isolated lab.' },
  { title: 'Authorization', text: 'Proof that you may assess the target. Typing a URL is not authorization.' },
  { title: 'Scope', text: 'Exact hosts, ports, paths and exclusions. Subdomains, redirects and third parties are never implied.' },
  { title: 'Policy', text: 'Which risk classes the environment permits and the limits every execution runs under.' },
]

function SecurityHome() {
  const navigate = useNavigate()
  const engagements = useQuery(engagementsQuery())
  const rows = engagements.data ?? []
  const table = useDataTable({ data: rows, columns, getRowId: (row) => row.id, initialSorting: [{ id: 'updatedAt', desc: true }] })

  return (
    <div className="pb-10">
      <PageHeader
        title="Security assessments"
        description="Authorized security engagements: who may be assessed, where, and under which policy."
        actions={
          <Link to="/security/new" className={buttonVariants({ variant: 'primary' })}>
            <Plus />
            New engagement
          </Link>
        }
      />
      <PageFrame className={pageColumns}>
        <Panel>
          <PanelHeader title="Engagements" description="Readiness is recomputed from authorization, scope, environment and policy on every view." />
          {engagements.isError ? (
            <ErrorState title="Could not load engagements" error={engagements.error} onRetry={() => void engagements.refetch()} />
          ) : (
            <DataTable
              table={table}
              isLoading={engagements.isLoading}
              onRowClick={(row) => void navigate({ to: '/security/$engagementId', params: { engagementId: row.id } })}
              minWidth="min-w-160"
              empty={
                <EmptyState
                  icon={ShieldCheck}
                  title="No security engagements yet"
                  description="Create one to define an authorized target, its scope and the policy any future security run must follow."
                  action={
                    <Link to="/security/new" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                      <Plus />
                      New engagement
                    </Link>
                  }
                />
              }
            />
          )}
        </Panel>
        <Panel className="self-start">
          <PanelHeader title="How engagements work" />
          <PanelBody className="flex flex-col gap-4">
            <ol className="flex flex-col gap-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-border font-mono text-2xs text-muted">{index + 1}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{step.title}</p>
                    <p className="text-xs text-muted">{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="flex gap-2 border-t border-border pt-3 text-xs text-muted">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
              This version sets up and checks engagements only. It does not run security tests, and Website Audits are unaffected.
            </p>
          </PanelBody>
        </Panel>
      </PageFrame>
    </div>
  )
}
