import type {
  AuditChanges,
  AuditComparison,
  AuditDetail,
  ChangeBasis,
  ChangeInsight,
  ChangeKind,
  FindingTimeline,
  JourneyChange,
  Severity,
} from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { Loader2, RefreshCw, Sparkles, type LucideIcon, type LucideProps } from 'lucide-react'
import { useState } from 'react'
import { JOURNEY_DIMENSION_LABEL, JOURNEY_STEP, JOURNEY_TYPE_LABEL, JourneyHealthBadge, SEVERITY_LABEL } from '@/components/badges'
import { Panel, PanelHeader } from '@/components/panel'
import { EmptyState, Notice } from '@/components/states'
import { Badge, tagVariants, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuditNav } from '@/features/audit/audit-nav'
import { RefChip } from '@/features/audit/journey-flow'
import { useEnrichMutation, useRefreshAfterEnrich } from '@/features/audit/use-enrich'
import { formatRelative, pluralize } from '@/lib/format'
import { cn } from '@/lib/utils'

const Spinner = ((props: LucideProps) => <Loader2 {...props} className={cn(props.className, 'animate-spin')} />) as LucideIcon

export const CHANGE_KIND: Record<ChangeKind, { label: string; tone: string }> = {
  regression: { label: 'Regression', tone: 'text-critical' },
  'new-issue': { label: 'New issue', tone: 'text-high' },
  improvement: { label: 'Improvement', tone: 'text-success' },
  'not-found-again': { label: 'Not found again', tone: 'text-success' },
  persistent: { label: 'Still present', tone: 'text-muted' },
  journey: { label: 'Journey', tone: 'text-foreground' },
  tracking: { label: 'Tracking', tone: 'text-foreground' },
  metric: { label: 'Measurement', tone: 'text-foreground' },
  technology: { label: 'Technology', tone: 'text-foreground' },
  coverage: { label: 'Coverage', tone: 'text-muted' },
}

export const CHANGE_BASIS: Record<ChangeBasis, { label: string; hint: string }> = {
  verified: { label: 'Verified', hint: 'Both states were measured and the evidence shows the cause.' },
  observed: { label: 'Observed', hint: 'The change itself was measured; its cause is not established.' },
  correlated: { label: 'Correlated', hint: 'A possible contributor changed at the same time; not proven to be the cause.' },
  likely: { label: 'Likely', hint: 'A reasoned interpretation of the facts, not directly shown.' },
}

function InsightRefs({ insight, comparison }: { insight: ChangeInsight; comparison: AuditComparison }) {
  const nav = useAuditNav()
  const journeys = new Map(comparison.journeys.map((j) => [j.journeyKey, j]))
  const metrics = new Map(comparison.metrics.map((m) => [m.key, m]))
  const any =
    insight.currentFindingIds.length + insight.previousFindingIds.length + insight.journeyKeys.length + insight.metricKeys.length + insight.evidenceIds.length
  if (!any) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {insight.currentFindingIds.map((ref) => (
        <RefChip key={`c-${ref}`} value={ref} onClick={() => nav?.openFinding(ref)} title="Open finding" />
      ))}
      {insight.previousFindingIds.map((ref) => (
        <Link
          key={`p-${ref}`}
          to="/audits/$auditId"
          params={{ auditId: comparison.previous.id }}
          search={{ finding: ref }}
          className={tagVariants({ kind: 'ref' })}
          title="Finding in the previous audit"
        >
          was {ref}
        </Link>
      ))}
      {insight.journeyKeys.map((key) => {
        const journey = journeys.get(key)
        return journey?.currentRef ? (
          <RefChip key={`j-${key}`} value={`${journey.currentRef} · ${journey.name}`} onClick={() => nav?.openJourney(journey.currentRef!)} title="Open journey" />
        ) : (
          <span key={`j-${key}`} className={tagVariants({ kind: 'code' })}>
            {journey?.name ?? key}
          </span>
        )
      })}
      {insight.metricKeys.map((key) => (
        <span key={`m-${key}`} className={tagVariants({ kind: 'code' })}>
          {metrics.get(key)?.label ?? key}
        </span>
      ))}
      {insight.evidenceIds.map((ref) => (
        <RefChip key={`e-${ref}`} value={ref} onClick={() => nav?.openEvidence(ref)} title="Open evidence" />
      ))}
    </div>
  )
}

