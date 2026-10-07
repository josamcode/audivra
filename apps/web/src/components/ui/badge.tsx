import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * The single badge primitive. Tones are semantic only; every status/severity/type badge in the
 * product is a thin wrapper choosing a tone (see components/badges.tsx).
 */
export const badgeVariants = cva(
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-muted text-muted ring-1 ring-border ring-inset',
        critical: 'bg-critical-soft text-critical',
        high: 'bg-high-soft text-high',
        medium: 'bg-medium-soft text-medium',
        low: 'bg-low-soft text-low',
        info: 'bg-info-soft text-info',
        success: 'bg-success-soft text-success',
        running: 'bg-running-soft text-running',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Show a leading status dot in the tone colour. */
  dot?: boolean
}

export function Badge({ className, tone, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  )
}

/** Small colored dot (used in dense lists and counts). */
export function Dot({ tone, className }: { tone: BadgeTone; className?: string }) {
  const color: Record<BadgeTone, string> = {
    neutral: 'bg-subtle',
    critical: 'bg-critical',
    high: 'bg-high',
    medium: 'bg-medium',
    low: 'bg-low',
    info: 'bg-info',
    success: 'bg-success',
    running: 'bg-running',
  }
  return (
    <span className={cn('inline-block size-2 shrink-0 rounded-full', color[tone], className)} aria-hidden />
  )
}

/**
 * Small bordered tags. `label`: plain values (technologies, languages). `code`: mono values
 * (metadata lists). `ref`: clickable evidence/finding references (EV-12, F3).
 */
export const tagVariants = cva(
  'inline-flex max-w-full items-center rounded-sm border border-border text-break',
  {
    variants: {
      kind: {
        label: 'bg-surface-muted px-1.5 py-0.5 text-xs text-foreground',
        code: 'bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-muted',
        ref: 'cursor-pointer px-1 font-mono text-2xs text-muted transition-colors hover:border-border-strong hover:text-foreground',
      },
    },
    defaultVariants: { kind: 'label' },
  },
)
