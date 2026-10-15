import { cn } from '@/lib/utils'

/** The Audivra mark (rounded square with the "A" stroke). Colours come from the two class props. */
export function BrandMark({
  className,
  fillClassName = 'fill-foreground',
  strokeClassName = 'stroke-background',
}: {
  className?: string
  fillClassName?: string
  strokeClassName?: string
}) {
  return (
    <svg viewBox="0 0 32 32" className={cn('shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="7" className={fillClassName} />
      <path
        d="M9 23 16 8l7 15M11.6 18h8.8"
        fill="none"
        className={strokeClassName}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
