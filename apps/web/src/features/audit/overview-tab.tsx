import {
  SEVERITIES,
  SEVERITY_RANK,
  type Artifact,
  type AuditDetail,
  type FindingItem,
  type LimitationItem,
  type StoredOpportunity,
} from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Bot,
  Briefcase,
  ChartColumn,
  CircleSlash,
  FileSearch,
  Info,
  Loader2,
  RotateCw,
  TriangleAlert,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { AppArtifact } from '@/components/artifact-card'
import {
  Confidence,
  COVERAGE_STATUS,
  CoverageIcon,
  FindingTypeBadge,
  JOURNEY_DIMENSION_LABEL,
  JOURNEY_TYPE_LABEL,
  JourneyHealthBadge,
  LevelText,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  STAGE_LABELS,
  SeverityBadge,
} from '@/components/badges'
import { Metric, type MetricTone } from '@/components/metric'
import { DefinitionList, Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { RichText } from '@/components/rich-text'
import { EmptyState, LoadingState, Notice } from '@/components/states'
import { Dot, tagVariants } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { Tooltip } from '@/components/ui/tooltip'
import { formatBytes, formatMs, formatNumber, formatScore, pluralize, urlPath } from '@/lib/format'
import { changesQuery, comparisonQuery, isFinished, isTerminal, journeysQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { JourneyPath, journeyHealthRows, journeySummary } from './journey-flow'
import { usePresentMutation } from './use-present'

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

function scoreTone(score: number | null | undefined): MetricTone {
  if (score === null || score === undefined) return 'muted'
  const value = score <= 1 ? score * 100 : score
  return value >= 90 ? 'success' : value >= 50 ? 'medium' : 'critical'
}

function thresholdTone(value: number | null | undefined, good: number, poor: number): MetricTone {
  if (value === null || value === undefined) return 'muted'
  return value <= good ? 'success' : value <= poor ? 'medium' : 'critical'
}

function countTone(value: number, tone: MetricTone = 'critical'): MetricTone {
  return value > 0 ? tone : 'muted'
}

/** Paragraphs of the executive summary that are prose (not list items). */
function leadParagraphs(text: string, count: number): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block && !/^([-*•]|\d+\.)\s/.test(block) && !block.includes('\n- '))
    .slice(0, count)
}

const LIMITATION_GROUPS: { kind: LimitationItem['kind']; label: string; hint: string }[] = [
  { kind: 'could-not-verify', label: 'Could not verify', hint: 'Checked, but not confirmable from the outside.' },
  { kind: 'environment', label: 'Environment', hint: 'Tooling or network limits of this run.' },
  { kind: 'inference', label: 'Inferred', hint: 'Conclusions drawn without direct proof.' },
  { kind: 'out-of-scope', label: 'Out of scope', hint: 'Deliberately not examined.' },
]

function opportunityText(opportunity: StoredOpportunity): string {
  return opportunity.why ?? opportunity.description ?? ''
}

function RefButtons({ refs, onOpen }: { refs: string[]; onOpen: (ref: string) => void }) {
  if (!refs.length) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {refs.map((ref) => (
        <button key={ref} type="button" onClick={() => onOpen(ref)} className={tagVariants({ kind: 'ref' })}>
          {ref}
        </button>
      ))}
    </span>
  )
}

function EvidenceLinks({ auditId, refs }: { auditId: string; refs: string[] }) {
  if (!refs.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-2xs text-subtle">Evidence</span>
      {refs.map((ref) => (
        <Link
          key={ref}
          to="/audits/$auditId"
          params={{ auditId }}
          search={{ tab: 'evidence', ev: ref }}
          className={tagVariants({ kind: 'ref' })}
        >
          {ref}
        </Link>
      ))}
    </div>
  )
}

function TabLink({
  auditId,
  tab,
  children,
}: {
  auditId: string
  tab: 'findings' | 'journeys' | 'visuals' | 'history' | 'evidence' | 'activity'
  children: ReactNode
}) {
  return (
    <Link
      to="/audits/$auditId"
      params={{ auditId }}
      search={{ tab }}
      className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
    >
      {children}
      <ArrowRight className="size-3" />
    </Link>
  )
}

/* ------------------------------------------------------------------------------------------------
 * Notices
 * ---------------------------------------------------------------------------------------------- */

