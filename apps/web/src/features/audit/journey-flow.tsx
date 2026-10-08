import {
  JOURNEY_DIMENSIONS,
  type JourneyDimension,
  type JourneyHealth,
  type JourneyHealthStatus,
  type JourneyItem,
  type JourneyStep,
} from '@audivra/contracts'
import { ChevronRight } from 'lucide-react'
import { CONVERSION_LABEL, JOURNEY_DIMENSION_LABEL, JOURNEY_STEP, JourneyHealthBadge } from '@/components/badges'
import { Badge, tagVariants } from '@/components/ui/badge'
import { urlPath } from '@/lib/format'
import { cn } from '@/lib/utils'

/** A per-audit reference (EV-12, F3) that opens what it points at. */
export function RefChip({ value, onClick, title }: { value: string; onClick?: () => void; title?: string }) {
  if (!onClick) return <span className="font-mono text-2xs text-muted">{value}</span>
  return (
    <button type="button" onClick={onClick} title={title} className={tagVariants({ kind: 'ref' })}>
      {value}
    </button>
  )
}

function StepMarker({ step, index }: { step: JourneyStep; index: number }) {
  const config = JOURNEY_STEP[step.status]
  const Icon = config.icon
  return (
    <span
      className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface"
      title={`${config.label}: ${config.hint}`}
    >
      {step.status === 'ok' ? (
        <span className="text-2xs font-semibold text-muted tabular-nums">{index + 1}</span>
      ) : (
        <Icon className={cn('size-3.5', config.className)} aria-hidden />
      )}
      <span className="sr-only">{config.label}</span>
    </span>
  )
}

/** Ordered steps from entry to conversion, each with what was observed and the evidence for it. */
export function JourneySteps({
  steps,
  onEvidence,
}: {
  steps: JourneyStep[]
  onEvidence?: (ref: string) => void
}) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const config = JOURNEY_STEP[step.status]
        const last = index === steps.length - 1
        return (
          <li key={index} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
            {!last ? <span className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border" aria-hidden /> : null}
            <StepMarker step={step} index={index} />
            <div className={cn('min-w-0', last ? 'pb-0' : 'pb-5')}>
              <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-foreground" dir="auto">
                  {step.label}
                </span>
                {step.status !== 'ok' ? <Badge tone={config.tone}>{config.label}</Badge> : null}
                {step.conversionType ? <Badge tone="neutral">Conversion · {CONVERSION_LABEL[step.conversionType]}</Badge> : null}
              </div>
              {step.url ? (
                <a href={step.url} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs text-link hover:underline">
                  {urlPath(step.url)}
                </a>
              ) : null}
              {step.note ? (
                <p className="mt-1 text-sm text-muted text-break" dir="auto">
                  {step.note}
                </p>
              ) : null}
              {step.action ? (
                <p className="mt-1 text-xs text-subtle" dir="auto">
                  Next: {step.action}
                </p>
              ) : null}
              {step.evidenceIds.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {step.evidenceIds.map((ref) => (
                    <RefChip key={ref} value={ref} onClick={onEvidence ? () => onEvidence(ref) : undefined} title="Open evidence" />
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Compact one-line path ("Homepage › Services › Contact › WhatsApp") with step problems marked. */
export function JourneyPath({ steps, className }: { steps: JourneyStep[]; className?: string }) {
  return (
    <ol className={cn('flex flex-wrap items-center gap-x-1 gap-y-1 text-sm', className)}>
      {steps.map((step, index) => {
        const config = JOURNEY_STEP[step.status]
        const Icon = config.icon
        return (
          <li key={index} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight className="size-3.5 shrink-0 text-subtle" aria-hidden /> : null}
            <span
              className={cn(
                'inline-flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5',
                step.status === 'ok' ? 'text-foreground' : 'bg-surface-muted text-foreground',
              )}
              title={step.status === 'ok' ? step.label : `${config.label}: ${step.note || config.hint}`}
            >
              {step.status !== 'ok' ? <Icon className={cn('size-3.5 shrink-0', config.className)} aria-hidden /> : null}
              <span className="truncate" dir="auto">
                {step.label}
              </span>
              {step.status !== 'ok' ? <span className="sr-only">({config.label})</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export interface HealthRow {
  dimension: JourneyDimension
  status: JourneyHealthStatus
  note: string
  evidenceIds: string[]
  findingIds: string[]
}

/** All seven dimensions in a fixed order; dimensions the audit did not judge read "Not assessed". */
export function journeyHealthRows(health: JourneyHealth[]): HealthRow[] {
  return JOURNEY_DIMENSIONS.map((dimension) => {
    const row = health.find((h) => h.dimension === dimension)
    return row ? { ...row } : { dimension, status: 'not-assessed', note: '', evidenceIds: [], findingIds: [] }
  })
}

const STATUS_ORDER: Record<JourneyHealthStatus, number> = { problem: 0, warning: 1, unknown: 2, healthy: 3, 'not-assessed': 4 }

/** Short health summary for lists: "1 problem · 2 warnings" or "No problems found". */
export function journeySummary(journey: Pick<JourneyItem, 'steps' | 'health'>): { text: string; tone: 'critical' | 'medium' | 'muted' } {
  const blocked = journey.steps.filter((s) => s.status === 'blocked').length
  const friction = journey.steps.filter((s) => s.status === 'friction').length
  const problems = journey.health.filter((h) => h.status === 'problem').length
  const warnings = journey.health.filter((h) => h.status === 'warning').length
  const parts = [
    blocked ? `${blocked} blocked ${blocked === 1 ? 'step' : 'steps'}` : null,
    friction ? `${friction} with friction` : null,
    problems ? `${problems} ${problems === 1 ? 'problem' : 'problems'}` : null,
    warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : null,
  ].filter(Boolean)
  if (!parts.length) {
    const assessed = journey.health.filter((h) => h.status !== 'not-assessed' && h.status !== 'unknown').length
    return { text: assessed ? 'No problems found' : 'Not assessed', tone: 'muted' }
  }
  return { text: parts.join(' · '), tone: blocked || problems ? 'critical' : 'medium' }
}

/** Dimension rows: status, the one-sentence reason and the evidence/findings behind it. */
export function JourneyHealthList({
  health,
  onEvidence,
  onFinding,
}: {
  health: JourneyHealth[]
  onEvidence?: (ref: string) => void
  onFinding?: (ref: string) => void
}) {
  const rows = journeyHealthRows(health).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.dimension} className="grid gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[7.5rem_6.5rem_minmax(0,1fr)]">
          <span className="text-sm font-medium text-foreground">{JOURNEY_DIMENSION_LABEL[row.dimension]}</span>
          <span>
            <JourneyHealthBadge status={row.status} />
          </span>
          <div className="min-w-0">
            <p className={cn('text-sm text-break', row.status === 'not-assessed' ? 'text-subtle' : 'text-muted')} dir="auto">
              {row.note || (row.status === 'not-assessed' ? 'Not judged in this audit.' : 'No explanation recorded.')}
            </p>
            {row.evidenceIds.length || row.findingIds.length ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {row.findingIds.map((ref) => (
                  <RefChip key={ref} value={ref} onClick={onFinding ? () => onFinding(ref) : undefined} title="Open finding" />
                ))}
                {row.evidenceIds.map((ref) => (
                  <RefChip key={ref} value={ref} onClick={onEvidence ? () => onEvidence(ref) : undefined} title="Open evidence" />
                ))}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
