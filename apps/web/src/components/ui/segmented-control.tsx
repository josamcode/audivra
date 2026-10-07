import type { LucideIcon } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  /** Render the icon only, with the label as tooltip + accessible name. */
  iconOnly?: boolean
}

/** Single-choice toggle group (view switches, filters, theme). */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentOption<T>[]
  label: string
  className?: string
}) {
  return (
    <div
      className={cn('inline-flex items-center rounded-md border border-border bg-surface p-0.5', className)}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => {
        const active = option.value === value
        const Icon = option.icon
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.iconOnly ? option.label : undefined}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'flex h-6 cursor-pointer items-center gap-1.5 rounded-sm text-xs font-medium whitespace-nowrap text-muted transition-colors hover:text-foreground',
              option.iconOnly ? 'w-6 justify-center' : 'px-2',
              active && 'bg-surface-selected text-foreground',
            )}
          >
            {Icon ? <Icon className="size-3.5" /> : null}
            {option.iconOnly ? null : option.label}
          </button>
        )
        return option.iconOnly ? (
          <Tooltip key={option.value} content={option.label}>
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
}
