import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Dropdown menu built on Base UI (keyboard navigation, typeahead and focus return included).
 * `trigger` must be a single element that can hold a ref, typically a <Button>.
 */
export function Menu({
  trigger,
  children,
  align = 'end',
  className,
}: {
  trigger: ReactElement<Record<string, unknown>>
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-50 outline-none" sideOffset={4} align={align}>
          <BaseMenu.Popup
            className={cn(
              'max-h-(--available-height) min-w-52 origin-(--transform-origin) overflow-y-auto rounded-md border border-border bg-surface p-1 text-sm text-foreground shadow-popover outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0',
              className,
            )}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

const itemClass =
  'flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none select-none data-disabled:cursor-default data-disabled:opacity-55 data-highlighted:bg-surface-hover [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-subtle'

export function MenuItem({
  onClick,
  disabled,
  icon,
  children,
  hint,
  label,
}: {
  onClick?: () => void
  disabled?: boolean
  icon?: ReactNode
  children: ReactNode
  /** Secondary line (file name, or why the item is unavailable). */
  hint?: ReactNode
  /** Text used for typeahead when `children` is not plain text. */
  label?: string
}) {
  return (
    <BaseMenu.Item className={itemClass} onClick={onClick} disabled={disabled} label={label}>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block whitespace-nowrap">{children}</span>
        {hint ? <span className="block truncate text-2xs text-muted">{hint}</span> : null}
      </span>
    </BaseMenu.Item>
  )
}

export function MenuLinkItem({
  href,
  icon,
  children,
  hint,
  external,
}: {
  href: string
  icon?: ReactNode
  children: ReactNode
  hint?: ReactNode
  external?: boolean
}) {
  return (
    <BaseMenu.LinkItem
      className={itemClass}
      href={href}
      closeOnClick
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block whitespace-nowrap">{children}</span>
        {hint ? <span className="block truncate text-2xs text-muted">{hint}</span> : null}
      </span>
    </BaseMenu.LinkItem>
  )
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="mx-1 my-1 h-px bg-border" />
}

export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wide text-subtle uppercase">
        {label}
      </BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  )
}
