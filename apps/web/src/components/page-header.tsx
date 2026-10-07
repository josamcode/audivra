import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  breadcrumb?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-end gap-x-4 gap-y-3 px-4 pt-5 pb-4 sm:px-6', className)}>
      <div className="min-w-0 flex-1">
        {breadcrumb ? <div className="mb-1 text-xs text-muted">{breadcrumb}</div> : null}
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
