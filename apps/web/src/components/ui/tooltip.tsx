import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export const TooltipProvider = BaseTooltip.Provider

/** Hover/focus hint. `children` must be a single element that can hold a ref. */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode
  children: ReactElement<Record<string, unknown>>
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  if (!content) return children
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup className="max-w-xs rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground shadow-popover transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
