import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { LayoutList, Monitor, Moon, Plus, Server, Sun, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Dot } from '@/components/ui/badge'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { systemQuery } from '@/lib/queries'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

const NAV: { to: '/' | '/audits/new' | '/system'; label: string; icon: LucideIcon; exact?: boolean }[] = [
  { to: '/', label: 'Audits', icon: LayoutList, exact: true },
  { to: '/audits/new', label: 'New audit', icon: Plus },
  { to: '/system', label: 'System', icon: Server },
]

function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" className="size-5 text-foreground" aria-hidden>
        <rect width="32" height="32" rx="7" className="fill-foreground" />
        <path
          d="M9 23 16 8l7 15M11.6 18h8.8"
          fill="none"
          className="stroke-background"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-sm font-semibold tracking-tight text-foreground">Audivra</span>
    </span>
  )
}

function NavItem({ item, compact = false }: { item: (typeof NAV)[number]; compact?: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.exact ?? false }}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground',
        'data-[status=active]:bg-surface-selected data-[status=active]:text-foreground',
        compact && 'px-2.5',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={cn(compact && 'sr-only xs:not-sr-only')}>{item.label}</span>
    </Link>
  )
}

const THEME_OPTIONS: { value: ThemePreference; icon: LucideIcon; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
]

function ThemeSwitcher() {
  const { preference, setPreference } = useTheme()
  return (
    <SegmentedControl
      label="Theme"
      value={preference}
      onValueChange={setPreference}
      options={THEME_OPTIONS.map((option) => ({ ...option, iconOnly: true }))}
      className="bg-transparent"
    />
  )
}

/** Small AI runtime indicator so the user always knows whether audits will include AI. */
function RuntimeStatus() {
  const { data, isError } = useQuery(systemQuery())
  const claude = data?.tools.find((tool) => tool.id === 'claude')
  const ready = data?.tools.filter((tool) => tool.state === 'ready').length ?? 0
  const tone = isError
    ? 'critical'
    : !claude
      ? 'neutral'
      : claude.state === 'ready'
        ? 'success'
        : claude.state === 'disabled'
          ? 'neutral'
          : 'critical'
  const label = isError
    ? 'API unreachable'
    : !claude
      ? 'Checking runtime…'
      : claude.state === 'ready'
        ? 'Claude ready'
        : claude.state === 'disabled'
          ? 'AI disabled'
          : 'Claude unavailable'
  return (
    <Link
      to="/system"
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
    >
      <Dot tone={tone} />
      <span className="truncate">{label}</span>
      {data ? (
        <span className="ml-auto font-mono text-2xs text-subtle tabular-nums">
          {ready}/{data.tools.length}
        </span>
      ) : null}
    </Link>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface-muted md:flex">
        <div className="flex h-12 items-center px-4">
          <Link to="/" aria-label="Audivra home">
            <Logo />
          </Link>
        </div>
        <nav className="flex flex-col gap-0.5 px-2 py-2" aria-label="Main">
          {NAV.map((item) => (
            <NavItem key={item.to} item={item} />
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t border-border p-2">
          <RuntimeStatus />
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs text-subtle">Theme</span>
            <ThemeSwitcher />
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-surface-muted px-3 md:hidden">
        <Link to="/" aria-label="Audivra home" className="mr-1">
          <Logo />
        </Link>
        <nav className="flex flex-1 items-center justify-end gap-0.5" aria-label="Main">
          {NAV.map((item) => (
            <NavItem key={item.to} item={item} compact />
          ))}
        </nav>
        <ThemeSwitcher />
      </header>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
