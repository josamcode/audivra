import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { isTerminalExecutionStatus, type AuditDetail, type AuditStatus } from '@audivra/contracts'
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
  /** Prefix of everything derived from the audit list; invalidated whenever an audit changes state. */
  audits: ['audits'] as const,
  dashboard: (includeBenchmarks: boolean) => ['audits', 'dashboard', includeBenchmarks ? 'with-benchmarks' : 'normal'] as const,
  system: ['system', 'tools'] as const,
  systemAi: ['system', 'ai'] as const,
  health: ['system', 'health'] as const,
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
  journeys: (id: string) => ['audit', id, 'journeys'] as const,
  graph: (id: string, focus: string, depth: number) => ['audit', id, 'graph', focus, depth] as const,
  changes: (id: string) => ['audit', id, 'changes'] as const,
  brief: (id: string) => ['audit', id, 'brief'] as const,
  siteHistory: (siteKey: string) => ['site', siteKey, 'history'] as const,
  benchmarks: ['benchmarks'] as const,
  processes: ['system', 'processes'] as const,
  engagements: ['security', 'engagements'] as const,
  engagement: (id: string) => ['security', 'engagement', id] as const,
  engagementEvents: (id: string) => ['security', 'engagement', id, 'events'] as const,
  engagementEvidence: (id: string) => ['security', 'engagement', id, 'evidence'] as const,
  engagementObservations: (id: string, type?: string, scopeClass?: string, family?: string) => ['security', 'engagement', id, 'observations', type ?? 'all', scopeClass ?? 'all', family ?? 'all'] as const,
  engagementObservationSummary: (id: string) => ['security', 'engagement', id, 'observations', 'summary'] as const,
  engagementObservationCorrelation: (id: string) => ['security', 'engagement', id, 'observations', 'correlate'] as const,
  engagementSensorCoverage: (id: string) => ['security', 'engagement', id, 'sensor-coverage'] as const,
  securityCapabilities: ['security', 'capabilities'] as const,
  engagementExecutions: (id: string) => ['security', 'engagement', id, 'executions'] as const,
  /** Prefix of everything about one execution. */
  execution: (id: string) => ['security', 'execution', id] as const,
  executionEvents: (id: string) => ['security', 'execution', id, 'events'] as const,
  executionEvidence: (id: string) => ['security', 'execution', id, 'evidence'] as const,
  executionObservations: (id: string) => ['security', 'execution', id, 'observations'] as const,
  graphSummary: (id: string) => ['security', 'engagement', id, 'graph', 'summary'] as const,
  graphNodes: (id: string, kind: string, status: string, basis: string, q: string) => ['security', 'engagement', id, 'graph', 'nodes', kind, status, basis, q] as const,
  graphGaps: (id: string) => ['security', 'engagement', id, 'graph', 'gaps'] as const,
  graphNode: (nodeId: string) => ['security', 'graph-node', nodeId] as const,
  hypotheses: (id: string) => ['security', 'engagement', id, 'hypotheses'] as const,
  hypothesis: (hypothesisId: string) => ['security', 'hypothesis', hypothesisId] as const,
  reasoningRuns: (id: string) => ['security', 'engagement', id, 'reasoning', 'runs'] as const,
  reasoningActions: (id: string) => ['security', 'engagement', id, 'reasoning', 'actions'] as const,
  reasoningCoverage: (id: string) => ['security', 'engagement', id, 'reasoning', 'coverage'] as const,
  engagementIdentities: (id: string) => ['security', 'engagement', id, 'identities'] as const,
  engagementCredentials: (id: string) => ['security', 'engagement', id, 'credentials'] as const,
  engagementSessions: (id: string) => ['security', 'engagement', id, 'sessions'] as const,
  engagementIdentityCoverage: (id: string) => ['security', 'engagement', id, 'identity-coverage'] as const,
  engagementComparisons: (id: string) => ['security', 'engagement', id, 'comparisons'] as const,
  engagementComparisonCoverage: (id: string) => ['security', 'engagement', id, 'comparison-coverage'] as const,
  engagementInvariants: (id: string) => ['security', 'engagement', id, 'invariants'] as const,
  securityComparison: (comparisonId: string) => ['security', 'comparison', comparisonId] as const,
  engagementFindings: (id: string) => ['security', 'engagement', id, 'findings'] as const,
  engagementFindingCandidates: (id: string) => ['security', 'engagement', id, 'findings', 'candidates'] as const,
  engagementFindingCoverage: (id: string) => ['security', 'engagement', id, 'findings', 'coverage'] as const,
  securityFinding: (findingId: string) => ['security', 'finding', findingId] as const,
  engagementAttackPaths: (id: string) => ['security', 'engagement', id, 'attack-paths'] as const,
  engagementAttackPathCoverage: (id: string) => ['security', 'engagement', id, 'attack-paths', 'coverage'] as const,
  securityAttackPath: (pathId: string) => ['security', 'attack-path', pathId] as const,
  engagementDeclarations: (id: string) => ['security', 'engagement', id, 'declarations'] as const,
}

