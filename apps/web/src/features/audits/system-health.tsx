import type { SystemHealth, SystemStatus, ToolStatus } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { TOOL_STATE } from '@/components/badges'
import { Panel, PanelHeader } from '@/components/panel'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatRelative, pluralize } from '@/lib/format'
import { systemHealthQuery, systemQuery } from '@/lib/queries'

interface HealthRow {
  label: string
  status: string
  tone: BadgeTone
  detail?: string | null
}

/** Round trips slower than this on a local database mean something is wrong with it. */
const SLOW_DB_MS = 250

function engineRow(health: SystemHealth | undefined, failed: boolean, now: number): HealthRow {
  const label = 'Audit engine'
  if (failed) return { label, status: 'Unknown', tone: 'neutral', detail: 'The API did not answer' }
  if (!health || health.engine.state === 'unknown') return { label, status: 'Unknown', tone: 'neutral', detail: 'Worker registry unavailable' }
  const { engine } = health
  if (engine.state === 'stopped') {
    return {
      label,
      status: 'Not running',
      tone: 'critical',
      detail: engine.lastHeartbeatAt ? `Worker last seen ${formatRelative(engine.lastHeartbeatAt, now)}` : 'No worker has started yet',
    }
  }
  return {
    label,
    status: 'Running',
    tone: 'success',
    detail: engine.activeJobs ? `${pluralize(engine.activeJobs, 'stage')} in progress` : `${pluralize(engine.workers, 'worker')} · idle`,
  }
}

function databaseRow(health: SystemHealth | undefined, failed: boolean): HealthRow {
  const label = 'Database'
  if (failed || !health) return { label, status: 'Unknown', tone: 'neutral', detail: failed ? 'The API did not answer' : null }
  if (!health.database.ok) return { label, status: 'Unreachable', tone: 'critical', detail: health.database.error }
  const latency = health.database.latencyMs ?? 0
  return latency > SLOW_DB_MS
    ? { label, status: 'Degraded', tone: 'medium', detail: `${latency} ms round trip` }
    : { label, status: 'Healthy', tone: 'success', detail: `${latency} ms round trip` }
}

function claudeRow(claude: ToolStatus | undefined): HealthRow {
  const label = 'Claude AI'
  if (!claude) return { label, status: 'Unknown', tone: 'neutral' }
  if (claude.state === 'needs-setup' && /log ?in/i.test(claude.detail ?? '')) {
    return { label, status: 'Needs login', tone: 'critical', detail: 'Run `claude auth login`' }
  }
  if (claude.state === 'disabled') return { label, status: 'Disabled', tone: 'neutral', detail: 'Audits run baseline checks only' }
  const config = TOOL_STATE[claude.state]
  return {
    label,
    status: config.label,
    tone: claude.state === 'ready' ? 'success' : claude.state === 'needs-setup' ? 'medium' : 'critical',
    detail: claude.state === 'ready' ? claude.via : claude.detail,
  }
}

/** Everything except the AI runtime: browsers, crawlers, scanners and their prerequisites. */
function toolRows(status: SystemStatus | undefined): HealthRow[] {
  if (!status) return [{ label: 'External tools', status: 'Checking…', tone: 'neutral' }]
  const tools = status.tools.filter((tool) => tool.id !== 'claude')
  const problems = tools.filter((tool) => tool.state === 'unavailable' || tool.state === 'error' || tool.state === 'needs-setup')
  const required = problems.filter((tool) => !tool.optional)
  const ready = tools.filter((tool) => tool.state === 'ready').length
  const disabled = tools.filter((tool) => tool.state === 'disabled').length
  const summary: HealthRow = required.length
    ? { label: 'External tools', status: 'Degraded', tone: 'critical', detail: `${pluralize(required.length, 'required tool')} not ready` }
    : problems.length
      ? { label: 'External tools', status: 'Partly available', tone: 'medium', detail: `${ready} of ${tools.length} ready` }
      : {
          label: 'External tools',
          status: 'Operational',
          tone: 'success',
          detail: `${ready} ready${disabled ? ` · ${disabled} disabled by policy` : ''}`,
        }
  // Name each problem, required tools first.
  const named = [...required, ...problems.filter((tool) => tool.optional)].slice(0, 4).map(
    (tool): HealthRow => ({
      label: tool.name,
      status: TOOL_STATE[tool.state].label,
      tone: !tool.optional || tool.state === 'error' ? 'critical' : 'medium',
      detail: tool.optional ? tool.detail : `Required · ${tool.detail ?? tool.group}`,
    }),
  )
  if (problems.length > named.length) {
    named.push({ label: `${problems.length - named.length} more`, status: 'See System', tone: 'neutral' })
  }
  return [summary, ...named]
}

/** Local runtime state from the worker registry, a database round trip and the tool registry. */
export function SystemHealthPanel({ now }: { now: number }) {
  const health = useQuery(systemHealthQuery())
  const tools = useQuery(systemQuery())
  const rows: HealthRow[] = [
    engineRow(health.data, health.isError, now),
    databaseRow(health.data, health.isError),
    tools.isError ? { label: 'Claude AI', status: 'Unknown', tone: 'neutral' } : claudeRow(tools.data?.tools.find((tool) => tool.id === 'claude')),
    ...(tools.isError ? [{ label: 'External tools', status: 'Unknown', tone: 'neutral' } satisfies HealthRow] : toolRows(tools.data)),
  ]
  const loading = health.isPending && tools.isPending
  return (
    <Panel>
      <PanelHeader
        title="System health"
        actions={
          <Link to="/system" className="text-xs text-link hover:underline">
            View system →
          </Link>
        }
      />
      {loading ? (
        <div className="space-y-3 px-4 py-3" aria-busy="true" aria-label="Loading">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.label} className="flex items-start justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground">{row.label}</div>
                {row.detail ? (
                  <div className="truncate text-xs text-subtle" title={row.detail}>
                    {row.detail.replaceAll('`', '')}
                  </div>
                ) : null}
              </div>
              <Badge tone={row.tone} dot className="mt-px">
                {row.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {tools.data ? (
        <div className="border-t border-border px-4 py-2 text-2xs text-subtle">
          Tools checked {formatRelative(tools.data.checkedAt, now)}
        </div>
      ) : null}
    </Panel>
  )
}
