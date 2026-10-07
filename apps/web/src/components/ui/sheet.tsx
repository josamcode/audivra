import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'

interface OverlayProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** Small line above the title (IDs, badges). */
  eyebrow?: ReactNode
  description?: ReactNode
  /** Right-aligned header actions, rendered before the close button. */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

const backdropClass =
  'fixed inset-0 z-40 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0'

function OverlayHeader({
  title,
  eyebrow,
  description,
  actions,
}: Pick<OverlayProps, 'title' | 'eyebrow' | 'description' | 'actions'>) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-5 py-3.5">
      <div className="min-w-0 flex-1">
        {eyebrow ? <div className="mb-1.5 flex flex-wrap items-center gap-1.5">{eyebrow}</div> : null}
        <Dialog.Title className="text-lg font-semibold text-foreground">{title}</Dialog.Title>
        {description ? (
          <Dialog.Description className="mt-0.5 text-sm text-muted">{description}</Dialog.Description>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <Dialog.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
          <X />
        </Dialog.Close>
      </div>
    </div>
  )
}

/** Right-side detail drawer used for inspecting findings and evidence. */
export function Sheet({
  open,
  onOpenChange,
  title,
  eyebrow,
  description,
  actions,
  children,
  className,
}: OverlayProps) {
  // Focus the scrollable body on open: keyboard scrolling works and header buttons don't flash tooltips.
  const bodyRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClass} />
        <Dialog.Popup
          initialFocus={bodyRef}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-surface shadow-overlay outline-none transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full',
            className,
          )}
        >
          <OverlayHeader title={title} eyebrow={eyebrow} description={description} actions={actions} />
          <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            {children}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Centered dialog, used for the full-size screenshot viewer. */
export function Modal({
  open,
  onOpenChange,
  title,
  eyebrow,
  description,
  actions,
  children,
  className,
}: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClass} />
        <Dialog.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface shadow-overlay outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0',
            className,
          )}
        >
          <OverlayHeader title={title} eyebrow={eyebrow} description={description} actions={actions} />
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