export const dashboardQuery = (includeBenchmarks: boolean) =>
  queryOptions({
    queryKey: queryKeys.dashboard(includeBenchmarks),
    queryFn: () => api.dashboard(includeBenchmarks),
    // Keep the current screen while the benchmark toggle loads the other scope.
    placeholderData: keepPreviousData,
    // Only poll while something is in flight; otherwise the home screen is static.
    refetchInterval: (query) => {
      const summary = query.state.data?.summary
      return summary && summary.running + summary.queued + summary.hiddenActive > 0 ? 5000 : false
    },
  })

export const systemQuery = () =>
  queryOptions({ queryKey: queryKeys.system, queryFn: () => api.systemTools(), staleTime: 60_000 })

export const systemAiQuery = () =>
  queryOptions({ queryKey: queryKeys.systemAi, queryFn: () => api.systemAi(), staleTime: 60_000 })

/** Database and audit-engine liveness (cheap: one query and the worker registry). */
export const systemHealthQuery = () =>
  queryOptions({ queryKey: queryKeys.health, queryFn: api.systemHealth, refetchInterval: 30_000 })

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

/** Polls while an intelligence job (journey analysis, change intelligence, client brief) is queued or running. */
const whileRunning = (query: { state: { data?: { status: { running: boolean } } } }) => (query.state.data?.status.running ? 3000 : false)

export const journeysQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.journeys(id), queryFn: () => api.journeys(id), refetchInterval: whileRunning })

export const graphQuery = (id: string, focus: string, depth: number) =>
  queryOptions({ queryKey: queryKeys.graph(id, focus, depth), queryFn: () => api.graph(id, focus, depth), placeholderData: keepPreviousData })

export const changesQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.changes(id), queryFn: () => api.changes(id), refetchInterval: whileRunning })

export const briefQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.brief(id), queryFn: () => api.brief(id), refetchInterval: whileRunning })

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

export const engagementsQuery = () => queryOptions({ queryKey: queryKeys.engagements, queryFn: api.engagements })

export const engagementQuery = (id: string) => queryOptions({ queryKey: queryKeys.engagement(id), queryFn: () => api.engagement(id) })

export const engagementEventsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementEvents(id), queryFn: () => api.engagementEvents(id) })

export const engagementEvidenceQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementEvidence(id), queryFn: () => api.engagementEvidence(id) })

export const engagementObservationsQuery = (id: string, filters: { type?: string; scopeClass?: string; family?: string } = {}) =>
  queryOptions({
    queryKey: queryKeys.engagementObservations(id, filters.type, filters.scopeClass, filters.family),
    queryFn: () => api.engagementObservations(id, filters),
    refetchInterval: EXECUTION_IDLE_POLL_MS,
  })

export const engagementObservationSummaryQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementObservationSummary(id), queryFn: () => api.engagementObservationSummary(id), refetchInterval: EXECUTION_IDLE_POLL_MS })

export const engagementObservationCorrelationQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementObservationCorrelation(id), queryFn: () => api.engagementObservationCorrelation(id), refetchInterval: EXECUTION_IDLE_POLL_MS })

export const engagementSensorCoverageQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementSensorCoverage(id), queryFn: () => api.engagementSensorCoverage(id), refetchInterval: EXECUTION_IDLE_POLL_MS })

export const securityCapabilitiesQuery = () =>
  queryOptions({ queryKey: queryKeys.securityCapabilities, queryFn: api.securityCapabilities, staleTime: Infinity })

/** Executions are short; the views poll quickly while any of them has not reached a final state. */
const EXECUTION_POLL_MS = 1500
/** Executions are created by Audivra (not from the page), so an idle list still looks for new ones. */
const EXECUTION_IDLE_POLL_MS = 10_000

export const engagementExecutionsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.engagementExecutions(id),
    queryFn: () => api.engagementExecutions(id),
    refetchInterval: (query) => (query.state.data?.some((e) => !isTerminalExecutionStatus(e.status)) ? EXECUTION_POLL_MS : EXECUTION_IDLE_POLL_MS),
  })

export const executionQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.execution(id),
    queryFn: () => api.execution(id),
    refetchInterval: (query) => (query.state.data && !isTerminalExecutionStatus(query.state.data.status) ? EXECUTION_POLL_MS : false),
  })

export const executionEventsQuery = (id: string, active: boolean) =>
  queryOptions({ queryKey: queryKeys.executionEvents(id), queryFn: () => api.executionEvents(id), refetchInterval: active ? EXECUTION_POLL_MS : false })

export const executionEvidenceQuery = (id: string, active: boolean) =>
  queryOptions({ queryKey: queryKeys.executionEvidence(id), queryFn: () => api.executionEvidence(id), refetchInterval: active ? EXECUTION_POLL_MS : false })

export const executionObservationsQuery = (id: string, active: boolean) =>
  queryOptions({ queryKey: queryKeys.executionObservations(id), queryFn: () => api.executionObservations(id), refetchInterval: active ? EXECUTION_POLL_MS : false })

