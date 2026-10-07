import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TabItem<T extends string> {
  value: T
  label: string
  count?: number | null
}

interface TabsProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  items: readonly TabItem<T>[]
  children: ReactNode
  className?: string
  /** Classes for the full-width bar behind the tab list. */
  barClassName?: string
  /** Classes for the tab list itself (e.g. a max-width container). */
  listClassName?: string
}

/** Underline tabs. Only the active panel is mounted. */
export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  children,
  className,
  barClassName,
  listClassName,
}: TabsProps<T>) {
  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as T)} className={className}>
      <div className={cn('border-b border-border', barClassName)}>
        <BaseTabs.List className={cn('relative -mb-px flex gap-1 overflow-x-auto', listClassName)}>
          {items.map((item) => (
            <BaseTabs.Tab
              key={item.value}
              value={item.value}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-2 text-sm font-medium whitespace-nowrap text-muted transition-colors outline-none select-none hover:text-foreground focus-visible:text-foreground data-active:border-foreground data-active:text-foreground"
            >
              {item.label}
              {item.count !== undefined && item.count !== null ? (
                <span className="rounded-sm bg-surface-muted px-1 font-mono text-2xs text-muted tabular-nums">
                  {item.count}
                </span>
              ) : null}
            </BaseTabs.Tab>
          ))}
        </BaseTabs.List>
      </div>
      {children}
    </BaseTabs.Root>
  )
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string
  children: ReactNode
  className?: string
}) {
  return (
    <BaseTabs.Panel value={value} className={cn('outline-none', className)}>
      {children}
    </BaseTabs.Panel>
  )
}