function InsightRow({ insight, comparison }: { insight: ChangeInsight; comparison: AuditComparison }) {
  const kind = CHANGE_KIND[insight.kind]
  const basis = CHANGE_BASIS[insight.basis]
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('text-xs font-medium', kind.tone)}>{kind.label}</span>
        <Badge tone="neutral" title={basis.hint}>
          {basis.label}
        </Badge>
        {insight.importance === 'high' ? <span className="text-2xs text-subtle">High importance</span> : null}
      </div>
      <h3 className="mt-1 text-sm font-semibold text-foreground" dir="auto">
        {insight.title}
      </h3>
      <p className="mt-0.5 text-sm text-muted text-break" dir="auto">
        {insight.description}
      </p>
      <InsightRefs insight={insight} comparison={comparison} />
    </li>
  )
}

/**
 * "What changed since the previous audit?" — the stored Change Intelligence interpretation of the
 * deterministic comparison, or the action to produce it. The comparison stays the source of truth.
 */
export function ChangeIntelligencePanel({ audit, changes }: { audit: AuditDetail; changes: AuditChanges }) {
  const generate = useEnrichMutation(audit.id, 'changes')
  const { status, intelligence, comparison } = changes
  useRefreshAfterEnrich(audit.id, 'changes', status.running)
  const running = status.running || generate.isPending
  if (!comparison) return null

  const failure = status.lastError ? (
    <Notice tone="critical" title="The last change analysis failed">
      {status.lastError}
    </Notice>
  ) : null

  if (!intelligence) {
    return (
      <div className="flex flex-col gap-3">
        {failure}
        <Panel>
          <PanelHeader title="What changed since the previous audit?" />
          {running ? (
            <EmptyState
              compact
              icon={Spinner}
              title="Interpreting the changes…"
              description="Claude is explaining the comparison below: what matters and why. It adds no new facts. Progress shows in Runs."
            />
          ) : (
            <EmptyState
              compact
              icon={Sparkles}
              title="No change interpretation yet"
              description={
                status.available
                  ? 'Change intelligence explains the comparison below for the site owner: what matters most, what was not found again and what got worse. Every statement is checked against the comparison.'
                  : status.reason
              }
              action={
                status.available ? (
                  <Button size="sm" onClick={() => generate.mutate()} disabled={generate.isPending}>
                    <Sparkles />
                    Generate change intelligence
                  </Button>
                ) : undefined
              }
            />
          )}
        </Panel>
      </div>
    )
  }

  const { analysis } = intelligence
  return (
    <div className="flex flex-col gap-3">
      {failure}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="What changed since the previous audit?"
          description={`Interpretation of the comparison below · generated ${formatRelative(intelligence.createdAt)}`}
          actions={
            status.available ? (
              <Button size="sm" variant="ghost" onClick={() => generate.mutate()} disabled={running} title="Interpret the comparison again">
                {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {running ? 'Regenerating…' : 'Regenerate'}
              </Button>
            ) : null
          }
        />
        <div className="border-b border-border px-4 py-3.5">
          <p className="text-base font-semibold text-foreground" dir="auto">
            {analysis.headline}
          </p>
          {analysis.summary ? (
            <p className="mt-1 max-w-4xl text-sm text-muted text-break" dir="auto">
              {analysis.summary}
            </p>
          ) : null}
        </div>
        {analysis.insights.length ? (
          <ul className="divide-y divide-border">
            {analysis.insights.map((insight, index) => (
              <InsightRow key={index} insight={insight} comparison={comparison} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-muted">No change stood out beyond the counts below.</p>
        )}
        <p className="border-t border-border px-4 py-2 text-2xs text-subtle">
          “Not found again” means the issue was not reported in this audit; it is not proof of a fix. Basis labels say how firmly each
          point is established.
        </p>
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------------ */

const JOURNEY_CHANGE: Record<JourneyChange['status'], { label: string; tone: BadgeTone }> = {
  new: { label: 'New', tone: 'high' },
  'not-found-again': { label: 'Not found again', tone: 'neutral' },
  changed: { label: 'Changed', tone: 'medium' },
  unchanged: { label: 'Unchanged', tone: 'neutral' },
}

function stepLabel(status: string | null): string {
  return status && status in JOURNEY_STEP ? JOURNEY_STEP[status as keyof typeof JOURNEY_STEP].label : 'Not present'
}

/** How the site's journeys changed: path, primary status, step statuses and health dimensions. */
export function JourneyChanges({ comparison }: { comparison: AuditComparison }) {
  const nav = useAuditNav()
  const [showUnchanged, setShowUnchanged] = useState(false)
  if (!comparison.journeys.length) return null
  const unchanged = comparison.journeys.filter((j) => j.status === 'unchanged')
  const shown = comparison.journeys.filter((j) => showUnchanged || j.status !== 'unchanged')
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Journey changes"
        description="Matched by journey key, then by type and path"
        actions={
          unchanged.length ? (
            <Button size="sm" variant="ghost" onClick={() => setShowUnchanged((v) => !v)} aria-expanded={showUnchanged}>
              {showUnchanged ? 'Hide unchanged' : `Show unchanged (${unchanged.length})`}
            </Button>
          ) : null
        }
      />
      {shown.length ? (
        <ul className="divide-y divide-border">
          {shown.map((journey) => {
            const config = JOURNEY_CHANGE[journey.status]
            return (
              <li key={journey.journeyKey} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground" dir="auto">
                    {journey.name}
                  </span>
                  <span className="text-xs text-subtle">{JOURNEY_TYPE_LABEL[journey.type]}</span>
                  <Badge tone={config.tone}>{config.label}</Badge>
                  {journey.primaryBefore === false && journey.primaryAfter ? <Badge tone="neutral">Now the primary journey</Badge> : null}
                  {journey.primaryBefore && journey.primaryAfter === false ? <Badge tone="neutral">No longer primary</Badge> : null}
                  {journey.currentRef ? (
                    <span className="ml-auto">
                      <RefChip value={journey.currentRef} onClick={() => nav?.openJourney(journey.currentRef!)} title="Open journey" />
                    </span>
                  ) : null}
                </div>
                {journey.pathChanged && journey.pathBefore && journey.pathAfter ? (
                  <div className="grid gap-0.5 text-xs">
                    <span className="text-muted">
                      <span className="text-subtle">Before:</span> {journey.pathBefore.join(' › ')}
                    </span>
                    <span className="text-foreground">
                      <span className="text-subtle">Now:</span> {journey.pathAfter.join(' › ')}
                    </span>
                  </div>
                ) : journey.pathAfter ?? journey.pathBefore ? (
                  <span className="text-xs text-muted" dir="auto">
                    {(journey.pathAfter ?? journey.pathBefore)!.join(' › ')}
                  </span>
                ) : null}
                {journey.steps.length ? (
                  <ul className="flex flex-col gap-0.5 text-xs">
                    {journey.steps.map((step) => (
                      <li key={step.label} className="text-muted">
                        Step <span className="text-foreground">{step.label}</span>: {stepLabel(step.before)} →{' '}
                        <span className="text-foreground">{stepLabel(step.after)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {journey.health.length ? (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1">
                    {journey.health.map((h) => (
                      <li key={h.dimension} className="flex items-center gap-1.5 text-xs text-muted">
                        <span className="text-foreground">{JOURNEY_DIMENSION_LABEL[h.dimension]}</span>
                        <JourneyHealthBadge status={h.before} />
                        <span aria-hidden>→</span>
                        <span className="sr-only">changed to</span>
                        <JourneyHealthBadge status={h.after} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="px-4 py-3 text-sm text-muted">The journeys are the same as in the previous audit.</p>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------------------------------------------ */

const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Deterministic site-level summary of the tracked issues (from the timelines). */
export function timelineSummary(timelines: FindingTimeline[]): { tracked: number; present: number; notFound: number; returned: number } {
  return {
    tracked: timelines.length,
    present: timelines.filter((t) => t.entries.at(-1)?.status !== 'not-found').length,
    notFound: timelines.filter((t) => t.entries.at(-1)?.status === 'not-found').length,
    returned: timelines.filter((t) => t.entries.some((e) => e.status === 'detected-again')).length,
  }
}

const VISIBLE_AUDITS = 6
const VISIBLE_ROWS = 10

/** Each issue across this site's audits: detected, not found, or detected again. */
export function IssueTimelines({ timelines, currentAuditId }: { timelines: FindingTimeline[]; currentAuditId: string }) {
  const nav = useAuditNav()
  const [all, setAll] = useState(false)
  if (!timelines.length) return null
  const audits = new Map<string, string>()
  for (const t of timelines) for (const e of t.entries) audits.set(e.auditId, e.date)
  const columns = [...audits].sort((a, b) => a[1].localeCompare(b[1])).slice(-VISIBLE_AUDITS)
  // Several audits on one day get their time as well, so columns stay distinguishable.
  const dates = columns.map(([, date]) => shortDate(date))
  const label = (date: string, index: number) =>
    dates.filter((d) => d === dates[index]).length > 1
      ? `${dates[index]} ${new Date(date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : dates[index]
  const rows = all ? timelines : timelines.slice(0, VISIBLE_ROWS)
  const summary = timelineSummary(timelines)
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Issue timelines"
        description={`${pluralize(summary.tracked, 'issue')} across ${pluralize(audits.size, 'audit')} · ${summary.present} still present · ${summary.notFound} not found again${summary.returned ? ` · ${summary.returned} came back` : ''}`}
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="h-8 bg-surface-muted px-3 pl-4 text-left text-xs font-medium text-muted">
                Issue
              </th>
              {columns.map(([id, date], index) => (
                <th key={id} scope="col" className="h-8 w-16 bg-surface-muted px-2 text-center text-xs font-medium whitespace-nowrap text-muted">
                  {id === currentAuditId ? 'This audit' : label(date, index)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((timeline) => {
              const byAudit = new Map(timeline.entries.map((e) => [e.auditId, e]))
              return (
                <tr key={`${timeline.key}-${timeline.entries[0]?.auditId}`} className="border-b border-border last:border-b-0">
                  <th scope="row" className="max-w-0 px-3 py-2 pl-4 text-left font-normal">
                    {timeline.currentRef ? (
                      <button
                        type="button"
                        onClick={() => nav?.openFinding(timeline.currentRef!)}
                        className="block w-full cursor-pointer truncate text-left text-foreground hover:underline"
                        title={timeline.title}
                        dir="auto"
                      >
                        {timeline.title}
                      </button>
                    ) : (
                      <span className="block truncate text-muted" title={timeline.title} dir="auto">
                        {timeline.title}
                      </span>
                    )}
                    <span className="text-2xs text-subtle">{timeline.category}</span>
                  </th>
                  {columns.map(([id]) => {
                    const entry = byAudit.get(id)
                    return (
                      <td key={id} className="px-2 text-center">
                        {!entry ? (
                          <span className="text-2xs text-subtle" aria-label="Not yet tracked">
                            ·
                          </span>
                        ) : entry.status === 'not-found' ? (
                          <span
                            className="inline-block size-2.5 rounded-full border border-border-strong"
                            title="Not found in this audit (not proof of a fix)"
                            aria-label="Not found"
                          />
                        ) : (
                          <span
                            className={cn(
                              'inline-block size-2.5 rounded-full',
                              entry.severity ? SEVERITY_DOT[entry.severity] : 'bg-subtle',
                              entry.status === 'detected-again' && 'ring-2 ring-border-strong ring-offset-1 ring-offset-surface',
                            )}
                            title={`${entry.status === 'detected-again' ? 'Detected again' : 'Detected'}${entry.ref ? ` as ${entry.ref}` : ''}${entry.severity ? ` · ${SEVERITY_LABEL[entry.severity]}` : ''}`}
                            aria-label={entry.status === 'detected-again' ? 'Detected again' : 'Detected'}
                          />
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-2xs text-subtle">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-high" aria-hidden /> Detected (colour = severity)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-high ring-2 ring-border-strong ring-offset-1 ring-offset-surface" aria-hidden /> Detected again
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full border border-border-strong" aria-hidden /> Not found (not proof of a fix)
        </span>
        {timelines.length > VISIBLE_ROWS ? (
          <button type="button" onClick={() => setAll((v) => !v)} className="ml-auto cursor-pointer text-xs text-muted hover:text-foreground">
            {all ? 'Show fewer' : `Show all ${timelines.length}`}
          </button>
        ) : null}
      </div>
    </Panel>
  )
}
