import { Link } from '@tanstack/react-router'
import { Presentation, SquareChartGantt } from 'lucide-react'
import { cn } from '@/lib/utils'

const item =
  'flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-xs font-medium whitespace-nowrap text-muted transition-colors hover:text-foreground'

/**
 * Internal | Client switch. Internal is the working view (runs, evidence, reviewer mechanics); Client
 * is the presentation of the same audit without internals, rendered like the PDF/HTML report.
 */
export function ViewToggle({ auditId, active }: { auditId: string; active: 'internal' | 'client' }) {
  return (
    <nav aria-label="Audit view" className="inline-flex items-center rounded-md border border-border bg-surface p-0.5">
      <Link
        to="/audits/$auditId"
        params={{ auditId }}
        aria-current={active === 'internal' ? 'page' : undefined}
        className={cn(item, active === 'internal' && 'bg-surface-selected text-foreground')}
      >
        <SquareChartGantt className="size-3.5" />
        Internal
      </Link>
      <Link
        to="/audits/$auditId/client"
        params={{ auditId }}
        aria-current={active === 'client' ? 'page' : undefined}
        className={cn(item, active === 'client' && 'bg-surface-selected text-foreground')}
      >
        <Presentation className="size-3.5" />
        Client
      </Link>
    </nav>
  )
}
