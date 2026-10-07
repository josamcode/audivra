import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The one bordered container. Panels are never nested inside other panels. */
export function Panel({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className={cn('min-w-0 rounded-lg border border-border bg-surface', className)}>
      {children}
    </section>
  )
}

export function PanelHeader({
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
    <header className={cn('flex min-h-11 items-center gap-3 border-b border-border px-4 py-2', className)}>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  )
}

export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-4', className)}>{children}</div>
}

/** Small uppercase section label used inside drawers and panels. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn('mb-1.5 text-2xs font-semibold tracking-wide text-subtle uppercase', className)}>
      {children}
    </h3>
  )
}

/** Label/value rows for dense facts. */
export function DefinitionList({
  items,
  className,
  layout = 'numeric',
}: {
  items: { label: ReactNode; value: ReactNode }[]
  className?: string
  /**
   * `numeric`: values right-aligned (counts). `text`: label column + left-aligned prose values.
   * `stacked`: label above value, for narrow side panels.
   */
  layout?: 'numeric' | 'text' | 'stacked'
}) {
  return (
    <dl className={cn('divide-y divide-border', className)}>
      {items.map((item, index) =>
        layout === 'stacked' ? (
          <div key={index} className="py-1.5 text-sm first:pt-0 last:pb-0">
            <dt className="text-xs text-muted">{item.label}</dt>
            <dd className="mt-0.5 min-w-0 text-foreground text-break">{item.value}</dd>
          </div>
        ) : layout === 'numeric' ? (
          <div key={index} className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
            <dt className="shrink-0 text-muted">{item.label}</dt>
            <dd className="min-w-0 text-right text-foreground text-break">{item.value}</dd>
          </div>
        ) : (
          <div
            key={index}
            className="grid gap-x-4 gap-y-0.5 py-1.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]"
          >
            <dt className="text-muted">{item.label}</dt>
            <dd className="min-w-0 text-foreground text-break">{item.value}</dd>
          </div>
        ),
      )}
    </dl>
  )
}
