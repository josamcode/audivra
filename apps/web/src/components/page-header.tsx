import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The one page frame. Every page's header, tab bar and content use these edges, so moving between
 * pages never shifts the layout. Full-width bands (tab bars, the audit header) put it on an inner element.
 */
export const pageFrame = 'mx-auto w-full max-w-screen-2xl px-4 sm:px-6'

/** Main column plus a side rail on wide screens; the rail drops below the main column on narrow ones. */
export const pageColumns =
  'grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start 2xl:grid-cols-[minmax(0,1fr)_22rem]'

export function PageFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(pageFrame, className)}>{children}</div>
}

/** Page title block: the first line of every page sits at the same height (pt-5). */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn(pageFrame, 'flex flex-wrap items-end gap-x-4 gap-y-3 pt-5 pb-4', className)}>
      {/* The minimum width makes the actions wrap below the title on phones instead of squeezing it. */}
      <div className="min-w-60 flex-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** Horizontal control bar above tables (search, filters, counts). */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
}

export function ToolbarSpacer() {
  return <div className="flex-1" />
}
