import { queryOptions } from '@tanstack/react-query'
import type { AuditDetail, AuditStatus } from '@audivra/contracts'
import { api } from './api'

export const TERMINAL_STATUSES: ReadonlySet<AuditStatus> = new Set([
  'completed',
  'partial',
  'failed',
  'cancelled',
])

export function isTerminal(status: AuditStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Completed or partial: the audit has results that can be reported, compared and exported. */
export function isFinished(status: AuditStatus): boolean {
  return status === 'completed' || status === 'partial'
}

/**
 * True while visuals/report are being (re)generated for an already finished audit. The audit keeps
 * its terminal status, so the live stream is not connected and the caller polls instead.
 */
export function isPresenting(audit: AuditDetail): boolean {
  if (!isTerminal(audit.status)) return false
  const step = audit.steps.find((s) => s.stage === 'presenting')
  return audit.stage === 'presenting' && (step?.status === 'pending' || step?.status === 'running')
}

export const queryKeys = {
  audits: ['audits'] as const,
  system: ['system', 'tools'] as const,
  audit: (id: string) => ['audit', id] as const,
  findings: (id: string) => ['audit', id, 'findings'] as const,
  evidence: (id: string) => ['audit', id, 'evidence'] as const,
  evidenceItem: (id: string, ref: string) => ['audit', id, 'evidence', ref] as const,
  events: (id: string) => ['audit', id, 'events'] as const,
  pages: (id: string) => ['audit', id, 'pages'] as const,
  toolRuns: (id: string) => ['audit', id, 'tool-runs'] as const,
  agentRuns: (id: string) => ['audit', id, 'agent-runs'] as const,
  visuals: (id: string) => ['audit', id, 'visuals'] as const,
  report: (id: string) => ['audit', id, 'report'] as const,
  comparison: (id: string, withId?: string) => ['audit', id, 'comparison', withId ?? 'previous'] as const,
  exports: (id: string) => ['audit', id, 'exports'] as const,
  siteHistory: (siteKey: string) => ['site', siteKey, 'history'] as const,
  benchmarks: ['benchmarks'] as const,
  processes: ['system', 'processes'] as const,
}

export const auditsQuery = () =>
  queryOptions({
    queryKey: queryKeys.audits,
    queryFn: api.listAudits,
    // Only poll while something is in flight; otherwise the list is static.
    refetchInterval: (query) => (query.state.data?.some((audit) => !isTerminal(audit.status)) ? 5000 : false),
  })

export const systemQuery = () =>
  queryOptions({ queryKey: queryKeys.system, queryFn: () => api.systemTools(), staleTime: 60_000 })

export const auditQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.audit(id), queryFn: () => api.getAudit(id) })

export const findingsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.findings(id), queryFn: () => api.findings(id) })

export const evidenceQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.evidence(id), queryFn: () => api.evidence(id) })

export const evidenceItemQuery = (id: string, ref: string) =>
  queryOptions({
    queryKey: queryKeys.evidenceItem(id, ref),
    queryFn: () => api.evidenceItem(id, ref),
    staleTime: Infinity,
  })

export const eventsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.events(id), queryFn: () => api.events(id) })

export const pagesQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.pages(id), queryFn: () => api.pages(id) })

export const toolRunsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.toolRuns(id), queryFn: () => api.toolRuns(id) })

export const agentRunsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.agentRuns(id), queryFn: () => api.agentRuns(id) })

export const visualsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.visuals(id), queryFn: () => api.visuals(id) })

export const reportQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.report(id), queryFn: () => api.report(id) })

export const comparisonQuery = (id: string, withId?: string) =>
  queryOptions({ queryKey: queryKeys.comparison(id, withId), queryFn: () => api.comparison(id, withId) })

export const exportsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.exports(id), queryFn: () => api.exports(id) })

export const siteHistoryQuery = (siteKey: string) =>
  queryOptions({ queryKey: queryKeys.siteHistory(siteKey), queryFn: () => api.siteHistory(siteKey) })

export const benchmarksQuery = () =>
  queryOptions({
    queryKey: queryKeys.benchmarks,
    queryFn: api.benchmarks,
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'running') ? 10_000 : false),
  })

export const processesQuery = () =>
  queryOptions({
    queryKey: queryKeys.processes,
    queryFn: api.processes,
    refetchInterval: (query) => (query.state.data?.some((p) => p.status === 'running') ? 5000 : false),
  })
