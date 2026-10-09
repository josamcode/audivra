import type { AiProviderStatus, AiSystemStatus, ProviderHealthState } from '@audivra/contracts'
import { Bot } from 'lucide-react'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { cn } from '@/lib/utils'

/*
 * AI providers (Phase 3C): the configured preferred provider, each provider's normalized health, and its
 * capability profile. Read-only; never shows credentials. Security Assessment never crashes because a
 * provider is unavailable — this view just shows the degraded state.
 */

const HEALTH_TONE: Record<ProviderHealthState, string> = {
  ready: 'border-success/40 bg-success/10 text-success',
  unavailable: 'border-border bg-surface text-muted',
  'auth-required': 'border-medium/40 bg-medium/10 text-medium',
  'rate-limited': 'border-medium/40 bg-medium/10 text-medium',
  misconfigured: 'border-critical/40 bg-critical/10 text-critical',
  disabled: 'border-border bg-surface text-subtle',
}

function Feature({ on, label }: { on: boolean; label: string }) {
  return <span className={cn('rounded-sm border px-1.5 py-0.5 text-2xs', on ? 'border-success/40 text-success' : 'border-border text-subtle')}>{label}</span>
}

function ProviderCard({ provider, preferred }: { provider: AiProviderStatus; preferred: boolean }) {
  const { health, capabilities: caps } = provider
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="size-4 text-muted" aria-hidden />
        <span className="text-sm font-medium text-foreground">{health.providerId}</span>
        {preferred ? <span className="rounded-sm border border-border px-1.5 py-0.5 text-2xs text-muted">preferred</span> : null}
        <span className={cn('rounded-sm border px-1.5 py-0.5 text-2xs font-medium', HEALTH_TONE[health.state])}>{health.state}</span>
        {health.version ? <span className="font-mono text-2xs text-subtle">{health.version}</span> : null}
      </div>
      {health.detail ? <p className="mt-1 text-xs text-muted">{health.detail}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Feature on={caps.structuredOutput} label="structured output" />
        <Feature on={caps.toolUse} label="tool use" />
        <Feature on={caps.sessionResume} label="session resume" />
        <Feature on={caps.browserTools} label="browser" />
      </div>
      <p className="mt-2 text-2xs text-subtle">
        context {caps.maxContextTokens ? `${Math.round(caps.maxContextTokens / 1000)}k` : 'n/a'} · effort {caps.effortLevels.join('/')} · tasks {caps.taskTypes.length}
      </p>
    </div>
  )
}

export function AiPanel({ data, isLoading }: { data: AiSystemStatus | undefined; isLoading: boolean }) {
  return (
    <Panel>
      <PanelHeader
        title="AI providers"
        description="Audivra reasons through a provider-independent router. Assessments keep their deterministic results when a provider is unavailable; a policy refusal is recorded distinctly and never rerouted to evade it."
      />
      <PanelBody className="flex flex-col gap-3">
        {!data?.enabled ? <p className="text-xs text-medium">AI is turned off by configuration (AUDIVRA_AI=off). Deterministic sensors and evidence remain available.</p> : null}
        {isLoading ? (
          <p className="text-xs text-muted">Checking providers…</p>
        ) : data?.providers.length ? (
          data.providers.map((p) => <ProviderCard key={p.health.providerId} provider={p} preferred={p.health.providerId === data.preferred} />)
        ) : (
          <p className="text-xs text-muted">No AI providers are registered.</p>
        )}
      </PanelBody>
    </Panel>
  )
}
