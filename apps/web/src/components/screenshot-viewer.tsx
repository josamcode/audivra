import { ExternalLink, ImageOff, Maximize2, ScrollText } from 'lucide-react'
import { useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Modal } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/**
 * Screenshot preview at a useful working size (never upscaled), with a full-size modal that
 * scrolls at natural resolution, an optional full-page capture, and a link to the original file.
 */
export function ScreenshotViewer({
  src,
  alt,
  title,
  fullPageSrc,
  className,
  maxHeightClass = 'max-h-120',
}: {
  src: string
  alt: string
  title?: string
  /** Optional full-page capture of the same view. */
  fullPageSrc?: string | null
  className?: string
  maxHeightClass?: string
}) {
  const [open, setOpen] = useState<'shot' | 'page' | null>(null)
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted',
          className,
        )}
      >
        <ImageOff className="size-4" />
        Screenshot file is not available.
      </div>
    )
  }

  const modalSrc = open === 'page' && fullPageSrc ? fullPageSrc : src
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <button
        type="button"
        onClick={() => setOpen('shot')}
        className="group relative block w-full cursor-zoom-in overflow-hidden rounded-md border border-border bg-surface-muted"
        aria-label={`Open ${alt} at full size`}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          // Scale the whole capture into the preview box (tall mobile captures included) instead of cropping it.
          className={cn('mx-auto block h-auto w-auto max-w-full object-contain', maxHeightClass)}
        />
        <span className="absolute top-2 right-2 flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-2xs text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Maximize2 className="size-3" />
          Full size
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setOpen('shot')}>
          <Maximize2 />
          View full size
        </Button>
        {fullPageSrc ? (
          <Button size="sm" onClick={() => setOpen('page')}>
            <ScrollText />
            View full page
          </Button>
        ) : null}
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: 'sm', variant: 'ghost' })}
        >
          <ExternalLink />
          Original
        </a>
      </div>
      <Modal
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null)
        }}
        title={title ?? alt}
        description={open === 'page' ? 'Full-page capture' : undefined}
        actions={
          <a
            href={modalSrc}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: 'sm', variant: 'ghost' })}
          >
            <ExternalLink />
            Original
          </a>
        }
      >
        <div className="bg-surface-muted p-4">
          <img src={modalSrc} alt={alt} className="mx-auto block h-auto max-w-full" />
        </div>
      </Modal>
    </div>
  )
}
