import type {
  ActivityEvent,
  AuthorizationMethod,
  AuthorizationSubject,
  CreateEngagementInput,
  CredentialMetadata,
  EstablishSessionInput,
  IdentityCoverageItem,
  LifecycleAction,
  SecurityDomainDeclaration,
  SessionEstablishmentResult,
  SessionMetadata,
  UpdateEngagementInput,
  AgentRunItem,
  Artifact,
  AuditBrief,
  AuditChanges,
  AuditJourneys,
  AuditComparison,
  AuditDetail,
  BenchmarkRunItem,
  ClientReport,
  CreateAuditInput,
  Dashboard,
  EvidenceGraph,
  EvidenceItem,
  ExportItem,
  ExportKind,
  FindingItem,
  OwnedProcessItem,
  PageItem,
  ScopeManifestInput,
  ScopeValidationResult,
  SecurityAuthorizationItem,
  SecurityCapabilityMetadata,
  SecurityEngagementDetail,
  SecurityEngagementSummary,
  SecurityEventItem,
  SecurityEvidenceItem,
  SecurityExecutionDetail,
  SecurityExecutionItem,
  AiSystemStatus,
  GraphProjectionResult,
  KnowledgeGap,
  ReasoningAction,
  ReasoningCoverage,
  ReasoningRun,
  SecurityGraphNode,
  SecurityGraphNodeDetail,
  SecurityGraphSummary,
  SecurityHypothesis,
  SecurityHypothesisDetail,
  SecurityObservation,
  StartReasoningInput,
  SensorCoverageItem,
  SiteHistory,
  SystemHealth,
  SystemStatus,
  ToolRunItem,
} from '@audivra/contracts'

/** Counts the Observations overview shows (mirrors SecurityService.observationSummary). */
export interface ObservationSummary {
  total: number
  byType: Record<string, number>
  byScopeClass: Record<string, number>
}

