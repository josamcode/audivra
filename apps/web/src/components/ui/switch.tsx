import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { cn } from '@/lib/utils'

/** On/off toggle with a visible label (Base UI: role="switch", keyboard and form support included). */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  className,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  /** Muted trailing text, e.g. a count. */
  hint?: string
  className?: string
}) {
  return (
    <label
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm whitespace-nowrap text-muted transition-colors select-none hover:bg-surface-hover hover:text-foreground',
        className,
      )}
    >
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        aria-label={label}
        className="inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-surface-hover p-px transition-colors data-checked:border-foreground data-checked:bg-foreground"
      >
        <BaseSwitch.Thumb className="size-3 rounded-full bg-muted transition-transform data-checked:translate-x-3 data-checked:bg-background" />
      </BaseSwitch.Root>
      <span className={cn(checked && 'text-foreground')}>{label}</span>
      {hint ? <span className="font-mono text-xs text-subtle tabular-nums">{hint}</span> : null}
    </label>
  )
}
