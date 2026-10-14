import {
  type FindingCategory,
  type SecurityEngagementDetail,
  type SecurityFinding,
  type SecurityVerificationCandidate,
  type VerificationState,
} from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Download, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { SeverityBadge, Confidence } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, findingExportUrl } from '@/lib/api'
import { engagementFindingCandidatesQuery, engagementFindingCoverageQuery, engagementFindingsQuery, queryKeys, securityFindingQuery } from '@/lib/queries'
import { formatRelative } from '@/lib/format'

/*
 * Phase 6A: verified security findings and the candidates still under verification. A finding is the end of a
 * deliberate boundary — a signal, a comparison or a hypothesis alone is never shown here as a result. Verified
 * findings, supported signals and open investigation are kept visibly apart: Audivra never dresses an
 * unverified signal up as a finding. This view is read-only except for a button that queues a verification pass.
 */

const VERIFICATION: Record<VerificationState, { label: string; tone: BadgeTone; hint: string }> = {
  verified: { label: 'Verified', tone: 'success', hint: 'Requirements met and independently confirmed' },
  supported: { label: 'Supported', tone: 'info', hint: 'Evidence supports it, but not independently confirmed' },
  inconclusive: { label: 'Inconclusive', tone: 'medium', hint: 'A material contradiction or a benign alternative remains' },
  rejected: { label: 'Rejected', tone: 'neutral', hint: 'The evidence did not hold up' },
  blocked: { label: 'Blocked', tone: 'medium', hint: 'Independent verification was unavailable (never auto-verified)' },
  'needs-evidence': { label: 'Needs evidence', tone: 'neutral', hint: 'Not enough evidence yet' },
  unverified: { label: 'Unverified', tone: 'neutral', hint: 'Not yet evaluated' },
}

function VerificationBadge({ state }: { state: VerificationState }) {
  const v = VERIFICATION[state]
  return (
    <Badge tone={v.tone} dot title={v.hint}>
      {v.label}
    </Badge>
  )
}

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  authentication: 'Authentication',
  authorization: 'Authorization',
  'tenant-isolation': 'Tenant isolation',
  'business-logic': 'Business logic',
  'session-management': 'Session management',
  'api-behavior': 'API behavior',
  configuration: 'Configuration',
  dependency: 'Dependency',
  'transport-tls': 'Transport / TLS',
  exposure: 'Exposure',
  'source-runtime-inconsistency': 'Source / runtime',
}

const columns = (() => {
  const col = createColumnHelper<SecurityFinding>()
  return [
    col.accessor('severity', { header: 'Severity', cell: (c) => <SeverityBadge severity={c.getValue()} />, sortingFn: (a, b) => a.original.severity.localeCompare(b.original.severity) }),
    col.accessor('title', {
      header: 'Finding',
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-fg">{c.getValue()}</div>
          <div className="truncate text-2xs text-subtle">{c.row.original.affectedEntities.map((e) => e.label).join(', ') || '—'}</div>
        </div>
      ),
    }),
    col.accessor('category', { header: 'Category', cell: (c) => <span className="text-xs text-muted">{CATEGORY_LABEL[c.getValue()]}</span> }),
    col.accessor('verificationState', { header: 'Verification', cell: (c) => <VerificationBadge state={c.getValue()} /> }),
    col.accessor('confidence', { header: 'Confidence', cell: (c) => <Confidence value={c.getValue()} /> }),
    col.accessor('createdAt', { header: 'First seen', cell: (c) => <span className="text-2xs text-subtle">{formatRelative(c.getValue())}</span> }),
  ]
})()