/** One asset with the sensors and observations that converged on it (mirrors SecurityService.correlateByAsset). */
export interface ObservationCorrelation {
  asset: string
  tools: string[]
  types: string[]
  observations: SecurityObservation[]
}

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
const engagementPath = (id: string) => `/api/security/engagements/${encodeURIComponent(id)}`
const executionPath = (id: string) => `/api/security/executions/${encodeURIComponent(id)}`
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const api = {
  systemTools: (refresh = false) => request<SystemStatus>(`/api/system/tools${refresh ? '?refresh=1' : ''}`),
  systemAi: () => request<AiSystemStatus>('/api/system/ai'),
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
  journeys: (id: string) => request<AuditJourneys>(`${auditPath(id)}/journeys`),
  analyzeJourneys: (id: string) => request<{ queued: boolean }>(`${auditPath(id)}/journeys`, { method: 'POST' }),
  graph: (id: string, focus: string, depth: number) =>
    request<EvidenceGraph>(`${auditPath(id)}/graph?focus=${encodeURIComponent(focus)}&depth=${depth}`),
  changes: (id: string) => request<AuditChanges>(`${auditPath(id)}/changes`),
  analyzeChanges: (id: string) => request<{ queued: boolean }>(`${auditPath(id)}/changes`, { method: 'POST' }),
  brief: (id: string) => request<AuditBrief>(`${auditPath(id)}/brief`),
  generateBrief: (id: string) => request<{ queued: boolean }>(`${auditPath(id)}/brief`, { method: 'POST' }),
  benchmarks: () => request<BenchmarkRunItem[]>('/api/benchmarks'),
  runBenchmark: () => request<{ queued: boolean }>('/api/benchmarks', { method: 'POST' }),
  processes: () => request<OwnedProcessItem[]>('/api/system/processes'),
  /*
   * Security engagements: configuration, readiness, and the inspection and cancellation of executions.
   * There is no endpoint that creates or runs an execution (only the capability broker does that).
   */
  engagements: () => request<SecurityEngagementSummary[]>('/api/security/engagements'),
  engagement: (id: string) => request<SecurityEngagementDetail>(engagementPath(id)),
  createEngagement: (input: CreateEngagementInput) => request<SecurityEngagementDetail>('/api/security/engagements', post(input)),
  updateEngagement: (id: string, input: UpdateEngagementInput) =>
    request<SecurityEngagementDetail>(engagementPath(id), { method: 'PATCH', body: JSON.stringify(input) }),
  updateScope: (id: string, manifest: ScopeManifestInput, expectedScopeVersion: number) =>
    request<SecurityEngagementDetail>(`${engagementPath(id)}/scope`, { method: 'PUT', body: JSON.stringify({ manifest, expectedScopeVersion }) }),
  validateScope: (id: string, url: string, manifest?: ScopeManifestInput) =>
    request<ScopeValidationResult>(`${engagementPath(id)}/scope/validate`, post({ url, ...(manifest ? { manifest } : {}) })),
  requestAuthorization: (id: string, method: AuthorizationMethod, subject?: Partial<AuthorizationSubject>) =>
    request<{ authorization: SecurityAuthorizationItem; engagement: SecurityEngagementDetail }>(
      `${engagementPath(id)}/authorizations`,
      post({ method, ...(subject ? { subject } : {}) }),
    ),
  revokeAuthorization: (id: string, authorizationId: string) =>
    request<SecurityEngagementDetail>(`${engagementPath(id)}/authorizations/${encodeURIComponent(authorizationId)}/revoke`, { method: 'POST' }),
  engagementLifecycle: (id: string, action: LifecycleAction) => request<SecurityEngagementDetail>(`${engagementPath(id)}/lifecycle`, post({ action })),
  engagementEvents: (id: string) => request<SecurityEventItem[]>(`${engagementPath(id)}/events`),
  engagementEvidence: (id: string) => request<SecurityEvidenceItem[]>(`${engagementPath(id)}/evidence`),
  engagementObservations: (id: string, filters: { type?: string; scopeClass?: string; family?: string; tool?: string; minConfidence?: number } = {}) => {
    const q = new URLSearchParams()
    if (filters.type) q.set('type', filters.type)
    if (filters.scopeClass) q.set('scopeClass', filters.scopeClass)
    if (filters.family) q.set('family', filters.family)
    if (filters.tool) q.set('tool', filters.tool)
    if (filters.minConfidence !== undefined) q.set('minConfidence', String(filters.minConfidence))
    const query = q.toString()
    return request<SecurityObservation[]>(`${engagementPath(id)}/observations${query ? `?${query}` : ''}`)
  },
  engagementObservationSummary: (id: string) => request<ObservationSummary>(`${engagementPath(id)}/observations/summary`),
  engagementObservationCorrelation: (id: string) => request<ObservationCorrelation[]>(`${engagementPath(id)}/observations/correlate`),
  engagementSensorCoverage: (id: string) => request<SensorCoverageItem[]>(`${engagementPath(id)}/sensor-coverage`),
  securityCapabilities: () => request<SecurityCapabilityMetadata[]>('/api/security/capabilities'),
  engagementExecutions: (id: string) => request<SecurityExecutionItem[]>(`${engagementPath(id)}/executions`),
  execution: (id: string) => request<SecurityExecutionDetail>(executionPath(id)),
  executionEvents: (id: string) => request<SecurityEventItem[]>(`${executionPath(id)}/events`),
  executionEvidence: (id: string) => request<SecurityEvidenceItem[]>(`${executionPath(id)}/evidence`),
  executionObservations: (id: string) => request<SecurityObservation[]>(`${executionPath(id)}/observations`),
  cancelExecution: (id: string) => request<SecurityExecutionDetail>(`${executionPath(id)}/cancel`, { method: 'POST' }),
  /*
   * Phase 4: the Security Graph (bounded reads, deterministic rebuild), hypotheses (read-only) and
   * reasoning runs (start with a mode and budget; cancel). Nothing here runs a capability or a prompt.
   */
  graphSummary: (id: string) => request<SecurityGraphSummary>(`${engagementPath(id)}/graph/summary`),
  graphNodes: (id: string, filters: { kind?: string; status?: string; basis?: string; q?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filters).filter((e): e is [string, string] => !!e[1]))
    const query = q.toString()
    return request<SecurityGraphNode[]>(`${engagementPath(id)}/graph/nodes${query ? `?${query}` : ''}`)
  },
  graphGaps: (id: string, status?: string) => request<KnowledgeGap[]>(`${engagementPath(id)}/graph/gaps${status ? `?status=${status}` : ''}`),
  graphNode: (nodeId: string) => request<SecurityGraphNodeDetail>(`/api/security/graph/nodes/${encodeURIComponent(nodeId)}`),
  rebuildGraph: (id: string) => request<GraphProjectionResult>(`${engagementPath(id)}/graph/project`, { method: 'POST' }),
  hypotheses: (id: string) => request<SecurityHypothesis[]>(`${engagementPath(id)}/hypotheses`),
  hypothesis: (hypothesisId: string) => request<SecurityHypothesisDetail>(`/api/security/hypotheses/${encodeURIComponent(hypothesisId)}`),
  reasoningRuns: (id: string) => request<ReasoningRun[]>(`${engagementPath(id)}/reasoning/runs`),
  startReasoning: (id: string, input: StartReasoningInput) => request<ReasoningRun>(`${engagementPath(id)}/reasoning/runs`, post(input)),
  cancelReasoning: (runId: string) => request<ReasoningRun>(`/api/security/reasoning/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  reasoningActions: (id: string) => request<ReasoningAction[]>(`${engagementPath(id)}/reasoning/actions`),
  reasoningCoverage: (id: string) => request<ReasoningCoverage>(`${engagementPath(id)}/reasoning/coverage`),
  // Identities & sessions (Phase 5). Secrets are never returned — only safe metadata.
  identities: (id: string) => request<SecurityDomainDeclaration[]>(`${engagementPath(id)}/domain/declarations?kind=identity`),
  engagementCredentials: (id: string) => request<CredentialMetadata[]>(`${engagementPath(id)}/credentials`),
  engagementSessions: (id: string) => request<SessionMetadata[]>(`${engagementPath(id)}/sessions`),
  identityCoverage: (id: string) => request<IdentityCoverageItem[]>(`${engagementPath(id)}/identities/coverage`),
  establishSession: (id: string, input: EstablishSessionInput) => request<SessionEstablishmentResult>(`${engagementPath(id)}/sessions/establish`, post(input)),
  revokeSession: (sessionId: string) => request<SessionMetadata>(`/api/security/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST' }),
  /** Link to a file an execution registered as evidence (artifact paths are engagement-relative). */
  executionArtifactUrl: (id: string, artifactPath: string) =>
    `${executionPath(id)}/artifacts/${artifactPath
      .replace(`executions/${id}/`, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
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
