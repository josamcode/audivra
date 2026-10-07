import { SEVERITIES, type AuditDetail, type FindingItem } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Bot,
  Briefcase,
  CircleSlash,
  FileSearch,
  Info,
  Loader2,
  TriangleAlert,
} from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Confidence,
  LevelText,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  STAGE_LABELS,
  SeverityBadge,
} from '@/components/badges'
import { Metric, type MetricTone } from '@/components/metric'
import { RichText } from '@/components/rich-text'
import { DefinitionList, Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, Notice } from '@/components/states'
import { Dot, tagVariants } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { formatBytes, formatMs, formatNumber, formatScore, urlPath } from '@/lib/format'
import { isTerminal } from '@/lib/queries'
import { cn } from '@/lib/utils'

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

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <span className="text-sm text-subtle">{empty}</span>
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span key={item} className={tagVariants({ kind: 'label' })}>
          {item}
        </span>
      ))}
    </div>
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
        finalization stages.
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
        Some stages did not complete. See completeness below and the Activity tab.
      </Notice>
    )
  }
  return null
}

function SeverityPanel({ audit }: { audit: AuditDetail }) {
  const total = SEVERITIES.reduce((sum, s) => sum + audit.severityCounts[s], 0)
  return (
    <Panel>
      <PanelHeader
        title="Severity"
        actions={<span className="font-mono text-xs text-muted tabular-nums">{total} findings</span>}
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
                      {
                        critical: 'bg-critical',
                        high: 'bg-high',
                        medium: 'bg-medium',
                        low: 'bg-low',
                        info: 'bg-info',
                      }[severity],
                    )}
                    style={{ width: `${(audit.severityCounts[severity] / total) * 100}%` }}
                  />
                ) : null,
              )
            : null}
        </div>
        <div className="grid grid-cols-5 gap-1">
          {SEVERITIES.map((severity) => (
            <div key={severity} className="min-w-0">
              <div className="text-xs text-muted">{SEVERITY_LABEL[severity]}</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <Dot tone={audit.severityCounts[severity] ? SEVERITY_TONE[severity] : 'neutral'} />
                <span
                  className={cn(
                    'font-mono text-lg font-medium tabular-nums',
                    audit.severityCounts[severity] ? 'text-foreground' : 'text-subtle',
                  )}
                >
                  {audit.severityCounts[severity]}
                </span>
              </div>
            </div>
          ))}
        </div>
      </PanelBody>
    </Panel>
  )
}

