import type { ClientReport } from '@audivra/contracts'
import { ClientReportDocument } from '@audivra/report-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { FileText, FileType, Loader2, Presentation } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, Notice } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ExportMenu, startExport } from '@/features/audit/export-menu'
import { ViewToggle } from '@/features/audit/view-toggle'
import { artifactUrl } from '@/lib/api'
import { auditQuery, exportsQuery, isFinished, isPresenting, reportQuery } from '@/lib/queries'

export const Route = createFileRoute('/audits/$auditId_/client')({
  // Shown to clients: no app sidebar, runtime status or navigation around it.
  staticData: { chrome: 'none' },
  component: ClientViewPage,
})

function ReportSkeleton() {
  return (
    <div className="mx-auto flex max-w-[1120px] flex-col gap-3 rounded-lg border border-border bg-surface p-12">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-3 w-56" />
      <Skeleton className="mt-6 h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/** In-page links to the sections this report actually has (same conditions as the document). */
function sections(report: ClientReport): { id: string; label: string }[] {
  const plan = report.actionPlan
  return [
    { id: 'snapshot', label: 'Snapshot', show: true },
    { id: 'risks', label: 'Top risks', show: report.topRisks.length > 0 },
    { id: 'journeys', label: 'Journey', show: report.journeys.length > 0 },
    { id: 'visuals', label: 'Visuals', show: report.featuredArtifacts.length + report.visuals.length > 0 },
    { id: 'findings', label: 'Findings', show: report.majorFindings.length > 0 },
    { id: 'changes', label: 'What changed', show: Boolean(report.changes || report.comparison) },
    { id: 'opportunities', label: 'Opportunities', show: report.opportunities.length > 0 },
    { id: 'plan', label: 'Action plan', show: plan.doFirst.length + plan.then.length + plan.later.length > 0 },
    { id: 'appendix', label: 'Appendix', show: true },
  ].filter((s) => s.show)
}

/**
 * Client view: the audit as the client sees it. Rendered by the same document component as the PDF
 * and HTML exports (shared content decisions), on a light "paper" theme, without any internals:
 * no runs, prompts, model details, IDs, logs, local paths or reviewer mechanics.
 */
function ClientViewPage() {
  const { auditId } = Route.useParams()
  const audit = useQuery(auditQuery(auditId))
  const finished = audit.data ? isFinished(audit.data.status) : false
  const presenting = audit.data ? isPresenting(audit.data) : false
  const report = useQuery({ ...reportQuery(auditId), enabled: finished })
  const exports = useQuery({ ...exportsQuery(auditId), enabled: finished })
  const byKind = new Map((exports.data ?? []).map((item) => [item.kind, item]))
  const resolveAsset = useCallback(
    (path: string, otherAuditId?: string) => artifactUrl(otherAuditId ?? auditId, path),
    [auditId],
  )

  // A link to a section (/client#journeys) arrives before the report renders; scroll once it has.
  useEffect(() => {
    if (!report.data || !window.location.hash) return
    document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView()
  }, [report.data])

  const data = audit.data
  const nav = report.data ? sections(report.data) : []
  return (
    <div className="min-h-dvh bg-background pb-12 print:min-h-0 print:bg-transparent print:pb-0">
      <div className="sticky top-0 z-20 border-b border-border bg-surface px-4 sm:px-6 print:hidden">
        <div className="mx-auto flex h-12 max-w-[1120px] items-center gap-2">
          <ViewToggle auditId={auditId} active="client" />
          <div className="min-w-0 flex-1 pl-1">
            <h1 className="sr-only truncate text-sm font-semibold text-foreground sm:not-sr-only">Client view</h1>
            <p className="hidden truncate text-xs text-muted sm:block">{data ? (data.clientName ?? data.domain) : 'Loading…'}</p>
          </div>
          {data && finished ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={byKind.get('pdf')?.available === false}
                onClick={() => startExport(auditId, 'pdf', byKind.get('pdf'))}
              >
                <FileText />
                <span className="hidden xs:inline">Download</span> PDF
              </Button>
              <Button
                size="sm"
                className="hidden sm:inline-flex"
                onClick={() => startExport(auditId, 'html', byKind.get('html'))}
              >
                <FileType />
                HTML
              </Button>
              <ExportMenu audit={data} label="More" include={['json', 'csv-findings', 'csv-pages', 'csv-performance', 'csv-broken-links', 'bundle']} />
            </>
          ) : null}
        </div>
        {nav.length > 2 ? (
          <nav aria-label="Report sections" className="mx-auto -mb-px flex max-w-[1120px] gap-1 overflow-x-auto pb-1.5">
            {nav.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="shrink-0 rounded-sm px-2 py-1 text-xs whitespace-nowrap text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                {section.label}
              </a>
            ))}
          </nav>
        ) : null}
      </div>

      <div className="px-2 pt-4 sm:px-6 sm:pt-6 print:p-0">
        {audit.isError ? (
          <Panel className="mx-auto max-w-[1120px]">
            <ErrorState title="Could not load this audit" error={audit.error} onRetry={() => void audit.refetch()} />
          </Panel>
        ) : !data ? (
          <ReportSkeleton />
        ) : !finished ? (
          <Panel className="mx-auto max-w-[1120px]">
            <EmptyState
              icon={Presentation}
              title="The client view is available when the audit finishes"
              description="It is assembled from the reviewed findings, evidence, journeys, visuals and coverage of a completed or partial audit."
              action={
                <Link to="/audits/$auditId" params={{ auditId }} className={buttonVariants({ size: 'sm' })}>
                  Back to audit
                </Link>
              }
            />
          </Panel>
        ) : report.isError ? (
          <Panel className="mx-auto max-w-[1120px]">
            <ErrorState title="Could not build the client view" error={report.error} onRetry={() => void report.refetch()} />
          </Panel>
        ) : !report.data ? (
          <ReportSkeleton />
        ) : (
          <div className="mx-auto flex max-w-[1120px] flex-col gap-3">
            {presenting ? (
              <Notice icon={Loader2} iconClassName="animate-spin" title="Visual report is being regenerated" className="print:hidden">
                This view updates when the new visuals are ready.
              </Notice>
            ) : null}
            <div className="overflow-hidden rounded-lg border border-border print:overflow-visible print:rounded-none print:border-0">
              <ClientReportDocument report={report.data} resolveAsset={resolveAsset} interactive variant="screen" />
            </div>
            <p className="px-1 text-xs text-subtle print:hidden">
              Same content as the PDF and HTML exports; the PDF adds page numbers and expands collapsed sections.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
