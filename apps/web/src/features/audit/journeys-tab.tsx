import type { AuditDetail, FindingItem, JourneyItem } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, Route, Waypoints, type LucideIcon, type LucideProps } from 'lucide-react'
import { Confidence, JOURNEY_TYPE_LABEL, SeverityBadge } from '@/components/badges'
import { Panel, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState, Notice } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuditNav } from '@/features/audit/audit-nav'
import { JourneyHealthList, JourneySteps, journeySummary } from '@/features/audit/journey-flow'
import { useEnrichMutation, useRefreshAfterEnrich } from '@/features/audit/use-enrich'
import { formatRelative } from '@/lib/format'
import { isFinished, journeysQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const Spinner = ((props: LucideProps) => <Loader2 {...props} className={cn(props.className, 'animate-spin')} />) as LucideIcon

function JourneyRow({ journey, active, onSelect }: { journey: JourneyItem; active: boolean; onSelect: () => void }) {
  const summary = journeySummary(journey)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        'flex w-full cursor-pointer items-start gap-2.5 border-b border-border px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-hover',
        active && 'bg-surface-selected hover:bg-surface-selected',
      )}
    >
      <Route className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-medium text-foreground">{journey.ref}</span>
          <span className="truncate text-xs text-subtle">{JOURNEY_TYPE_LABEL[journey.type]}</span>
          {journey.isPrimary ? (
            <Badge tone="neutral" className="ml-auto">
              Primary
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 text-sm text-foreground" dir="auto">
          {journey.name}
        </div>
        <div className={cn('mt-0.5 text-xs', summary.tone === 'critical' ? 'text-critical' : summary.tone === 'medium' ? 'text-medium' : 'text-muted')}>
          {journey.steps.length} steps · {summary.text}
        </div>
      </div>
    </button>
  )
}

function JourneyDetail({ journey, findings }: { journey: JourneyItem; findings: FindingItem[] }) {
  const nav = useAuditNav()
  const healthFindings = journey.health.flatMap((h) => h.findingIds)
  const related = findings.filter((f) => journey.findingRefs.includes(f.ref) || healthFindings.includes(f.ref))
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Panel>
        <PanelHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span dir="auto">{journey.name}</span>
              {journey.isPrimary ? <Badge tone="neutral">Primary journey</Badge> : null}
            </span>
          }
          description={`${journey.ref} · ${JOURNEY_TYPE_LABEL[journey.type]} · ${journey.source === 'audit' ? 'Walked during the audit' : 'Mapped afterwards from the recorded evidence'}`}
          actions={
            <Button size="sm" variant="ghost" onClick={() => nav?.openGraph(`journey:${journey.ref}`)}>
              <Waypoints />
              Evidence graph
            </Button>
          }
        />
        <div className="flex flex-col gap-5 p-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <SectionLabel>Goal</SectionLabel>
              <p className="text-sm text-foreground" dir="auto">
                {journey.goal}
              </p>
              {journey.description ? (
                <p className="mt-2 text-sm text-muted text-break" dir="auto">
                  {journey.description}
                </p>
              ) : null}
            </div>
            <div>
              <SectionLabel>Confidence</SectionLabel>
              <Confidence value={journey.confidence} />
            </div>
          </div>
          <div>
            <SectionLabel>Steps</SectionLabel>
            <JourneySteps steps={journey.steps} onEvidence={(ref) => nav?.openEvidence(ref)} />
          </div>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Journey health" description="Each dimension is judged from the evidence on its own. There is no overall score." />
        <div className="p-4">
          <JourneyHealthList health={journey.health} onEvidence={(ref) => nav?.openEvidence(ref)} onFinding={(ref) => nav?.openFinding(ref)} />
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Findings on this journey" description={related.length ? undefined : 'No finding is linked to this journey.'} />
        {related.length ? (
          <ul className="divide-y divide-border">
            {related.map((finding) => (
              <li key={finding.ref}>
                <button
                  type="button"
                  onClick={() => nav?.openFinding(finding.ref)}
                  className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
                >
                  <SeverityBadge severity={finding.severity} />
                  <span className="font-mono text-xs text-muted">{finding.ref}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground" dir="auto">
                    {finding.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  )
}

/**
 * The paths visitors take to the site's goals, walked during the audit (or mapped afterwards for
 * audits from before journeys). Statuses come from evidence; nothing is scored.
 */
export function JourneysTab({
  audit,
  findings,
  selectedRef,
  onSelect,
}: {
  audit: AuditDetail
  findings: FindingItem[]
  selectedRef: string | null
  onSelect: (ref: string | null) => void
}) {
  const query = useQuery(journeysQuery(audit.id))
  const analyze = useEnrichMutation(audit.id, 'journeys')
  const status = query.data?.status
  useRefreshAfterEnrich(audit.id, 'journeys', status?.running)

  if (query.isError) {
    return (
      <Panel>
        <ErrorState title="Could not load journeys" error={query.error} onRetry={() => void query.refetch()} />
      </Panel>
    )
  }
  if (!query.data || !status) {
    return (
      <Panel>
        <LoadingState rows={4} />
      </Panel>
    )
  }

  const journeys = query.data.journeys
  const running = status.running || analyze.isPending
  const failure = status.lastError ? (
    <Notice tone="critical" title="The last journey analysis failed">
      {status.lastError}
    </Notice>
  ) : null

  if (!journeys.length) {
    if (!isFinished(audit.status) && status.reason) {
      return (
        <Panel>
          <EmptyState icon={Route} title="Journeys appear when the audit finishes" description="The auditor maps and walks the site's journeys as part of the audit." />
        </Panel>
      )
    }
    return (
      <div className="flex flex-col gap-3">
        {failure}
        <Panel>
          {running ? (
            <EmptyState
              icon={Spinner}
              title="Analyzing journeys…"
              description="Claude is mapping journeys from the evidence and findings this audit recorded. The site is not browsed again. This usually takes a few minutes; progress shows in Runs."
            />
          ) : (
            <EmptyState
              icon={Route}
              title="Journey analysis not available for this audit."
              description={
                !status.available
                  ? status.reason
                  : status.lastCompletedAt
                    ? `The last analysis (${formatRelative(status.lastCompletedAt)}) found no journey that the recorded evidence supports.`
                    : 'No journeys were recorded for this audit. Journey analysis maps them from the evidence and findings it already has; the site is not browsed again.'
              }
              action={
                status.available ? (
                  <Button size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
                    <Route />
                    {status.lastCompletedAt || status.lastError ? 'Analyze again' : 'Analyze journeys'}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Panel>
      </div>
    )
  }

  const active = journeys.find((j) => j.ref === selectedRef) ?? journeys[0]!
  const fromAnalysis = journeys.every((j) => j.source === 'analysis')

  return (
    <div className="flex flex-col gap-3">
      {failure}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Panel className="self-start overflow-hidden lg:sticky lg:top-4">
          <PanelHeader
            title="Journeys"
            description={fromAnalysis ? 'Mapped from the recorded evidence' : 'Walked during the audit'}
            actions={
              fromAnalysis && status.available ? (
                <Button size="sm" variant="ghost" onClick={() => analyze.mutate()} disabled={running} title="Map the journeys again from the recorded evidence">
                  {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {running ? 'Analyzing…' : 'Re-analyze'}
                </Button>
              ) : null
            }
          />
          {journeys.map((journey) => (
            <JourneyRow key={journey.id} journey={journey} active={journey.ref === active.ref} onSelect={() => onSelect(journey.ref)} />
          ))}
        </Panel>
        <JourneyDetail key={active.ref} journey={active} findings={findings} />
      </div>
    </div>
  )
}
