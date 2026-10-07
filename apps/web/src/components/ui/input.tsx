import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const inputClassName =
  'h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2.5 text-sm text-foreground transition-colors placeholder:text-subtle hover:border-border-strong focus-visible:border-ring focus-visible:outline-none aria-invalid:border-critical disabled:opacity-50'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Leading icon rendered inside the field. */
  icon?: ReactNode
}

export function Input({ className, icon, ...props }: InputProps) {
  if (!icon) return <input className={cn(inputClassName, className)} {...props} />
  return (
    <div className={cn('relative w-full min-w-0', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-subtle [&_svg]:size-3.5">
        {icon}
      </span>
      <input className={cn(inputClassName, 'pl-8')} {...props} />
    </div>
  )
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />
}
