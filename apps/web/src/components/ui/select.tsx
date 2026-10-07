import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface SelectProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  /** Accessible label (also rendered as a muted prefix inside the trigger). */
  label: string
  className?: string
}

/** Compact single-select built on Base UI. Used for all toolbar filters. */
export function Select<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: SelectProps<T>) {
  return (
    <BaseSelect.Root
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'string') onValueChange(next as T)
      }}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface pr-1.5 pl-2.5 text-sm whitespace-nowrap text-foreground transition-colors select-none hover:border-border-strong hover:bg-surface-hover data-popup-open:border-border-strong',
          className,
        )}
      >
        <span className="text-muted">{label}</span>
        <BaseSelect.Value className="truncate font-medium" />
        <BaseSelect.Icon className="ml-auto flex text-subtle">
          <ChevronsUpDown className="size-3.5" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="z-50 outline-none select-none"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <BaseSelect.Popup className="min-w-(--anchor-width) origin-(--transform-origin) rounded-md border border-border bg-surface p-1 text-sm text-foreground shadow-popover outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <BaseSelect.List className="max-h-(--available-height) overflow-y-auto">
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className="grid cursor-pointer grid-cols-[1rem_1fr] items-center gap-1.5 rounded-sm py-1.5 pr-3 pl-1.5 outline-none data-highlighted:bg-surface-hover"
                >
                  <BaseSelect.ItemIndicator className="col-start-1 flex text-foreground">
                    <Check className="size-3.5" />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText className="col-start-2 whitespace-nowrap">
                    {option.label}
                  </BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