function StatusNotice({ audit }: { audit: AuditDetail }) {
  const running = audit.steps.find((step) => step.status === 'running')
  if (!isTerminal(audit.status)) {
    return (
      <Notice
        icon={Loader2}
        iconClassName="animate-spin"
        title={`Audit in progress${running ? ` — ${STAGE_LABELS[running.stage]}` : ''}`}
      >
        Baseline facts and evidence appear as they are collected. Findings are written after the review and
        finalization stages; visuals and the client report follow.
      </Notice>
    )
  }
  if (!audit.aiEnabled) {
    return (
      <Notice icon={Info} title="Baseline-only audit (AI disabled)">
        The facts below are deterministic measurements and scanner leads, not reviewed findings.
      </Notice>
    )
  }
  if (audit.status === 'cancelled') {
    return (
      <Notice icon={CircleSlash} title="Audit cancelled">
        Everything collected before cancellation is preserved.
      </Notice>
    )
  }
  if (audit.error) {
    const ai = audit.error.kind === 'ai'
    return (
      <Notice
        tone="critical"
        icon={TriangleAlert}
        title={
          ai
            ? 'AI investigation failed — baseline evidence preserved'
            : `Audit ${audit.status === 'partial' ? 'finished partially' : 'failed'}`
        }
      >
        {audit.error.message}
        {audit.error.stage ? (
          <span className="text-subtle"> · stage: {STAGE_LABELS[audit.error.stage]}</span>
        ) : null}
      </Notice>
    )
  }
  if (audit.status === 'partial') {
    return (
      <Notice tone="warning" icon={TriangleAlert} title="Audit finished partially">
        Some stages did not complete. Coverage below shows what ran; the Activity tab shows why.
      </Notice>
    )
  }
  return null
}

/**
 * Visual report state for finished audits: offer generation when the planner/composer never ran
 * (older audits) or failed, and show progress while it runs.
 */
function PresentNotice({
  audit,
  findings,
  presenting,
}: {
  audit: AuditDetail
  findings: FindingItem[]
  presenting: boolean
}) {
  const present = usePresentMutation(audit.id)
  const step = audit.steps.find((s) => s.stage === 'presenting')

  if (presenting) {
    const queued = step?.status === 'pending'
    return (
      <Notice icon={Loader2} iconClassName="animate-spin" title={queued ? 'Visual report queued' : 'Generating visual report'}>
        {queued
          ? 'Starts when the worker picks it up. Findings and evidence stay as they are.'
          : 'The artifact planner and report composer are working from the stored findings and evidence.'}
      </Notice>
    )
  }
  // The audit's own count is known before the findings list loads, so the notice doesn't pop in late.
  if (!isFinished(audit.status) || !audit.aiEnabled || (findings.length === 0 && audit.findingCount === 0)) return null

  const action = (
    <Button size="sm" onClick={() => present.mutate()} disabled={present.isPending}>
      {present.isPending ? <Loader2 className="animate-spin" /> : step?.status === 'failed' ? <RotateCw /> : <ChartColumn />}
      {step?.status === 'failed' ? 'Try again' : 'Generate visual report'}
    </Button>
  )
  if (step?.status === 'failed') {
    return (
      <Notice tone="warning" icon={TriangleAlert} title="Visual report generation failed" action={action}>
        {step.error?.message ?? step.message ?? 'The planner or composer did not finish.'} Findings and evidence are
        unaffected.
      </Notice>
    )
  }
  if (audit.reportPlan) return null
  return (
    <Notice icon={ChartColumn} title="Curated visuals not generated" action={action}>
      {audit.artifactCount > 0
        ? 'Basic charts were built from the measurements. Generating adds finding-specific visuals and a curated client report.'
        : 'Generate charts and a curated client report from the stored findings and evidence.'}{' '}
      The site is not crawled again.
    </Notice>
  )
}

/* ------------------------------------------------------------------------------------------------
 * KPI strip
 * ---------------------------------------------------------------------------------------------- */

function Kpi({
  label,
  value,
  detail,
  tone = 'default',
  numeric = true,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: MetricTone
  numeric?: boolean
}) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className="truncate text-xs text-muted">{label}</div>
      <div
        className={cn(
          'mt-1 truncate text-xl font-medium',
          numeric && 'font-mono tabular-nums',
          {
            default: 'text-foreground',
            critical: 'text-critical',
            high: 'text-high',
            medium: 'text-medium',
            low: 'text-low',
            success: 'text-success',
            muted: 'text-subtle',
          }[tone],
        )}
      >
        {value}
      </div>
      {detail ? <div className="mt-0.5 truncate text-xs text-subtle">{detail}</div> : null}
    </div>
  )
}

