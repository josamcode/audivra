import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ChoiceOption<T extends string> {
  value: T
  label: string
  description: string
}

/** Single choice between a few options that each need a sentence of explanation (radio group). */
export function ChoiceList<T extends string>({
  value,
  onValueChange,
  options,
  label,
  invalid = false,
  className,
}: {
  value: T | null
  onValueChange: (value: T) => void
  options: readonly ChoiceOption<T>[]
  label: string
  invalid?: boolean
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-invalid={invalid || undefined} className={cn('grid gap-2 sm:grid-cols-3', className)}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'flex cursor-pointer flex-col gap-0.5 rounded-md border bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-hover',
              active ? 'border-foreground bg-surface-selected' : invalid ? 'border-critical' : 'border-border',
            )}
          >
            <span className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
              {option.label}
              {active ? <Check className="size-3.5 shrink-0" /> : null}
            </span>
            <span className="text-xs text-muted">{option.description}</span>
          </button>
        )
      })}
    </div>
  )
}
