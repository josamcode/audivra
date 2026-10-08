import type { LifecycleAction, SecurityEngagementDetail } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { ChevronDown, CirclePause, CirclePlay, CircleStop, Flag, Power } from 'lucide-react'
import { ENGAGEMENT_STATUS_LABEL, ENVIRONMENT_LABEL, ReadinessBadge } from '@/components/badges'
import { pageFrame } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/menu'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useEngagementMutation } from './use-engagement-mutation'

const ACTIONS: { action: LifecycleAction; label: string; hint: string; icon: typeof Power; when: SecurityEngagementDetail['status'][] }[] = [
  { action: 'activate', label: 'Activate', hint: 'Marks the engagement active. No tests run in this version.', icon: Power, when: ['ready'] },
  { action: 'pause', label: 'Pause', hint: 'Every capability request is denied while paused.', icon: CirclePause, when: ['active'] },
  { action: 'resume', label: 'Resume', hint: 'Requires the engagement to be ready again.', icon: CirclePlay, when: ['paused'] },
  { action: 'complete', label: 'Mark completed', hint: 'Closes the engagement; it can no longer change.', icon: Flag, when: ['active', 'paused'] },
]

export function EngagementHeader({ engagement }: { engagement: SecurityEngagementDetail }) {
  const lifecycle = useEngagementMutation(engagement.id, (action: LifecycleAction) => api.engagementLifecycle(engagement.id, action), {
    success: (next) => `Engagement ${ENGAGEMENT_STATUS_LABEL[next.status].toLowerCase()}`,
    error: 'Could not change the engagement',
  })
  const closed = engagement.status === 'completed' || engagement.status === 'cancelled'
  const available = ACTIONS.filter((a) => a.when.includes(engagement.status))

  return (
    <header className="bg-surface">
      <div className={cn(pageFrame, 'pt-5 pb-4')}>
        <div className="mb-1 text-xs text-muted">
          <Link to="/security" className="hover:text-foreground">
            Security assessments
          </Link>
          <span className="px-1.5 text-subtle">/</span>
          <span className="font-mono">{engagement.id}</span>
        </div>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-60 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{engagement.name}</h1>
              <ReadinessBadge state={engagement.readiness.state} />
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted">
              <span className="truncate font-mono text-xs">{engagement.targetUrl}</span>
              <span className="text-subtle">·</span>
              <span>{engagement.environment ? ENVIRONMENT_LABEL[engagement.environment] : 'Environment not set'}</span>
              <span className="text-subtle">·</span>
              <span>{ENGAGEMENT_STATUS_LABEL[engagement.status]}</span>
              <span className="text-subtle">·</span>
              <span className="font-mono text-xs" title="Configuration version: increases with every change to environment, scope, policy or authorization">
                config v{engagement.configVersion}
              </span>
            </div>
          </div>
          {!closed ? (
            <Menu
              trigger={
                <Button size="sm" disabled={lifecycle.isPending}>
                  Lifecycle
                  <ChevronDown />
                </Button>
              }
            >
              {available.map((item) => (
                <MenuItem key={item.action} icon={<item.icon />} hint={item.hint} onClick={() => lifecycle.mutate(item.action)}>
                  {item.label}
                </MenuItem>
              ))}
              {available.length ? <MenuSeparator /> : null}
              <MenuItem icon={<CircleStop />} hint="Closes the engagement for good." onClick={() => lifecycle.mutate('cancel')}>
                Cancel engagement
              </MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
    </header>
  )
}
