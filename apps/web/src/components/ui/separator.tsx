import { cn } from '@/lib/utils'

export function Separator({ className, vertical = false }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn(vertical ? 'h-4 w-px self-center' : 'h-px w-full', 'shrink-0 bg-border', className)}
    />
  )
}

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-surface-muted px-1 font-mono text-2xs text-muted">
      {children}
    </kbd>
  )
}
