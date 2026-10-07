import { queryOptions } from '@tanstack/react-query'
import type { AuditStatus } from '@audivra/contracts'
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
