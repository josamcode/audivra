import type {
  ActivityEvent,
  AgentRunItem,
  Artifact,
  AuditComparison,
  AuditDetail,
  BenchmarkRunItem,
  ClientReport,
  CreateAuditInput,
  Dashboard,
  EvidenceItem,
  ExportItem,
  ExportKind,
  FindingItem,
  OwnedProcessItem,
  PageItem,
  SiteHistory,
  SystemHealth,
  SystemStatus,
  ToolRunItem,
} from '@audivra/contracts'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
  } catch {
    throw new ApiError('Cannot reach the Audivra API. Is the server running?', 0)
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, response.status)
  }
  return (await response.json()) as T
}

const auditPath = (id: string) => `/api/audits/${encodeURIComponent(id)}`

export const api = {
  systemTools: (refresh = false) => request<SystemStatus>(`/api/system/tools${refresh ? '?refresh=1' : ''}`),
  systemHealth: () => request<SystemHealth>('/api/system/health'),
  dashboard: (includeBenchmarks: boolean) =>
    request<Dashboard>(`/api/dashboard${includeBenchmarks ? '?benchmark=1' : ''}`),
  createAudit: (input: CreateAuditInput) =>
    request<AuditDetail>('/api/audits', { method: 'POST', body: JSON.stringify(input) }),
  getAudit: (id: string) => request<AuditDetail>(auditPath(id)),
  cancelAudit: (id: string) => request<AuditDetail>(`${auditPath(id)}/cancel`, { method: 'POST' }),
  retryAudit: (id: string) => request<AuditDetail>(`${auditPath(id)}/retry`, { method: 'POST' }),
  findings: (id: string) => request<FindingItem[]>(`${auditPath(id)}/findings`),
  evidence: (id: string) => request<EvidenceItem[]>(`${auditPath(id)}/evidence`),
  evidenceItem: (id: string, ref: string) =>
    request<EvidenceItem>(`${auditPath(id)}/evidence/${encodeURIComponent(ref)}`),
  pages: (id: string) => request<PageItem[]>(`${auditPath(id)}/pages`),
  toolRuns: (id: string) => request<ToolRunItem[]>(`${auditPath(id)}/tool-runs`),
  agentRuns: (id: string) => request<AgentRunItem[]>(`${auditPath(id)}/agent-runs`),
  events: (id: string) => request<ActivityEvent[]>(`${auditPath(id)}/events`),
  visuals: (id: string) => request<Artifact[]>(`${auditPath(id)}/visuals`),
  /** Re-runs the presenting stage (artifact planner + report composer) for a finished audit. */
  present: (id: string) => request<{ queued: boolean }>(`${auditPath(id)}/present`, { method: 'POST' }),
  report: (id: string) => request<ClientReport>(`${auditPath(id)}/report`),
  comparison: (id: string, withId?: string) =>
    request<AuditComparison>(
      `${auditPath(id)}/comparison${withId ? `?with=${encodeURIComponent(withId)}` : ''}`,
    ),
  siteHistory: (siteKey: string) => request<SiteHistory>(`/api/sites/${encodeURIComponent(siteKey)}/history`),
  exports: (id: string) => request<ExportItem[]>(`${auditPath(id)}/exports`),
  benchmarks: () => request<BenchmarkRunItem[]>('/api/benchmarks'),
  runBenchmark: () => request<{ queued: boolean }>('/api/benchmarks', { method: 'POST' }),
  processes: () => request<OwnedProcessItem[]>('/api/system/processes'),
}

/** Download URL of an audit export (generated on demand by the API). */
export function exportUrl(auditId: string, kind: ExportKind): string {
  return `${auditPath(auditId)}/export/${kind}`
}

/** PNG/SVG rendering of a visual artifact (A*). */
export function visualFileUrl(auditId: string, ref: string, format: 'png' | 'svg', download = false): string {
  return `${auditPath(auditId)}/visuals/${encodeURIComponent(ref)}.${format}${download ? '?download=1' : ''}`
}

/** URL of a workspace artifact served by the API. */
export function artifactUrl(auditId: string, artifactPath: string, download = false): string {
  const clean = artifactPath.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `${auditPath(auditId)}/artifacts/${clean}${download ? '?download=1' : ''}`
}

export function streamUrl(auditId: string, afterId: number): string {
  return `${auditPath(auditId)}/stream?after=${afterId}`
}