function FindingDetail({ findingId }: { findingId: string }) {
  const query = useQuery(securityFindingQuery(findingId))
  if (query.isError) return <ErrorState title="Could not load the finding" error={query.error} onRetry={() => void query.refetch()} />
  const detail = query.data
  if (!detail) return <PanelBody className="text-xs text-subtle">Loading…</PanelBody>
  const { finding } = detail
  return (
    <PanelBody className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <VerificationBadge state={finding.verificationState} />
        <Confidence value={finding.confidence} />
        <span className="text-2xs text-subtle">{CATEGORY_LABEL[finding.category]}</span>
      </div>
      <Field label="Claim">{finding.claim}</Field>
      {finding.impact ? <Field label="Impact">{finding.impact}</Field> : null}
      {finding.remediation ? <Field label="Remediation">{finding.remediation}</Field> : null}
      <Field label="Why this severity">{finding.severityReason}</Field>
      <Field label="Affected">{finding.affectedEntities.map((e) => `${e.label} (${e.kind})`).join(', ') || '—'}</Field>
      {detail.evidence.length ? (
        <Field label={`Evidence (${detail.evidence.length})`}>
          <ul className="flex flex-col gap-1">
            {detail.evidence.map((e) => (
              <li key={e.ref} className="text-xs text-muted">
                <span className="font-mono text-2xs text-subtle">{e.ref}</span> {e.title}
                {e.identityRef ? <span className="text-subtle"> · as {e.identityRef}</span> : null}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      {finding.contradictingEvidenceRefs.length ? (
        <Field label="Contradicting evidence">{finding.contradictingEvidenceRefs.join(', ')}</Field>
      ) : null}
      {finding.reproduction ? (
        <Field label="Reproduction">
          <div className="flex flex-col gap-1 text-xs text-muted">
            {finding.reproduction.arms.map((a, i) => (
              <div key={i} className="font-mono text-2xs">
                [{a.role}] {a.method} {a.url} → {a.responseClass ?? '—'} {a.status ?? ''} {a.identityRef ? `(as ${a.identityRef})` : '(anon)'}
              </div>
            ))}
            {finding.reproduction.executionIds.length ? <div className="text-2xs text-subtle">executions: {finding.reproduction.executionIds.join(', ')}</div> : null}
          </div>
        </Field>
      ) : null}
    </PanelBody>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">{label}</div>
      <div className="text-sm text-fg">{children}</div>
    </div>
  )
}

const CANDIDATE_OPEN: VerificationState[] = ['unverified', 'needs-evidence', 'inconclusive', 'blocked']

function OpenCandidates({ candidates }: { candidates: SecurityVerificationCandidate[] }) {
  const open = candidates.filter((c) => CANDIDATE_OPEN.includes(c.status))
  if (!open.length) return null
  return (
    <Panel>
      <PanelHeader title="Open investigation" description="Candidates still under verification — not findings. Shown honestly as open work, never as results." />
      <PanelBody className="flex flex-col gap-2">
        {open.map((c) => (
          <div key={c.id} className="flex items-start justify-between gap-3 border-b border-border/50 pb-2 last:border-0 last:pb-0">
            <div className="min-w-0">
              <div className="truncate text-sm text-fg">{c.claim}</div>
              <div className="text-2xs text-subtle">
                {c.source.origin} · {c.statusReason}
              </div>
            </div>
            <VerificationBadge state={c.status} />
          </div>
        ))}
      </PanelBody>
    </Panel>
  )
}

export function FindingsTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const findings = useQuery(engagementFindingsQuery(engagement.id))
  const candidates = useQuery(engagementFindingCandidatesQuery(engagement.id))
  const coverage = useQuery(engagementFindingCoverageQuery(engagement.id))
  const rows = findings.data ?? []
  const table = useDataTable({ data: rows, columns, getRowId: (row) => row.id, initialSorting: [{ id: 'severity', desc: false }] })

  const verify = useMutation({
    mutationFn: () => api.verifyFindings(engagement.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id, 'findings'] })
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementFindingCandidates(engagement.id) })
    },
  })

  const byVerification = coverage.data?.findings.byVerification ?? {}
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Findings"
          description="Verified and supported security findings, produced only through the verification boundary. A scanner hit or an AI opinion alone never becomes a finding."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <a href={findingExportUrl(engagement.id, 'json')} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                <Download className="size-3.5" /> JSON
              </a>
              <a href={findingExportUrl(engagement.id, 'csv-findings')} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                <Download className="size-3.5" /> CSV
              </a>
              <Button size="sm" onClick={() => verify.mutate()} disabled={verify.isPending}>
                {verify.isPending ? 'Queuing…' : 'Run verification'}
              </Button>
            </div>
          }
        />
        <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
          <Metric label="Verified" value={byVerification.verified ?? 0} tone={byVerification.verified ? 'success' : 'muted'} />
          <Metric label="Supported" value={byVerification.supported ?? 0} tone="default" />
          <Metric label="Inconclusive" value={byVerification.inconclusive ?? 0} tone="muted" />
          <Metric label="Candidates" value={coverage.data?.candidates.total ?? 0} tone="muted" />
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <Panel>
          {findings.isError ? (
            <ErrorState title="Could not load findings" error={findings.error} onRetry={() => void findings.refetch()} />
          ) : (
            <DataTable
              table={table}
              isLoading={findings.isLoading}
              minWidth="min-w-140"
              onRowClick={(row) => setSelected(row.id)}
              empty={
                <EmptyState
                  icon={ShieldCheck}
                  title="No findings yet"
                  description="Findings appear here as the verification boundary confirms strong, evidence-backed signals. Run verification once observations and comparisons exist."
                />
              }
            />
          )}
        </Panel>
        {selected ? (
          <Panel>
            <PanelHeader title="Finding detail" actions={<button className="text-xs text-subtle hover:text-fg" onClick={() => setSelected(null)}>Close</button>} />
            <FindingDetail findingId={selected} />
          </Panel>
        ) : null}
      </div>

      <OpenCandidates candidates={candidates.data ?? []} />
    </div>
  )
}