function KpiStrip({ audit, findings }: { audit: AuditDetail; findings: FindingItem[] }) {
  const finished = isFinished(audit.status)
  const comparison = useQuery({
    ...comparisonQuery(audit.id),
    enabled: finished && audit.previousAuditId !== null,
  })
  const terminal = isTerminal(audit.status)
  const hasFindings = findings.length > 0 || audit.findingCount > 0
  const severe = audit.severityCounts.critical + audit.severityCounts.high
  const { verified, observed, inferred } = audit.typeCounts
  const coverage = audit.coverage.filter((item) => item.status !== 'not-applicable')
  const ran = coverage.filter((item) => item.status === 'ran').length
  const partial = coverage.filter((item) => item.status === 'partial').length
  const notRun = coverage.length - ran - partial
  const baseline = audit.baseline
  const change = comparison.data?.summary

  return (
    <section
      aria-label="Audit at a glance"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-6"
    >
      <Kpi
        label="Findings"
        value={hasFindings ? formatNumber(audit.findingCount) : terminal ? '0' : '—'}
        tone={hasFindings ? 'default' : 'muted'}
        detail={
          hasFindings
            ? severe
              ? [
                  audit.severityCounts.critical ? `${audit.severityCounts.critical} critical` : null,
                  audit.severityCounts.high ? `${audit.severityCounts.high} high` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'None critical or high'
            : terminal
              ? 'No findings written'
              : 'Written at finalization'
        }
      />
      <Kpi
        label="Verified findings"
        value={hasFindings ? verified : '—'}
        tone={hasFindings ? 'default' : 'muted'}
        detail={hasFindings ? `${observed} observed · ${inferred} inferred` : 'Reproduced or measured'}
      />
      <Kpi
        label="Pages"
        value={baseline ? formatNumber(baseline.pagesCrawled) : '—'}
        tone={baseline ? 'default' : 'muted'}
        detail={
          baseline ? `crawled · ${formatNumber(baseline.pagesInspectedInBrowser)} in browser` : 'Crawl pending'
        }
      />
      <Kpi
        label="Evidence"
        value={formatNumber(audit.evidenceCount)}
        tone={audit.evidenceCount ? 'default' : 'muted'}
        detail="Proof behind findings"
      />
      <Kpi
        label="Coverage"
        value={coverage.length ? `${ran}/${coverage.length}` : '—'}
        tone={coverage.length ? 'default' : 'muted'}
        detail={
          coverage.length
            ? partial || notRun
              ? [partial ? `${partial} partial` : null, notRun ? `${notRun} not run` : null]
                  .filter(Boolean)
                  .join(' · ')
              : 'All checks ran'
            : 'Known when the audit finishes'
        }
      />
      {audit.previousAuditId && finished ? (
        <Kpi
          label="Since last audit"
          value={change ? `${change.new} new` : '—'}
          numeric={false}
          tone={change ? 'default' : 'muted'}
          detail={
            change
              ? `${change.resolved} not found again · ${change.regressed} regressed · ${change.unchanged} still present`
              : comparison.isError
                ? 'Comparison unavailable'
                : 'Comparing…'
          }
        />
      ) : (
        <Kpi
          label="History"
          value={audit.siteAuditCount > 1 ? `${audit.siteAuditCount} audits` : 'First audit'}
          numeric={false}
          tone="muted"
          detail={audit.siteAuditCount > 1 ? 'of this site' : 'Run again later to compare'}
        />
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------------------------------
 * Main column
 * ---------------------------------------------------------------------------------------------- */

function ExecutiveTake({ audit }: { audit: AuditDetail }) {
  const [open, setOpen] = useState(false)
  const summary = audit.summary?.executiveSummary ?? ''
  const lines = audit.reportPlan?.executiveSnapshot ?? []
  const lead = lines.length ? [] : leadParagraphs(summary, 2)
  // A summary written entirely as lists still gets an opening block.
  const paragraphs = lead.length || lines.length ? lead : summary.split(/\n{2,}/).slice(0, 1)
  return (
    <Panel>
      <PanelHeader
        title="Executive take"
        description={lines.length ? 'Selected by the report composer from reviewed findings' : 'Opening of the executive summary'}
        actions={
          summary ? (
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              View full analysis
              <ArrowRight />
            </Button>
          ) : null
        }
      />
      <PanelBody>
        {lines.length ? (
          <ul className="flex flex-col gap-1.5 text-base leading-relaxed text-foreground">
            {lines.map((line, index) => (
              <li key={index} className="flex gap-2.5">
                <span className="mt-2.5 size-1 shrink-0 rounded-full bg-subtle" aria-hidden />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-2.5 text-base leading-relaxed text-foreground">
            {paragraphs.map((paragraph, index) => (
              <RichText key={index} text={paragraph} />
            ))}
          </div>
        )}
      </PanelBody>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Full analysis"
        eyebrow={<span className="text-xs text-muted">{audit.domain}</span>}
        description="Executive summary written by the finalizer from reviewed findings"
      >
        <div className="px-5 py-5">
          <RichText text={summary} className="text-base leading-relaxed text-foreground" />
        </div>
      </Sheet>
    </Panel>
  )
}

function TopRisks({
  audit,
  findings,
  onOpenFinding,
}: {
  audit: AuditDetail
  findings: FindingItem[]
  onOpenFinding: (ref: string) => void
}) {
  const byRef = new Map(findings.map((f) => [f.ref, f]))
  const planned = (audit.reportPlan?.topRiskFindingIds ?? [])
    .map((ref) => byRef.get(ref))
    .filter((f): f is FindingItem => Boolean(f))
  // Same fallback as the client report: most severe first, then the finalizer's priority order.
  const ranked = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rank - b.rank,
  )
  const fallback = ranked.filter((f) => f.severity !== 'info')
  const top = (planned.length ? planned : fallback.length ? fallback : ranked).slice(0, 5)
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="What matters most"
        description={planned.length ? 'Chosen by the report composer' : 'Most severe findings, in priority order'}
        actions={
          findings.length > top.length ? (
            <TabLink auditId={audit.id} tab="findings">
              All {findings.length}
            </TabLink>
          ) : null
        }
      />
      <ul>
        {top.map((finding) => (
          <li key={finding.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => onOpenFinding(finding.ref)}
              className="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
            >
              <SeverityBadge severity={finding.severity} className="mt-px" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{finding.title}</div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                  <span>{finding.category}</span>
                  {finding.affectedUrls[0] ? (
                    <>
                      <span className="text-subtle">·</span>
                      <span className="max-w-64 truncate font-mono">{urlPath(finding.affectedUrls[0])}</span>
                    </>
                  ) : null}
                  <span className="text-subtle">·</span>
                  <span>{pluralize(finding.evidenceRefs.length, 'evidence item')}</span>
                </div>
              </div>
              <span className="hidden shrink-0 sm:block">
                <FindingTypeBadge type={finding.type} short />
              </span>
              <span className="shrink-0 pt-0.5 font-mono text-2xs text-subtle">{finding.ref}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** The most important conversion path, compactly: its steps and the dimensions that need attention. */
function PrimaryJourney({ audit }: { audit: AuditDetail }) {
  const query = useQuery({ ...journeysQuery(audit.id), enabled: isFinished(audit.status) })
  const journeys = query.data?.journeys ?? []
  const journey = journeys.find((j) => j.isPrimary) ?? journeys[0]
  if (!journey) return null
  const concerns = journeyHealthRows(journey.health).filter((h) => h.status === 'problem' || h.status === 'warning')
  const summary = journeySummary(journey)
  return (
    <Panel>
      <PanelHeader
        title={journey.isPrimary ? 'Primary journey' : 'Main journey'}
        description={`${JOURNEY_TYPE_LABEL[journey.type]} · ${journey.name}`}
        actions={
          <Link
            to="/audits/$auditId"
            params={{ auditId: audit.id }}
            search={{ tab: 'journeys', journey: journey.ref }}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
          >
            {journeys.length > 1 ? `All ${journeys.length} journeys` : 'Details'}
            <ArrowRight className="size-3" />
          </Link>
        }
      />
      <PanelBody className="flex flex-col gap-3">
        <JourneyPath steps={journey.steps} />
        {concerns.length ? (
          <ul className="flex flex-col gap-1.5">
            {concerns.slice(0, 3).map((row) => (
              <li key={row.dimension} className="flex items-start gap-2 text-sm">
                <span className="mt-px shrink-0">
                  <JourneyHealthBadge status={row.status} />
                </span>
                <span className="min-w-0 text-muted" dir="auto">
                  <span className="text-foreground">{JOURNEY_DIMENSION_LABEL[row.dimension]}:</span> {row.note}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{summary.text === 'Not assessed' ? 'Health was not assessed for this journey.' : 'No problems found along this journey.'}</p>
        )}
      </PanelBody>
    </Panel>
  )
}

/** The stored Change Intelligence headline, when the previous audit has been interpreted. */
function SinceLastAudit({ audit }: { audit: AuditDetail }) {
  const query = useQuery({ ...changesQuery(audit.id), enabled: isFinished(audit.status) && audit.previousAuditId !== null })
  const intelligence = query.data?.intelligence
  if (!intelligence) return null
  return (
    <Panel>
      <PanelHeader title="Since the previous audit" actions={<TabLink auditId={audit.id} tab="history">What changed</TabLink>} />
      <PanelBody>
        <p className="text-sm font-medium text-foreground" dir="auto">
          {intelligence.analysis.headline}
        </p>
        {intelligence.analysis.summary ? (
          <p className="mt-1 line-clamp-3 text-sm text-muted" dir="auto">
            {intelligence.analysis.summary}
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  )
}

function FeaturedVisuals({ audit, visuals }: { audit: AuditDetail; visuals: Artifact[] }) {
  const byRef = new Map(visuals.map((a) => [a.ref, a]))
  const planned = (audit.reportPlan?.featuredArtifactRefs ?? [])
    .map((ref) => byRef.get(ref))
    .filter((a): a is Artifact => Boolean(a))
  const featured = (planned.length ? planned : visuals.filter((a) => a.placement === 'overview')).slice(0, 2)
  if (!featured.length) return null
  return (
    <section aria-label="Featured visuals" className="flex flex-col gap-2">
      {featured.map((artifact) => (
        <AppArtifact key={artifact.id} artifact={artifact} auditId={audit.id} />
      ))}
      {visuals.length > featured.length ? (
        <div className="flex justify-end">
          <TabLink auditId={audit.id} tab="visuals">
            All {visuals.length} visuals
          </TabLink>
        </div>
      ) : null}
    </section>
  )
}

function TopOpportunities({ audit, onOpenFinding }: { audit: AuditDetail; onOpenFinding: (ref: string) => void }) {
  const [showAll, setShowAll] = useState(false)
  const opportunities = audit.summary?.opportunities ?? []
  if (!opportunities.length) return null
  const order = audit.reportPlan?.topOpportunityTitles ?? []
  const ranked = order.length
    ? [
        ...order
          .map((title) => opportunities.find((o) => o.title === title))
          .filter((o): o is StoredOpportunity => Boolean(o)),
        ...opportunities.filter((o) => !order.includes(o.title)),
      ]
    : opportunities
  const shown = showAll ? ranked : ranked.slice(0, 3)
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Top opportunities"
        description="Work this audit exposes, by expected value"
        actions={
          ranked.length > 3 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? 'Show fewer' : `All ${ranked.length}`}
            </Button>
          ) : null
        }
      />
      <ul>
        {shown.map((opportunity, index) => (
          <li key={`${opportunity.title}-${index}`} className="flex gap-3 border-b border-border px-4 py-3 last:border-b-0">
            <Briefcase className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-sm font-medium text-foreground">{opportunity.title}</span>
                <LevelText level={opportunity.impact} kind="impact" />
                <LevelText level={opportunity.effort} kind="effort" />
              </div>
              <p className="mt-0.5 line-clamp-2 text-sm text-muted">{opportunityText(opportunity)}</p>
              {opportunity.relatedFindingIds.length ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-2xs text-subtle">Findings</span>
                  <RefButtons refs={opportunity.relatedFindingIds} onOpen={onOpenFinding} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function LimitationsPanel({ audit }: { audit: AuditDetail }) {
  const limitations = audit.summary?.limitations ?? []
  if (!limitations.length) return null
  const legacy = limitations.filter((item): item is string => typeof item === 'string')
  const typed = limitations.filter((item): item is LimitationItem => typeof item !== 'string')
  const groups = LIMITATION_GROUPS.map((group) => ({
    ...group,
    items: typed.filter((item) => item.kind === group.kind).map((item) => item.text),
  })).filter((group) => group.items.length)
  if (legacy.length) groups.push({ kind: 'could-not-verify', label: 'Notes', hint: '', items: legacy })
  return (
    <Panel>
      <PanelHeader title="Limitations & unknowns" description="What this audit could not establish" />
      <PanelBody className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.label}>
            <SectionLabel>
              {group.label}
              {group.hint ? <span className="ml-1.5 font-normal tracking-normal normal-case">{group.hint}</span> : null}
            </SectionLabel>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted marker:text-subtle">
              {group.items.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        ))}
      </PanelBody>
    </Panel>
  )
}

/** Deterministic baseline numbers, shown when no visual covers them (older audits, baseline-only). */
function BaselinePanel({ audit }: { audit: AuditDetail }) {
  const baseline = audit.baseline
  if (!baseline) {
    return (
      <Panel>
        <PanelHeader title="Key measurements" />
        <EmptyState compact title={isTerminal(audit.status) ? 'No baseline data' : 'Baseline running…'} />
      </Panel>
    )
  }
  const lh = baseline.lighthouse
  return (
    <Panel>
      <PanelHeader
        title="Key measurements"
        description={
          lh
            ? `Lighthouse ${lh.formFactor} · ${urlPath(lh.url)} · lab data`
            : 'Deterministic measurements — leads, not conclusions'
        }
      />
      <PanelBody className="flex flex-col gap-4">
        {lh ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-3 sm:grid-cols-6">
            <Metric label="Performance" value={formatScore(lh.performance)} tone={scoreTone(lh.performance)} />
            <Metric label="LCP" value={formatMs(lh.lcpMs)} tone={thresholdTone(lh.lcpMs, 2500, 4000)} />
            <Metric
              label="CLS"
              value={lh.cls === null ? '—' : lh.cls.toFixed(3)}
              tone={thresholdTone(lh.cls, 0.1, 0.25)}
            />
            <Metric label="TBT" value={formatMs(lh.tbtMs)} tone={thresholdTone(lh.tbtMs, 200, 600)} />
            <Metric
              label="Page weight"
              value={formatBytes(lh.totalBytes)}
              tone={thresholdTone(lh.totalBytes, 1_600_000, 4_000_000)}
            />
            <Metric label="Accessibility" value={formatScore(lh.accessibility)} tone={scoreTone(lh.accessibility)} />
          </div>
        ) : (
          <p className="text-sm text-subtle">Lighthouse did not run (see coverage).</p>
        )}
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border pt-3 sm:grid-cols-4">
          <Metric label="Broken links" value={baseline.brokenLinks} tone={countTone(baseline.brokenLinks)} />
          <Metric label="Console errors" value={baseline.consoleErrors} tone={countTone(baseline.consoleErrors)} />
          <Metric
            label="Network failures"
            value={baseline.networkFailures}
            tone={countTone(baseline.networkFailures)}
          />
          <Metric
            label="A11y violations"
            value={baseline.accessibilityViolations}
            tone={countTone(baseline.accessibilityViolations, 'high')}
          />
        </div>
      </PanelBody>
    </Panel>
  )
}

/** Shown instead of the executive take + risks when the AI has produced nothing (yet). */
function NoAiOutputPanel({ audit }: { audit: AuditDetail }) {
  const terminal = isTerminal(audit.status)
  return (
    <Panel>
      <EmptyState
        icon={terminal ? FileSearch : Bot}
        title={
          terminal
            ? audit.aiEnabled
              ? 'No AI findings for this audit'
              : 'Baseline-only audit'
            : 'Summary and findings are written at finalization'
        }
        description={
          terminal
            ? 'Everything the baseline measured is preserved as evidence.'
            : 'Follow the auditor live in the Activity tab. Evidence is browsable as soon as it is recorded.'
        }
        action={
          <Link
            to="/audits/$auditId"
            params={{ auditId: audit.id }}
            search={{ tab: terminal ? 'evidence' : 'activity' }}
            className={buttonVariants({ size: 'sm' })}
          >
            {terminal ? 'Browse evidence' : 'Open activity'}
            <ArrowRight />
          </Link>
        }
      />
    </Panel>
  )
}

/* ------------------------------------------------------------------------------------------------
 * Side column
 * ---------------------------------------------------------------------------------------------- */

function SeverityPanel({ audit }: { audit: AuditDetail }) {
  const total = SEVERITIES.reduce((sum, s) => sum + audit.severityCounts[s], 0)
  const categories = Object.entries(audit.categoryCounts).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...categories.map(([, count]) => count))
  return (
    <Panel>
      <PanelHeader
        title="Severity"
        actions={<span className="font-mono text-xs text-muted tabular-nums">{pluralize(total, 'finding')}</span>}
      />
      <PanelBody className="flex flex-col gap-3">
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-hover" aria-hidden>
          {total
            ? SEVERITIES.map((severity) =>
                audit.severityCounts[severity] ? (
                  <span
                    key={severity}
                    className={cn(
                      'h-full',
                      { critical: 'bg-critical', high: 'bg-high', medium: 'bg-medium', low: 'bg-low', info: 'bg-info' }[
                        severity
                      ],
                    )}
                    style={{ width: `${(audit.severityCounts[severity] / total) * 100}%` }}
                  />
                ) : null,
              )
            : null}
        </div>
        <dl className="grid grid-cols-5 gap-1">
          {SEVERITIES.map((severity) => (
            <div key={severity} className="min-w-0">
              <dt className="truncate text-xs text-muted">{SEVERITY_LABEL[severity]}</dt>
              <dd className="mt-0.5 flex items-center gap-1.5">
                <Dot tone={audit.severityCounts[severity] ? SEVERITY_TONE[severity] : 'neutral'} />
                <span
                  className={cn(
                    'font-mono text-lg font-medium tabular-nums',
                    audit.severityCounts[severity] ? 'text-foreground' : 'text-subtle',
                  )}
                >
                  {audit.severityCounts[severity]}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        {categories.length ? (
          <div className="border-t border-border pt-3">
            <SectionLabel>By category</SectionLabel>
            <ul className="flex flex-col">
              {categories.map(([category, count]) => (
                <li key={category} className="grid grid-cols-[minmax(0,8.5rem)_1fr_1.5rem] items-center gap-3 py-0.5 text-sm">
                  <span className="truncate text-foreground">{category}</span>
                  <span className="h-1 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
                    <span className="block h-full rounded-full bg-border-strong" style={{ width: `${(count / max) * 100}%` }} />
                  </span>
                  <span className="text-right font-mono text-xs text-muted tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  )
}

function BusinessPanel({ audit }: { audit: AuditDetail }) {
  const business = audit.summary?.businessUnderstanding
  if (!business) return null
  const items: { label: ReactNode; value: ReactNode }[] = [{ label: 'Type', value: business.businessType }]
  if (business.businessModel) items.push({ label: 'Model', value: business.businessModel })
  items.push({ label: 'Primary conversion', value: business.primaryConversion })
  if (business.secondaryConversions.length)
    items.push({ label: 'Secondary', value: business.secondaryConversions.join(' · ') })
  if (business.acquisitionSignals?.length)
    items.push({ label: 'Acquisition signals', value: business.acquisitionSignals.join(' · ') })
  items.push({ label: 'Likely customers', value: <span className="line-clamp-4">{business.likelyCustomers}</span> })
  return (
    <Panel>
      <PanelHeader
        title="Business at a glance"
        description="Inferred from the public website"
        actions={
          <Tooltip content="How certain the auditor is about this business understanding">
            <span tabIndex={0} className="outline-none">
              <Confidence value={business.confidence} />
            </span>
          </Tooltip>
        }
      />
      <PanelBody className="flex flex-col gap-3">
        <DefinitionList items={items} layout="stacked" />
        {business.assumptions.length ? (
          <details className="group text-sm">
            <summary className="cursor-pointer text-xs text-muted select-none hover:text-foreground">
              {pluralize(business.assumptions.length, 'assumption')} not directly proven
            </summary>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-sm text-muted marker:text-subtle">
              {business.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <EvidenceLinks auditId={audit.id} refs={business.evidenceIds} />
      </PanelBody>
    </Panel>
  )
}

function CoveragePanel({ audit }: { audit: AuditDetail }) {
  const items = audit.coverage
  const ran = items.filter((item) => item.status === 'ran').length
  return (
    <Panel>
      <PanelHeader
        title="Coverage"
        description="What ran in this audit — nothing is silently omitted"
        actions={
          items.length ? (
            <span className="font-mono text-xs text-muted tabular-nums">
              {ran}/{items.filter((item) => item.status !== 'not-applicable').length}
            </span>
          ) : null
        }
      />
      {items.length === 0 ? (
        <EmptyState compact title={isTerminal(audit.status) ? 'Coverage unavailable' : 'Known when the audit finishes'} />
      ) : (
        <ul className="py-1.5">
          {items.map((item) => (
            <li key={item.capability} className="flex gap-2.5 px-4 py-1">
              <CoverageIcon status={item.status} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn('truncate text-sm', item.status === 'ran' ? 'text-foreground' : 'text-muted')}>
                    {item.label}
                  </span>
                  {item.status !== 'ran' ? (
                    <span className="shrink-0 text-2xs text-subtle">{COVERAGE_STATUS[item.status].label}</span>
                  ) : null}
                </div>
                {item.status !== 'ran' && item.reason ? (
                  <p className="text-xs text-muted text-break">{item.reason}</p>
                ) : item.detail ? (
                  <p className="truncate text-xs text-subtle" title={item.detail}>
                    {item.detail}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function TechnologiesPanel({ audit }: { audit: AuditDetail }) {
  const technologies = audit.summary?.technologies ?? []
  const hints = audit.baseline?.technologyHints ?? []
  if (!technologies.length && !hints.length) return null
  return (
    <Panel>
      <PanelHeader
        title="Technologies"
        description={technologies.length ? 'Identified by the auditor' : 'Signals from the baseline'}
      />
      <PanelBody className="py-2">
        {technologies.length ? (
          <ul className="divide-y divide-border">
            {technologies.map((tech) => (
              <li key={`${tech.name}-${tech.category}`} className="flex items-center gap-3 py-1.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-foreground" title={tech.name}>
                    {tech.name}
                  </div>
                  <div className="text-xs text-subtle">{tech.category}</div>
                </div>
                <Confidence value={tech.confidence} showBar={false} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-wrap gap-1 py-1">
            {hints.map((hint) => (
              <span key={hint} className={tagVariants({ kind: 'label' })}>
                {hint}
              </span>
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}

/* ------------------------------------------------------------------------------------------------
 * Overview
 * ---------------------------------------------------------------------------------------------- */

export function OverviewTab({
  audit,
  findings,
  visuals,
  visualsLoading = false,
  presenting,
  onOpenFinding,
}: {
  audit: AuditDetail
  findings: FindingItem[]
  visuals: Artifact[]
  visualsLoading?: boolean
  presenting: boolean
  onOpenFinding: (ref: string) => void
}) {
  const hasAiOutput = Boolean(audit.summary?.executiveSummary) || findings.length > 0
  const hasFeatured =
    visuals.some((a) => a.placement === 'overview') ||
    (audit.reportPlan?.featuredArtifactRefs ?? []).some((ref) => visuals.some((a) => a.ref === ref))
  // Desktop: two independent columns. Mobile: the column wrappers dissolve (display: contents) and
  // `order` interleaves them so the most important panels come first.
  return (
    <div className="flex flex-col gap-4">
      <StatusNotice audit={audit} />
      <PresentNotice audit={audit} findings={findings} presenting={presenting} />
      <KpiStrip audit={audit} findings={findings} />
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
          {hasAiOutput ? (
            <>
              {audit.summary?.executiveSummary ? (
                <div className="order-1 lg:order-none">
                  <ExecutiveTake audit={audit} />
                </div>
              ) : null}
              {findings.length ? (
                <div className="order-2 flex flex-col gap-4 lg:order-none">
                  <TopRisks audit={audit} findings={findings} onOpenFinding={onOpenFinding} />
                  <PrimaryJourney audit={audit} />
                  <SinceLastAudit audit={audit} />
                </div>
              ) : audit.findingCount ? (
                <div className="order-2 lg:order-none">
                  <Panel className="overflow-hidden">
                    <PanelHeader title="What matters most" />
                    <LoadingState rows={4} />
                  </Panel>
                </div>
              ) : null}
            </>
          ) : (
            <div className="order-1 lg:order-none">
              <NoAiOutputPanel audit={audit} />
            </div>
          )}
          <div className="order-4 empty:hidden lg:order-none">
            {hasFeatured ? (
              <FeaturedVisuals audit={audit} visuals={visuals} />
            ) : visualsLoading && audit.artifactCount > 0 ? (
              <Panel>
                <LoadingState rows={3} />
              </Panel>
            ) : (
              <BaselinePanel audit={audit} />
            )}
          </div>
          <div className="order-5 empty:hidden lg:order-none">
            <TopOpportunities audit={audit} onOpenFinding={onOpenFinding} />
          </div>
          <div className="order-9 empty:hidden lg:order-none">
            <LimitationsPanel audit={audit} />
          </div>
        </div>
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
          {findings.length || audit.findingCount ? (
            <div className="order-3 lg:order-none">
              <SeverityPanel audit={audit} />
            </div>
          ) : null}
          <div className="order-6 empty:hidden lg:order-none">
            <BusinessPanel audit={audit} />
          </div>
          <div className="order-7 lg:order-none">
            <CoveragePanel audit={audit} />
          </div>
          <div className="order-8 empty:hidden lg:order-none">
            <TechnologiesPanel audit={audit} />
          </div>
        </div>
      </div>
    </div>
  )
}
