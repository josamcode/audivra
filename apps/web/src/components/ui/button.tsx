import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary:
          'border border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-hover',
        ghost: 'text-muted hover:bg-surface-hover hover:text-foreground',
        danger: 'border border-border bg-surface text-critical hover:border-critical hover:bg-critical-soft',
      },
      size: {
        sm: 'h-7 px-2.5 text-sm',
        md: 'h-8 px-3 text-sm',
        icon: 'size-8',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