function CategoryPanel({ audit }: { audit: AuditDetail }) {
  const entries = Object.entries(audit.categoryCounts).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...entries.map(([, count]) => count))
  return (
    <Panel>
      <PanelHeader title="Categories" />
      <PanelBody className="py-2">
        {entries.length === 0 ? (
          <p className="py-2 text-sm text-subtle">No findings yet.</p>
        ) : (
          <ul className="flex flex-col">
            {entries.map(([category, count]) => (
              <li
                key={category}
                className="grid grid-cols-[minmax(0,9rem)_1fr_2rem] items-center gap-3 py-1 text-sm"
              >
                <span className="truncate text-foreground">{category}</span>
                <span className="h-1 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
                  <span
                    className="block h-full rounded-full bg-border-strong"
                    style={{ width: `${(count / max) * 100}%` }}
                  />
                </span>
                <span className="text-right font-mono text-xs text-muted tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  )
}

function CoveragePanel({ audit }: { audit: AuditDetail }) {
  const baseline = audit.baseline
  const issues = [
    ...audit.steps
      .filter((step) => step.status === 'failed' || step.status === 'skipped')
      .map((step) => ({
        key: `step-${step.stage}`,
        failed: step.status === 'failed',
        label: `${STAGE_LABELS[step.stage]} ${step.status}`,
        reason: step.error?.message ?? step.message ?? null,
      })),
    ...(baseline?.skippedCapabilities ?? []).map((item) => ({
      key: `cap-${item.capability}`,
      failed: false,
      label: item.capability,
      reason: item.reason,
    })),
  ]
  return (
    <Panel>
      <PanelHeader title="Coverage" />
      <PanelBody className="flex flex-col gap-3 py-2">
        <DefinitionList
          items={[
            {
              label: 'Pages discovered',
              value: (
                <span className="font-mono tabular-nums">{formatNumber(baseline?.pagesDiscovered)}</span>
              ),
            },
            {
              label: 'Pages crawled',
              value: <span className="font-mono tabular-nums">{formatNumber(baseline?.pagesCrawled)}</span>,
            },
            {
              label: 'Inspected in browser (baseline)',
              value: (
                <span className="font-mono tabular-nums">
                  {formatNumber(baseline?.pagesInspectedInBrowser)}
                </span>
              ),
            },
            {
              label: 'Inspected by AI',
              value: (
                <span className="font-mono tabular-nums">
                  {formatNumber(audit.summary?.pagesInspected?.length)}
                </span>
              ),
            },
            {
              label: 'Evidence items',
              value: <span className="font-mono tabular-nums">{formatNumber(audit.evidenceCount)}</span>,
            },
          ]}
        />
        <div>
          <SectionLabel>Completeness</SectionLabel>
          {issues.length === 0 ? (
            <p className="text-sm text-muted">
              {isTerminal(audit.status) ? 'All stages and capabilities ran.' : 'Nothing skipped so far.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {issues.map((issue) => (
                <li key={issue.key} className="flex gap-2 text-sm">
                  <Dot tone={issue.failed ? 'critical' : 'neutral'} className="mt-1.5" />
                  <div className="min-w-0">
                    <span className="text-foreground">{issue.label}</span>
                    {issue.reason ? <p className="text-xs text-muted text-break">{issue.reason}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PanelBody>
    </Panel>
  )
}

function BaselinePanel({ audit }: { audit: AuditDetail }) {
  const baseline = audit.baseline
  if (!baseline) {
    return (
      <Panel>
        <PanelHeader title="Baseline facts" />
        <EmptyState compact title={isTerminal(audit.status) ? 'No baseline data' : 'Baseline running…'} />
      </Panel>
    )
  }
  const lh = baseline.lighthouse
  return (
    <Panel>
      <PanelHeader
        title="Baseline facts"
        description={
          lh
            ? `Lighthouse ${lh.formFactor} · ${urlPath(lh.url)}`
            : 'Deterministic measurements — leads, not conclusions'
        }
      />
      <PanelBody className="flex flex-col gap-4">
        {lh ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
            <Metric
              label="Performance"
              value={formatScore(lh.performance)}
              tone={scoreTone(lh.performance)}
            />
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
            <Metric
              label="Accessibility"
              value={formatScore(lh.accessibility)}
              tone={scoreTone(lh.accessibility)}
            />
          </div>
        ) : (
          <p className="text-sm text-subtle">Lighthouse did not run (see completeness).</p>
        )}
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border pt-3">
          <Metric label="Broken links" value={baseline.brokenLinks} tone={countTone(baseline.brokenLinks)} />
          <Metric
            label="Console errors"
            value={baseline.consoleErrors}
            tone={countTone(baseline.consoleErrors)}
          />
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
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <div>
            <SectionLabel>Tracking detected</SectionLabel>
            <Chips items={baseline.trackingDetected} empty="None detected" />
          </div>
          <div>
            <SectionLabel>Languages</SectionLabel>
            <Chips items={baseline.languages} empty="Not declared" />
          </div>
          <div>
            <SectionLabel>Stack hints</SectionLabel>
            <Chips items={baseline.technologyHints} empty="No signals" />
          </div>
        </div>
      </PanelBody>
    </Panel>
  )
}

function SummaryPanel({ audit }: { audit: AuditDetail }) {
  const text = audit.summary?.executiveSummary
  return (
    <Panel>
      <PanelHeader
        title="Executive summary"
        description={text ? 'Written by the finalizer from reviewed findings' : undefined}
      />
      {text ? (
        <PanelBody>
          <RichText text={text} className="text-base leading-relaxed text-foreground" />
        </PanelBody>
      ) : (
        <EmptyState
          compact
          icon={Bot}
          title={
            !audit.aiEnabled
              ? 'No AI summary for baseline-only audits'
              : isTerminal(audit.status)
                ? 'No summary was produced'
                : 'Written when the audit is finalized'
          }
        />
      )}
    </Panel>
  )
}

function StrongestFindings({
  audit,
  findings,
  onOpenFinding,
}: {
  audit: AuditDetail
  findings: FindingItem[]
  onOpenFinding: (ref: string) => void
}) {
  const top = findings.slice(0, 5)
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Strongest findings"
        actions={
          findings.length > top.length ? (
            <Link
              to="/audits/$auditId"
              params={{ auditId: audit.id }}
              search={{ tab: 'findings' }}
              className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
            >
              All {findings.length}
              <ArrowRight className="size-3" />
            </Link>
          ) : null
        }
      />
      {top.length === 0 ? (
        <EmptyState
          compact
          title={isTerminal(audit.status) ? 'No findings' : 'Findings appear after finalization'}
        />
      ) : (
        <ul>
          {top.map((finding) => (
            <li key={finding.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onOpenFinding(finding.ref)}
                className="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
              >
                <SeverityBadge severity={finding.severity} className="mt-px" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">{finding.title}</div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    <span>{finding.category}</span>
                    {finding.affectedUrls[0] ? (
                      <>
                        <span className="text-subtle">·</span>
                        <span className="truncate font-mono">{urlPath(finding.affectedUrls[0])}</span>
                      </>
                    ) : null}
                    <span className="text-subtle">·</span>
                    <span className="shrink-0">{finding.evidenceRefs.length} evidence</span>
                  </div>
                </div>
                <span className="shrink-0 pt-0.5 font-mono text-2xs text-subtle">{finding.ref}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function OpportunitiesPanel({
  audit,
  onOpenFinding,
}: {
  audit: AuditDetail
  onOpenFinding: (ref: string) => void
}) {
  const opportunities = audit.summary?.opportunities ?? []
  if (!opportunities.length) return null
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Opportunities" description="Prioritized work this audit exposes" />
      <ul>
        {opportunities.map((opportunity, index) => (
          <li
            key={`${opportunity.title}-${index}`}
            className="flex gap-3 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Briefcase className="mt-0.5 size-4 shrink-0 text-subtle" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-sm font-medium text-foreground">{opportunity.title}</span>
                <LevelText level={opportunity.impact} kind="impact" />
                <LevelText level={opportunity.effort} kind="effort" />
              </div>
              <p className="mt-0.5 text-sm text-muted">{opportunity.description}</p>
              {opportunity.relatedFindingIds.length ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-2xs text-subtle">Findings</span>
                  {opportunity.relatedFindingIds.map((ref) => (
                    <button
                      key={ref}
                      type="button"
                      onClick={() => onOpenFinding(ref)}
                      className={tagVariants({ kind: 'ref' })}
                    >
                      {ref}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function BusinessPanel({ audit }: { audit: AuditDetail }) {
  const business = audit.summary?.businessUnderstanding
  const pageTypes = audit.summary?.importantPageTypes ?? []
  if (!business) return null
  const items: { label: ReactNode; value: ReactNode }[] = [
    { label: 'Business type', value: business.businessType },
    { label: 'Likely customers', value: business.likelyCustomers },
    { label: 'Primary conversion', value: business.primaryConversion },
  ]
  if (business.secondaryConversions.length)
    items.push({ label: 'Secondary', value: business.secondaryConversions.join(', ') })
  items.push({ label: 'Confidence', value: <Confidence value={business.confidence} /> })
  return (
    <Panel>
      <PanelHeader
        title="Business understanding"
        description="Inferred from the public website — assumptions are listed"
      />
      <PanelBody className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-foreground">{business.summary}</p>
        <DefinitionList items={items} layout="text" />
        {business.assumptions.length ? (
          <div>
            <SectionLabel>Assumptions</SectionLabel>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted marker:text-subtle">
              {business.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {pageTypes.length ? (
          <div>
            <SectionLabel>Important page types</SectionLabel>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {pageTypes.map((pageType) => (
                <li key={pageType.type} className="px-3 py-2">
                  <div className="text-sm font-medium text-foreground">{pageType.type}</div>
                  {pageType.notes ? <p className="text-xs text-muted">{pageType.notes}</p> : null}
                  {pageType.exampleUrls.length ? (
                    <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-2xs text-subtle">
                      {pageType.exampleUrls.slice(0, 4).map((url) => (
                        <span key={url} className="truncate">
                          {urlPath(url)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <EvidenceLinks auditId={audit.id} refs={business.evidenceIds} />
      </PanelBody>
    </Panel>
  )
}

function TechnologiesPanel({ audit }: { audit: AuditDetail }) {
  const technologies = audit.summary?.technologies ?? []
  if (!technologies.length) return null
  return (
    <Panel>
      <PanelHeader title="Technologies" description="Identified by the auditor" />
      <PanelBody className="py-2">
        <ul className="divide-y divide-border">
          {technologies.map((tech) => (
            <li key={`${tech.name}-${tech.category}`} className="flex items-center gap-3 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <span className="text-foreground">{tech.name}</span>
                <span className="ml-1.5 text-xs text-subtle">{tech.category}</span>
              </div>
              <Confidence value={tech.confidence} showBar={false} />
            </li>
          ))}
        </ul>
      </PanelBody>
    </Panel>
  )
}

function LimitationsPanel({ audit }: { audit: AuditDetail }) {
  const limitations = audit.summary?.limitations ?? []
  if (!limitations.length) return null
  return (
    <Panel>
      <PanelHeader title="Limitations & unknowns" />
      <PanelBody>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted marker:text-subtle">
          {limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </PanelBody>
    </Panel>
  )
}

/** Shown instead of empty summary + findings panels when the AI has produced nothing (yet). */
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

export function OverviewTab({
  audit,
  findings,
  onOpenFinding,
}: {
  audit: AuditDetail
  findings: FindingItem[]
  onOpenFinding: (ref: string) => void
}) {
  const hasAiOutput = Boolean(audit.summary?.executiveSummary) || findings.length > 0
  // Desktop: two independent columns. Mobile: the column wrappers dissolve (display: contents)
  // and `order` puts severity right after the summary instead of at the very bottom.
  return (
    <div className="flex flex-col gap-4">
      <StatusNotice audit={audit} />
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
          <div className="order-1 lg:order-none">
            {hasAiOutput ? <SummaryPanel audit={audit} /> : <NoAiOutputPanel audit={audit} />}
          </div>
          {hasAiOutput ? (
            <div className="order-3 lg:order-none">
              <StrongestFindings audit={audit} findings={findings} onOpenFinding={onOpenFinding} />
            </div>
          ) : null}
          <div className="order-5 empty:hidden lg:order-none">
            <OpportunitiesPanel audit={audit} onOpenFinding={onOpenFinding} />
          </div>
          <div className="order-6 empty:hidden lg:order-none">
            <BusinessPanel audit={audit} />
          </div>
          <div className="order-7 empty:hidden lg:order-none">
            <LimitationsPanel audit={audit} />
          </div>
        </div>
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
          <div className="order-2 lg:order-none">
            <SeverityPanel audit={audit} />
          </div>
          {findings.length ? (
            <div className="order-4 lg:order-none">
              <CategoryPanel audit={audit} />
            </div>
          ) : null}
          <div className="order-8 lg:order-none">
            <BaselinePanel audit={audit} />
          </div>
          <div className="order-9 empty:hidden lg:order-none">
            <TechnologiesPanel audit={audit} />
          </div>
          <div className="order-10 lg:order-none">
            <CoveragePanel audit={audit} />
          </div>
        </div>
      </div>
    </div>
  )
}
