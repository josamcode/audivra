import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type MetricTone = 'default' | 'critical' | 'high' | 'medium' | 'low' | 'success' | 'muted'

const toneClass: Record<MetricTone, string> = {
  default: 'text-foreground',
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  success: 'text-success',
  muted: 'text-subtle',
}

/** A compact labelled number. Deliberately small: this is a workbench, not a KPI wall. */
export function Metric({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: MetricTone
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="truncate text-xs text-muted">{label}</div>
      <div className={cn('mt-0.5 font-mono text-lg font-medium tabular-nums', toneClass[tone])}>{value}</div>
      {hint ? <div className="truncate text-xs text-subtle">{hint}</div> : null}
    </div>
  )
}

/** Count cell for dense tables: muted dash for zero, semantic colour otherwise. */
export function CountCell({ value, tone }: { value: number; tone: MetricTone }) {
  if (!value) return <span className="font-mono text-sm text-subtle">–</span>
  return <span className={cn('font-mono text-sm font-medium tabular-nums', toneClass[tone])}>{value}</span>
}
