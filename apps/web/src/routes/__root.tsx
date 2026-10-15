import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'
import { Toaster } from 'sonner'
import { AppShell } from '@/components/app-shell'
import { EmptyState, ErrorState } from '@/components/states'
import { buttonVariants } from '@/components/ui/button'
import { useTheme } from '@/lib/theme'

export interface RouterContext {
  queryClient: QueryClient
}

function ThemedToaster() {
  const { resolved } = useTheme()
  return (
    <Toaster
      className="print:hidden"
      theme={resolved}
      position="bottom-right"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-start gap-2.5 rounded-md border border-border bg-surface px-3.5 py-3 text-sm text-foreground shadow-popover',
          title: 'font-medium',
          description: 'mt-0.5 text-xs text-muted',
          icon: 'mt-0.5',
          error: '[&_[data-icon]]:text-critical',
          success: '[&_[data-icon]]:text-success',
        },
      }}
    />
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppShell>
      <Outlet />
      <ThemedToaster />
    </AppShell>
  ),
  notFoundComponent: () => (
    <EmptyState
      icon={FileQuestion}
      title="Page not found"
      description="The page you are looking for does not exist."
      action={
        <Link to="/audits" className={buttonVariants({ size: 'sm' })}>
          Back to audits
        </Link>
      }
    />
  ),
  errorComponent: ({ error, reset }) => (
    <AppShell>
      <ErrorState title="This page failed to load" error={error} onRetry={reset} />
    </AppShell>
  ),
})
