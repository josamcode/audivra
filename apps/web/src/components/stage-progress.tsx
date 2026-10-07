import type { AuditStep } from '@audivra/contracts'
import { STAGE_LABELS, StepIcon } from '@/components/badges'
import { Tooltip } from '@/components/ui/tooltip'
import { durationBetween, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

function stepHint(step: AuditStep, now: number): string {
  const parts = [STAGE_LABELS[step.stage], step.status]
  const duration = durationBetween(step.startedAt, step.finishedAt, now)
  if (duration !== null && step.status !== 'pending') parts.push(formatDuration(duration))
  if (step.error) parts.push(step.error.message)
  else if (step.message) parts.push(step.message)
  return parts.join(' · ')
}

/**
 * Broad stage indicator. Progress is stage-based on purpose: AI investigation time is not
 * predictable, so no percentage is ever shown.
 */
export function StageProgress({ steps, now }: { steps: AuditStep[]; now: number }) {
  const current =
    steps.find((step) => step.status === 'running') ?? steps.find((step) => step.status === 'failed')
  return (
    <div className="min-w-0">
      <ol className="hidden items-center gap-1 md:flex" aria-label="Audit stages">
        {steps.map((step, index) => (
          <li key={step.stage} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <span
                className={cn(
                  'h-px w-4 shrink-0 lg:w-6',
                  step.status === 'pending' ? 'bg-border' : 'bg-border-strong',
                )}
                aria-hidden
              />
            ) : null}
            <Tooltip content={stepHint(step, now)}>
              <span
                tabIndex={0}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs whitespace-nowrap outline-none',
                  step.status === 'running' && 'font-medium text-foreground',
                  step.status === 'failed' && 'font-medium text-critical',
                  step.status === 'completed' && 'text-muted',
                  (step.status === 'pending' || step.status === 'skipped') && 'text-subtle',
                  step.status === 'skipped' && 'line-through decoration-border-strong',
                )}
              >
                <StepIcon status={step.status} className="size-3.5" />
                {STAGE_LABELS[step.stage]}
              </span>
            </Tooltip>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 md:hidden">
        <div className="flex flex-1 gap-0.5" aria-hidden>
          {steps.map((step) => (
            <span
              key={step.stage}
              className={cn(
                'h-1 flex-1 rounded-full',
                step.status === 'completed' && 'bg-success',
                step.status === 'running' && 'animate-pulse bg-running',
                step.status === 'failed' && 'bg-critical',
                (step.status === 'pending' || step.status === 'skipped') && 'bg-border',
              )}
            />
          ))}
        </div>
        <span className="shrink-0 text-xs text-muted">{current ? STAGE_LABELS[current.stage] : null}</span>
      </div>
    </div>
  )
}
