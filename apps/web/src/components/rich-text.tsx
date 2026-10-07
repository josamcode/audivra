import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Renders AI-written prose. Supports the small Markdown subset models tend to emit — paragraphs,
 * "-"/"*"/"1." lists, **bold** and `code` — as React elements (never as HTML), so stray syntax
 * doesn't leak into the UI.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = []
  for (const [blockIndex, block] of text.split(/\n{2,}/).entries()) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    let paragraph: string[] = []
    let list: { ordered: boolean; items: string[] } | null = null
    const flush = (key: string) => {
      if (paragraph.length) {
        blocks.push(<p key={`${key}p`}>{inline(paragraph.join(' '))}</p>)
        paragraph = []
      }
      if (list) {
        const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>)
        blocks.push(
          list.ordered ? (
            <ol key={`${key}l`} className="list-decimal space-y-1 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={`${key}l`} className="list-disc space-y-1 pl-5">
              {items}
            </ul>
          ),
        )
        list = null
      }
    }
    lines.forEach((line, lineIndex) => {
      const bullet = line.match(/^[-*•]\s+(.*)$/)
      const numbered = line.match(/^\d+[.)]\s+(.*)$/)
      const item = bullet?.[1] ?? numbered?.[1]
      if (item !== undefined) {
        const ordered = Boolean(numbered)
        if (paragraph.length || (list && list.ordered !== ordered)) flush(`${blockIndex}-${lineIndex}`)
        list ??= { ordered, items: [] }
        list.items.push(item)
      } else {
        if (list) flush(`${blockIndex}-${lineIndex}`)
        paragraph.push(line.replace(/^#{1,6}\s+/, ''))
      }
    })
    flush(`${blockIndex}-end`)
  }
  return <div className={cn('flex flex-col gap-3', className)}>{blocks}</div>
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, index) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return (
        <strong key={index} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (/^`[^`]+`$/.test(part)) {
      return (
        <code key={index} className="rounded-sm bg-surface-muted px-1 font-mono text-xs">
          {part.slice(1, -1)}
        </code>
      )
    }
    return <Fragment key={index}>{part}</Fragment>
  })
}
