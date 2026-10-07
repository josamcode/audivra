import { ClientReportDocument } from '@audivra/report-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, FileText, FileType, Loader2 } from 'lucide-react'
import { useCallback } from 'react'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, Notice } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ExportMenu, startExport } from '@/features/audit/export-menu'
import { artifactUrl } from '@/lib/api'
import { auditQuery, exportsQuery, isFinished, isPresenting, reportQuery } from '@/lib/queries'

export const Route = createFileRoute('/audits/$auditId_/report')({
  component: ReportPage,
})

function ReportSkeleton() {
  return (
    <div className="mx-auto flex max-w-[920px] flex-col gap-3 rounded-lg border border-border bg-surface p-12">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-3 w-56" />
      <Skeleton className="mt-6 h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/**
 * Client report preview. Rendered by the same component as the HTML and PDF exports, and kept on a
 * light "paper" theme even when the app is dark, so what you see is what the client receives.
 */
function ReportPage() {
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

  const data = audit.data
  return (
    <div className="min-h-dvh bg-background pb-12 print:min-h-0 print:bg-transparent print:pb-0">
      <div className="sticky top-12 z-20 border-b border-border bg-surface px-4 sm:px-6 md:top-0 print:hidden">
        <div className="mx-auto flex h-12 max-w-[920px] items-center gap-2">
          <Link
            to="/audits/$auditId"
            params={{ auditId }}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            aria-label="Back to audit"
          >
            <ArrowLeft />
            <span className="hidden sm:inline">Audit</span>
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-foreground">Client report</h1>
            <p className="truncate text-xs text-muted">{data ? data.domain : 'Loading…'}</p>
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
      </div>

      <div className="px-2 pt-4 sm:px-6 sm:pt-6 print:p-0">
        {audit.isError ? (
          <Panel className="mx-auto max-w-[920px]">
            <ErrorState title="Could not load this audit" error={audit.error} onRetry={() => void audit.refetch()} />
          </Panel>
        ) : !data ? (
          <ReportSkeleton />
        ) : !finished ? (
          <Panel className="mx-auto max-w-[920px]">
            <EmptyState
              icon={FileText}
              title="The client report is available when the audit finishes"
              description="It is assembled from the reviewed findings, evidence, visuals and coverage of a completed or partial audit."
              action={
                <Link to="/audits/$auditId" params={{ auditId }} className={buttonVariants({ size: 'sm' })}>
                  Back to audit
                </Link>
              }
            />
          </Panel>
        ) : report.isError ? (
          <Panel className="mx-auto max-w-[920px]">
            <ErrorState title="Could not build the report" error={report.error} onRetry={() => void report.refetch()} />
          </Panel>
        ) : !report.data ? (
          <ReportSkeleton />
        ) : (
          <div className="mx-auto flex max-w-[920px] flex-col gap-3">
            {presenting ? (
              <Notice
                icon={Loader2}
                iconClassName="animate-spin"
                title="Visual report is being regenerated"
                className="print:hidden"
              >
                This preview updates when the artifact planner and report composer finish.
              </Notice>
            ) : null}
            <div className="overflow-hidden rounded-lg border border-border print:overflow-visible print:rounded-none print:border-0">
              <ClientReportDocument report={report.data} resolveAsset={resolveAsset} interactive />
            </div>
            <p className="px-1 text-xs text-subtle print:hidden">
              Preview of the client report. The PDF and HTML exports are rendered from the same document; the PDF
              adds page numbers and expands collapsed sections.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