// ── Phase 4: Security Graph and reasoning ─────────────────────────────────────────────────────────────

/** Reasoning runs change while the worker drives them; views poll quickly only while one is active. */
const REASONING_ACTIVE_POLL_MS = 2000
const isActiveRun = (status: string) => status === 'queued' || status === 'running' || status === 'waiting'

export const reasoningRunsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.reasoningRuns(id),
    queryFn: () => api.reasoningRuns(id),
    refetchInterval: (query) => (query.state.data?.some((r) => isActiveRun(r.status)) ? REASONING_ACTIVE_POLL_MS : EXECUTION_IDLE_POLL_MS),
  })

/** Everything that changes while a run is active polls at the run's pace. */
const reasoningPace = (active: boolean) => (active ? REASONING_ACTIVE_POLL_MS : EXECUTION_IDLE_POLL_MS)

export const graphSummaryQuery = (id: string, active = false) =>
  queryOptions({ queryKey: queryKeys.graphSummary(id), queryFn: () => api.graphSummary(id), refetchInterval: reasoningPace(active) })

export const graphNodesQuery = (id: string, filters: { kind?: string; status?: string; basis?: string; q?: string }, active = false) =>
  queryOptions({
    queryKey: queryKeys.graphNodes(id, filters.kind ?? 'all', filters.status ?? 'all', filters.basis ?? 'all', filters.q ?? ''),
    queryFn: () => api.graphNodes(id, filters),
    placeholderData: keepPreviousData,
    refetchInterval: reasoningPace(active),
  })

export const graphGapsQuery = (id: string, active = false) => queryOptions({ queryKey: queryKeys.graphGaps(id), queryFn: () => api.graphGaps(id), refetchInterval: reasoningPace(active) })

export const graphNodeQuery = (nodeId: string, active = false) => queryOptions({ queryKey: queryKeys.graphNode(nodeId), queryFn: () => api.graphNode(nodeId), refetchInterval: reasoningPace(active) })

export const hypothesesQuery = (id: string, active = false) => queryOptions({ queryKey: queryKeys.hypotheses(id), queryFn: () => api.hypotheses(id), refetchInterval: reasoningPace(active) })

export const hypothesisQuery = (hypothesisId: string, active = false) =>
  queryOptions({ queryKey: queryKeys.hypothesis(hypothesisId), queryFn: () => api.hypothesis(hypothesisId), refetchInterval: reasoningPace(active) })

export const reasoningCoverageQuery = (id: string, active = false) =>
  queryOptions({ queryKey: queryKeys.reasoningCoverage(id), queryFn: () => api.reasoningCoverage(id), refetchInterval: reasoningPace(active) })

export const engagementIdentitiesQuery = (id: string) => queryOptions({ queryKey: queryKeys.engagementIdentities(id), queryFn: () => api.identities(id) })

export const engagementCredentialsQuery = (id: string) => queryOptions({ queryKey: queryKeys.engagementCredentials(id), queryFn: () => api.engagementCredentials(id) })

export const engagementSessionsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementSessions(id), queryFn: () => api.engagementSessions(id), refetchInterval: 10_000 })

export const engagementIdentityCoverageQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementIdentityCoverage(id), queryFn: () => api.identityCoverage(id), refetchInterval: 10_000 })

export const engagementComparisonsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementComparisons(id), queryFn: () => api.comparisons(id), refetchInterval: 5000 })

export const engagementFindingsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementFindings(id), queryFn: () => api.findingsList(id), refetchInterval: 5000 })

export const engagementFindingCandidatesQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementFindingCandidates(id), queryFn: () => api.findingCandidates(id), refetchInterval: 5000 })

export const engagementFindingCoverageQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementFindingCoverage(id), queryFn: () => api.findingCoverage(id), refetchInterval: 5000 })

export const securityFindingQuery = (findingId: string) =>
  queryOptions({ queryKey: queryKeys.securityFinding(findingId), queryFn: () => api.securityFinding(findingId) })

export const engagementAttackPathsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementAttackPaths(id), queryFn: () => api.attackPaths(id), refetchInterval: 5000 })

export const engagementAttackPathCoverageQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementAttackPathCoverage(id), queryFn: () => api.attackPathCoverage(id), refetchInterval: 5000 })

export const securityAttackPathQuery = (pathId: string) =>
  queryOptions({ queryKey: queryKeys.securityAttackPath(pathId), queryFn: () => api.securityAttackPath(pathId) })

export const engagementComparisonCoverageQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementComparisonCoverage(id), queryFn: () => api.comparisonCoverage(id), refetchInterval: 10_000 })

export const engagementInvariantsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementInvariants(id), queryFn: () => api.comparisonInvariants(id), refetchInterval: 10_000 })

export const securityComparisonQuery = (comparisonId: string) =>
  queryOptions({ queryKey: queryKeys.securityComparison(comparisonId), queryFn: () => api.securityComparison(comparisonId) })

export const engagementDeclarationsQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.engagementDeclarations(id), queryFn: () => api.declarations(id) })

export { isActiveRun }
