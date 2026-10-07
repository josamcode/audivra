import { AlertOctagon, RotateCw, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-8' : 'px-6 py-16',
        className,
      )}
    >
      {Icon ? (
        <div className="mb-3 flex size-9 items-center justify-center rounded-md border border-border text-subtle">
          <Icon className="size-4" />
        </div>
      ) : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** Skeleton rows sized like real content so the layout does not jump when data arrives. */
export function LoadingState({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-y divide-border', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-4 px-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className={cn('h-3', i % 3 === 0 ? 'w-2/5' : i % 3 === 1 ? 'w-1/3' : 'w-1/2')} />
          <Skeleton className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  )
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  onRetry,
  className,
}: {
  title?: string
  error?: unknown
  onRetry?: () => void
  className?: string
}) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
      role="alert"
    >
      <div className="mb-3 flex size-9 items-center justify-center rounded-md border border-border text-critical">
        <AlertOctagon className="size-4" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {message ? <p className="mt-1 max-w-md text-sm text-muted text-break">{message}</p> : null}
      {onRetry ? (
        <Button className="mt-4" size="sm" onClick={onRetry}>
          <RotateCw />
          Try again
        </Button>
      ) : null}
    </div>
  )
}

/** Inline notice for partial/failed states inside a page (not a toast). */
export function Notice({
  tone = 'neutral',
  icon: Icon,
  title,
  children,
  action,
  className,
  iconClassName,
}: {
  tone?: 'neutral' | 'warning' | 'critical'
  icon?: LucideIcon
  iconClassName?: string
  title: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const toneClass = {
    neutral: 'border-border bg-surface-muted',
    warning: 'border-border bg-medium-soft',
    critical: 'border-border bg-critical-soft',
  }[tone]
  const iconClass = { neutral: 'text-muted', warning: 'text-medium', critical: 'text-critical' }[tone]
  return (
    <div className={cn('flex items-start gap-3 rounded-md border px-3.5 py-3', toneClass, className)}>
      {Icon ? <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass, iconClassName)} /> : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {children ? <div className="mt-0.5 text-sm text-muted text-break">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
