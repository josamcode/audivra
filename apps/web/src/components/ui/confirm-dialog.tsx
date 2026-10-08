import { AlertDialog } from '@base-ui/react/alert-dialog'
import type { ReactElement, ReactNode } from 'react'
import { Button } from './button'

/**
 * Confirmation for actions with real cost or side effects (e.g. running the benchmark, which audits
 * fixture sites with the AI). `trigger` must be a single element that can hold a ref.
 */
export function ConfirmDialog({
  trigger,
  title,
  children,
  confirmLabel,
  dismissLabel = 'Cancel',
  onConfirm,
}: {
  trigger: ReactElement<Record<string, unknown>>
  title: string
  children: ReactNode
  confirmLabel: string
  /** Label of the button that closes the dialog without acting. */
  dismissLabel?: string
  onConfirm: () => void
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={trigger} />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-overlay outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <AlertDialog.Title className="text-lg font-semibold text-foreground">{title}</AlertDialog.Title>
          <AlertDialog.Description render={<div />} className="mt-2 text-sm leading-relaxed text-muted">
            {children}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close render={<Button size="sm" />}>{dismissLabel}</AlertDialog.Close>
            <AlertDialog.Close render={<Button size="sm" variant="primary" onClick={onConfirm} />}>
              {confirmLabel}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
