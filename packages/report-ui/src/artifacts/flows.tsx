/** @jsxRuntime automatic @jsxImportSource react */
import type { ArtifactDataMap } from '@audivra/contracts'
import { clsx } from 'clsx'
import { capitalize, formatDate, shortUrl } from '../format.ts'
import { RefChip } from '../components/primitives.tsx'
import type { RenderContext } from '../types.ts'

const JOURNEY_STATUS: Record<string, string> = {
  ok: 'OK',
  friction: 'Friction',
  blocked: 'Blocked',
  unknown: 'Unverified',
}

const STEP_KIND: Record<string, string> = { page: 'Page', action: 'Action', outcome: 'Outcome' }

export function JourneyView({ data, ctx }: { data: ArtifactDataMap['journey']; ctx: RenderContext }) {
  return (
    <ol className="av-journey">
      {data.steps.map((step, index) => (
        <li key={`${step.label}-${index}`} className={clsx('av-journey-step', `av-step-${step.status}`)}>
          <div className="av-step-head">
            <span className="av-step-index av-num">{index + 1}</span>
            <span className="av-step-kind">{STEP_KIND[step.kind] ?? step.kind}</span>
            <span className={clsx('av-step-status', `av-step-status-${step.status}`)}>{JOURNEY_STATUS[step.status]}</span>
          </div>
          <div className="av-step-label" dir="auto">
            {step.label}
          </div>
          {step.url ? <div className="av-step-url av-mono">{shortUrl(step.url, 40)}</div> : null}
          {step.note ? (
            <div className="av-step-note" dir="auto">
              {step.note}
            </div>
          ) : null}
          {step.evidenceId || step.findingId ? (
            <div className="av-step-refs">
              {step.findingId ? <RefChip value={step.findingId} kind="finding" ctx={ctx} /> : null}
              {step.evidenceId ? <RefChip value={step.evidenceId} kind="evidence" ctx={ctx} /> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

const FRICTION_LABEL: Record<string, string> = { none: 'No friction', low: 'Low friction', medium: 'Medium friction', high: 'High friction' }

/** Steps toward a conversion with their friction. Deliberately no traffic/drop-off numbers. */
export function FunnelView({ data, ctx }: { data: ArtifactDataMap['funnel']; ctx: RenderContext }) {
  return (
    <div className="av-funnel">
      <ol>
        {data.steps.map((step, index) => (
          <li key={`${step.label}-${index}`} className={clsx('av-funnel-step', `av-friction-${step.friction}`)}>
            <span className="av-step-index av-num">{index + 1}</span>
            <div className="av-funnel-main">
              <div className="av-funnel-row">
                <span className="av-step-label" dir="auto">
                  {step.label}
                </span>
                <span className={clsx('av-friction-badge', `av-friction-badge-${step.friction}`)}>
                  {FRICTION_LABEL[step.friction]}
                </span>
              </div>
              {step.note ? (
                <div className="av-step-note" dir="auto">
                  {step.note}
                </div>
              ) : null}
              {step.evidenceId || step.findingId ? (
                <div className="av-step-refs">
                  {step.findingId ? <RefChip value={step.findingId} kind="finding" ctx={ctx} /> : null}
                  {step.evidenceId ? <RefChip value={step.evidenceId} kind="evidence" ctx={ctx} /> : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="av-axis-note">Steps and friction observed during the audit — not traffic or conversion rates.</p>
    </div>
  )
}

export function TimelineView({ data }: { data: ArtifactDataMap['timeline'] }) {
  return (
    <ol className="av-timeline">
      {data.items.map((item, index) => (
        <li key={`${item.label}-${index}`} className={clsx('av-timeline-item', `av-tl-${item.status ?? 'neutral'}`)}>
          <span className="av-tl-dot" aria-hidden />
          <div className="av-tl-body">
            <div className="av-tl-row">
              <span className="av-tl-label" dir="auto">
                {item.label}
              </span>
              {item.at ? <span className="av-tl-at av-num">{formatDate(item.at)}</span> : null}
            </div>
            {item.note ? (
              <div className="av-tl-note" dir="auto">
                {item.note}
              </div>
            ) : null}
            <span className="av-sr">{capitalize(item.kind)}</span>
          </div>
        </li>
      ))}
    </ol>
  )
}
