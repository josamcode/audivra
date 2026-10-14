import { describe, expect, it } from 'vitest'
import {
  ProposedHypothesis,
  ResearcherOutput,
  PlannerOutput,
  type EvidenceCheck,
  type KnowledgeGap,
  type ProposedAction,
  type ReasoningAction,
  type SecurityGraphEdge,
  type SecurityGraphNode,
  type SecurityHypothesis,
  type SecurityObservation,
} from '@audivra/contracts'
import {
  actionKeyOf,
  assessChecks,
  autoExecutable,
  binaryEntropy,
  createFixtureSensorRegistry,
  hypothesisDedupeKey,
  planningCapabilities,
  rankHypothesis,
  validateAction,
  validateProposal,
  type KnowledgeView,
} from '../src/index.ts'

/*
 * The deterministic reasoning rules without a database: structured-output schemas, hypothesis quality rules
 * and deduplication, evidence checks, ranking (information gain) and action validation. A hand-built
 * knowledge view stands in for the graph.
 */

const ORIGIN = 'http://127.0.0.1:4555'
const T = '2026-10-13T10:00:00.000Z'
const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(14, '0')}`
const registry = createFixtureSensorRegistry({ deepscan: true })

function node(n: number, kind: SecurityGraphNode['kind'], label: string, extra: Partial<SecurityGraphNode> = {}): SecurityGraphNode {
  return {
    id: id('gn', n),
    engagementId: 'eng',
    kind,
    key: `${kind}:${label}`,
    label,
    attributes: {},
    scopeClass: kind === 'technology' ? null : 'in-scope',
    basis: 'observed',
    confidence: 1,
    corroboration: 1,
    tools: ['probe-inspect'],
    status: 'active',
    statusReason: null,
    conflicts: [],
    firstObservedAt: T,
    lastObservedAt: T,
    firstExecutionId: null,
    lastExecutionId: null,
    updatedAt: T,
    ...extra,
  }
}

function edge(n: number, type: SecurityGraphEdge['type'], from: SecurityGraphNode, to: SecurityGraphNode): SecurityGraphEdge {
  return { ...node(900 + n, 'host', 'x'), id: id('ge', n), type, fromId: from.id, toId: to.id, fromKey: from.key, toKey: to.key, key: `${type}|${from.key}|${to.key}` } as unknown as SecurityGraphEdge
}

function observation(n: number, type: SecurityObservation['type'], asset: string, tool: string, value: Record<string, unknown> = {}): SecurityObservation {
  return { id: id('obs', n), engagementId: 'eng', dedupeKey: `${n}`, type, asset, subject: 's', title: `${type} ${n}`, scopeClass: null, value, sourceType: 'tool-reported', confidence: 1, evidenceRefs: [`EV-${n}`], contributions: [{ executionId: `sx_${n}`, capabilityId: 'c', tool, toolVersion: 'v', evidenceRef: `EV-${n}`, confidence: 1, identityRef: null, sessionRef: null, at: T }], firstSeenAt: T, lastSeenAt: T }
}

const host = node(1, 'host', ORIGIN)
const root = node(2, 'endpoint', '/', { attributes: { url: `${ORIGIN}/`, status: 200 } })
const admin = node(3, 'endpoint', '/admin', { attributes: { url: `${ORIGIN}/admin` }, tools: ['katana'] })
const nginx = node(4, 'technology', 'nginx', { attributes: { name: 'nginx' }, confidence: 0.9 })
const external = node(5, 'endpoint', '/out', { attributes: { url: 'http://203.0.113.9/out' }, scopeClass: 'third-party' })
const response = observation(1, 'http-response', `${ORIGIN}/`, 'probe-inspect', { status: 200 })
const tech = observation(2, 'technology', `${ORIGIN}/`, 'probe-inspect')
const link = observation(3, 'endpoint', `${ORIGIN}/admin`, 'katana', { contacted: false })
const gap: KnowledgeGap = { id: id('gg', 1), engagementId: 'eng', kind: 'technology-uncorroborated', subjectType: 'node', subjectId: nginx.id, subjectKey: nginx.key, question: 'Is nginx in use?', status: 'open', resolution: null, resolvedBy: null, answeredBy: ['technology'], firstDetectedAt: T, resolvedAt: null, updatedAt: T }

function view(extra: { hypotheses?: SecurityHypothesis[]; actions?: ReasoningAction[]; environment?: 'production' | 'staging'; nodes?: SecurityGraphNode[]; observations?: SecurityObservation[] } = {}): KnowledgeView {
  const nodes = [host, root, admin, nginx, external, ...(extra.nodes ?? [])]
  const edges = [edge(1, 'HOSTS', host, root), edge(2, 'HOSTS', host, admin), edge(3, 'DEPENDS_ON', host, nginx)]
  const adjacency = new Map<string, SecurityGraphEdge[]>()
  for (const e of edges) for (const nid of [e.fromId, e.toId]) adjacency.set(nid, [...(adjacency.get(nid) ?? []), e])
  const observations = [response, tech, link, ...(extra.observations ?? [])]
  const byNode = new Map<string, Set<string>>([
    [host.id, new Set([response.id, tech.id, link.id])],
    [root.id, new Set([response.id, tech.id])],
    [admin.id, new Set([link.id])],
    [nginx.id, new Set([tech.id])],
  ])
  for (const o of extra.observations ?? []) if (o.type === 'technology') byNode.get(nginx.id)!.add(o.id)
  return {
    engagement: { id: 'eng', environment: extra.environment ?? 'staging', targetUrl: `${ORIGIN}/`, scope: {} as KnowledgeView['engagement']['scope'], configVersion: 1 },
    nodes: new Map(nodes.map((n) => [n.id, n])),
    nodesByKey: new Map(nodes.map((n) => [n.key, n])),
    edges,
    adjacency,
    observationsByNode: byNode,
    observations: new Map(observations.map((o) => [o.id, o])),
    gaps: new Map([[gap.id, gap]]),
    hypotheses: extra.hypotheses ?? [],
    actions: extra.actions ?? [],
    capabilities: planningCapabilities(registry, extra.environment ?? 'staging'),
    comparisons: [],
  }
}

const corroborate: EvidenceCheck[] = [
  { check: 'independent-corroboration', entityId: nginx.id, effect: 'supports' },
  { check: 'entity-contradicted', entityId: nginx.id, effect: 'contradicts' },
]

function proposal(over: Partial<ProposedHypothesis> = {}): ProposedHypothesis {
  return ProposedHypothesis.parse({ claim: 'nginx is in use on the host', category: 'technology', impact: 'medium', confidence: 0.9, subjectEntityIds: [nginx.id], supportingObservationIds: [tech.id], gapIds: [gap.id], evidenceChecks: corroborate, rationale: 'A single fingerprint is weak evidence.', ...over })
}

function hypothesis(over: Partial<SecurityHypothesis> = {}): SecurityHypothesis {
  return {
    id: id('hy', 1),
    engagementId: 'eng',
    dedupeKey: hypothesisDedupeKey([nginx.id]),
    claim: 'nginx is in use',
    category: 'technology',
    status: 'needs-evidence',
    statusReason: '',
    confidence: 0.5,
    impact: 'medium',
    rationale: 'r',
    subjectEntityIds: [nginx.id],
    gapIds: [gap.id],
    supportingObservationIds: [tech.id],
    contradictingObservationIds: [],
    evidenceChecks: corroborate,
    checkResults: [],
    candidateCapabilities: [],
    ranking: null,
    expectedInformationGain: null,
    estimatedCost: null,
    executionRisk: null,
    attempts: 0,
    origin: { kind: 'ai', runId: null, providerId: 'p', model: null, promptVersion: null },
    review: { verdict: 'not-reviewed', note: null, providerId: null },
    history: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  }
}

describe('structured AI output schemas', () => {
  it('are strict: unknown fields, invented id shapes and oversize batches are refused', () => {
    expect(ProposedHypothesis.safeParse({ ...proposal(), command: 'rm -rf /' }).success).toBe(false)
    expect(ProposedHypothesis.safeParse({ ...proposal(), subjectEntityIds: ['../../etc'] }).success).toBe(false)
    expect(ResearcherOutput.safeParse({ hypotheses: Array.from({ length: 9 }, () => proposal()) }).success).toBe(false)
    expect(PlannerOutput.safeParse({ actions: [{ hypothesisId: id('hy', 1), capabilityId: 'discovery.fixture-inspect', input: {}, expectedEvidence: 'x', reason: 'y', image: 'alpine' }] }).success).toBe(false)
  })
})

describe('hypothesis quality rules and deduplication', () => {
  it('accepts a grounded proposal and clamps its confidence to the evidence', () => {
    const verdict = validateProposal(proposal(), view())
    expect(verdict).toMatchObject({ kind: 'accept', confidence: 0.4 })
    expect(verdict.kind === 'accept' && verdict.candidateCapabilities).toEqual(['discovery.fixture-deepscan', 'discovery.fixture-fingerprint'])
  })

  it.each([
    ['unknown-entity', { subjectEntityIds: [id('gn', 99)] }],
    ['unknown-evidence', { supportingObservationIds: [id('obs', 99)] }],
    ['unknown-gap', { gapIds: [id('gg', 99)] }],
    ['unrelated-evidence', { supportingObservationIds: [link.id] }],
    ['unsupported', { supportingObservationIds: [], gapIds: [] }],
    ['claim-outside-graph', { claim: 'nginx serves /internal/debug to anyone' }],
    ['claim-outside-graph', { claim: 'nginx also runs on http://198.51.100.7/' }],
    ['out-of-scope', { subjectEntityIds: [external.id], supportingObservationIds: [], gapIds: [gap.id], evidenceChecks: [{ check: 'response-status', entityId: external.id, statuses: [200], effect: 'supports' }] }],
    ['invalid-check', { evidenceChecks: [{ check: 'entity-contradicted', entityId: nginx.id, effect: 'contradicts' }] }],
    ['invalid-check', { evidenceChecks: [{ check: 'response-status', entityId: nginx.id, statuses: [200], effect: 'supports' }] }],
  ] as const)('rejects %s', (reason, over) => {
    expect(validateProposal(proposal(over as Partial<ProposedHypothesis>), view())).toMatchObject({ kind: 'reject', reason })
  })

  it('does not count host-wide evidence as evidence about an endpoint', () => {
    const p = proposal({ claim: 'The /admin page answers anonymous requests', subjectEntityIds: [admin.id], supportingObservationIds: [response.id], gapIds: [], evidenceChecks: [{ check: 'response-status', entityId: admin.id, statuses: [200], effect: 'supports' }] })
    expect(validateProposal(p, view())).toMatchObject({ kind: 'reject', reason: 'unrelated-evidence' })
    expect(validateProposal({ ...p, supportingObservationIds: [link.id] }, view())).toMatchObject({ kind: 'accept' })
  })

  it('rejects claims that are already established or already contradicted', () => {
    const second = observation(10, 'technology', `${ORIGIN}/`, 'probe-fingerprint')
    expect(validateProposal(proposal(), view({ observations: [second], nodes: [] }))).toMatchObject({ kind: 'accept' })
    const corroborated = view({ observations: [second] })
    corroborated.nodes.set(nginx.id, { ...nginx, tools: ['probe-fingerprint', 'probe-inspect'], corroboration: 2 })
    expect(validateProposal(proposal(), corroborated)).toMatchObject({ kind: 'reject', reason: 'already-established' })
    const contradicted = view()
    contradicted.nodes.set(nginx.id, { ...nginx, status: 'contradicted', conflicts: [{ group: 'web-server@h', reason: 'nginx and apache', with: [], detectedAt: T }] })
    expect(validateProposal(proposal(), contradicted)).toMatchObject({ kind: 'reject', reason: 'already-contradicted' })
  })

  it('rejects a proposal no capability allowed in this environment could investigate', () => {
    const production = view({ environment: 'production' })
    production.capabilities = production.capabilities.map((c) => ({ ...c, eligibleHere: false }))
    expect(validateProposal(proposal(), production)).toMatchObject({ kind: 'reject', reason: 'capability-unavailable' })
  })

  it('merges restatements on deterministic references, never on the model’s word alone', () => {
    const existing = hypothesis()
    expect(hypothesisDedupeKey([nginx.id, root.id])).toBe(hypothesisDedupeKey([root.id, nginx.id, nginx.id]))
    expect(validateProposal(proposal({ claim: 'Possible nginx usage on the host' }), view({ hypotheses: [existing] }))).toMatchObject({ kind: 'duplicate', existing: { id: existing.id } })
    // A "duplicateOf" whose entities do not agree is ignored.
    const other = proposal({ claim: 'The /admin page answers anonymous requests', subjectEntityIds: [admin.id], supportingObservationIds: [link.id], gapIds: [], evidenceChecks: [{ check: 'response-status', entityId: admin.id, statuses: [200], effect: 'supports' }], duplicateOf: existing.id })
    const verdict = validateProposal(other, view({ hypotheses: [existing] }))
    expect(verdict.kind).toBe('accept')
    expect(verdict.kind === 'accept' && verdict.notes.join(' ')).toMatch(/suggested duplicate was ignored/)
    expect(validateProposal(proposal(), view(), [{ dedupeKey: hypothesisDedupeKey([nginx.id]) }])).toMatchObject({ kind: 'reject', reason: 'restated-in-batch' })
  })
})

describe('evidence checks', () => {
  it('decide state from evidence: contradiction disproves, two sensors confirm, one sensor supports', () => {
    expect(assessChecks(corroborate, view()).status).toBeNull()
    const contradicted = view()
    contradicted.nodes.set(nginx.id, { ...nginx, conflicts: [{ group: 'g', reason: 'nginx and apache both reported', with: [], detectedAt: T }] })
    expect(assessChecks(corroborate, contradicted)).toMatchObject({ status: 'disproved', confidence: 0.05 })
    const corroborated = view()
    corroborated.nodes.set(nginx.id, { ...nginx, tools: ['probe-fingerprint', 'probe-inspect'], corroboration: 2 })
    expect(assessChecks(corroborate, corroborated)).toMatchObject({ status: 'confirmed-signal' })
    const status: EvidenceCheck[] = [{ check: 'response-status', entityId: root.id, statuses: [200], effect: 'supports' }]
    expect(assessChecks(status, view())).toMatchObject({ status: 'supported', confidence: 0.75 })
    // A link that was never contacted is not a response.
    expect(assessChecks([{ check: 'response-status', entityId: admin.id, statuses: [200], effect: 'supports' }], view()).status).toBeNull()
  })
})

describe('ranking by expected information gain', () => {
  it('prefers a high-impact, uncertain hypothesis one cheap capability can settle over a well-supported one', () => {
    const a = rankHypothesis(hypothesis({ impact: 'high', confidence: 0.3 }), view(), T)
    const b = rankHypothesis(hypothesis({ impact: 'medium', confidence: 0.85, attempts: 1 }), view(), T)
    expect(a.priority).toBeGreaterThan(b.priority)
    expect(a.expectedInformationGain).toBeGreaterThan(b.expectedInformationGain)
    expect(a.bestCapabilityId).toBe('discovery.fixture-fingerprint')
    expect(a.explanation).toMatch(/expected gain/)
  })

  it('discounts capabilities already tried, and the sensor that already reported the entity', () => {
    const tried: ReasoningAction = { id: id('ra', 1), engagementId: 'eng', runId: 'r', hypothesisId: id('hy', 1), capabilityId: 'discovery.fixture-fingerprint', input: { url: `${ORIGIN}/` }, actionKey: 'k', expectedEvidence: 'e', reason: 'r', status: 'completed', statusReason: null, decision: null, executionId: 'sx', result: null, costClass: 'medium', origin: 'ai', createdAt: T, updatedAt: T }
    const ranking = rankHypothesis(hypothesis({ attempts: 1 }), view({ actions: [tried] }), T)
    expect(ranking.bestCapabilityId).toBe('discovery.fixture-deepscan')
    expect(ranking.factors.failedAttempts).toBe(1)
    // probe-inspect reported nginx: it can never corroborate it and is not the best choice.
    expect(rankHypothesis(hypothesis(), view(), T).bestCapabilityId).not.toBe('discovery.fixture-inspect')
    expect(binaryEntropy(0.5)).toBeCloseTo(1)
    expect(binaryEntropy(0.99)).toBeLessThan(0.1)
  })

  it('has nothing to rank when no capability may run here', () => {
    const v = view()
    v.capabilities = v.capabilities.map((c) => ({ ...c, eligibleHere: false }))
    expect(rankHypothesis(hypothesis(), v, T)).toMatchObject({ priority: 0, bestCapabilityId: null, factors: { environmentEligible: false } })
  })
})

describe('action validation', () => {
  const h = hypothesis()
  const action = (over: Partial<ProposedAction> = {}): ProposedAction => ({ hypothesisId: h.id, capabilityId: 'discovery.fixture-fingerprint', input: { url: `${ORIGIN}/` }, expectedEvidence: 'a second technology report', reason: 'independent sensor', ...over })

  it('accepts a typed action on a related in-scope asset', () => {
    expect(validateAction(action(), view({ hypotheses: [h] }), registry, new Set())).toMatchObject({ kind: 'valid', targets: [`${ORIGIN}/`] })
  })

  it.each([
    ['unknown-hypothesis', { hypothesisId: id('hy', 99) }],
    ['unknown-capability', { capabilityId: 'diagnostic.runtime-check' }],
    ['invalid-input', { input: { url: `${ORIGIN}/`, command: 'curl evil' } }],
    ['unknown-asset', { input: { url: 'http://203.0.113.9/' } }],
    ['unrelated-asset', { input: { url: `${ORIGIN}/admin` } }],
    ['irrelevant-capability', { capabilityId: 'discovery.fixture-inspect' }],
    ['unnecessary-cost', { capabilityId: 'discovery.fixture-deepscan' }],
  ] as const)('rejects %s', (reason, over) => {
    expect(validateAction(action(over as Partial<ProposedAction>), view({ hypotheses: [h] }), registry, new Set())).toMatchObject({ kind: 'reject', reason })
  })

  it('rejects resolved hypotheses, duplicates in a plan, in-flight and already-run actions', () => {
    expect(validateAction(action(), view({ hypotheses: [{ ...h, status: 'confirmed-signal' }] }), registry, new Set())).toMatchObject({ reason: 'hypothesis-resolved' })
    const key = actionKeyOf('discovery.fixture-fingerprint', { url: `${ORIGIN}/` })
    expect(validateAction(action(), view({ hypotheses: [h] }), registry, new Set([key]))).toMatchObject({ reason: 'duplicate-in-plan' })
    const base: ReasoningAction = { id: id('ra', 2), engagementId: 'eng', runId: 'r', hypothesisId: h.id, capabilityId: 'discovery.fixture-fingerprint', input: { url: `${ORIGIN}/` }, actionKey: key, expectedEvidence: 'e', reason: 'r', status: 'queued', statusReason: null, decision: null, executionId: 'sx', result: null, costClass: 'medium', origin: 'ai', createdAt: T, updatedAt: '2026-10-13T11:00:00.000Z' }
    expect(validateAction(action(), view({ hypotheses: [h], actions: [base] }), registry, new Set())).toMatchObject({ reason: 'redundant-in-flight' })
    expect(validateAction(action(), view({ hypotheses: [h], actions: [{ ...base, status: 'completed' }] }), registry, new Set())).toMatchObject({ reason: 'redundant' })
  })

  it('runs automatically only read-only, low-risk, not-high-cost capabilities (passive only in production)', () => {
    const caps = new Map(planningCapabilities(registry, 'staging').map((c) => [c.id, c]))
    expect(autoExecutable(caps.get('discovery.fixture-fingerprint')!, 'staging').ok).toBe(true)
    expect(autoExecutable(caps.get('discovery.fixture-deepscan')!, 'staging')).toMatchObject({ ok: false })
    expect(autoExecutable({ ...caps.get('discovery.fixture-fingerprint')!, riskClass: 'low-impact' }, 'production')).toMatchObject({ ok: false })
    expect(autoExecutable({ ...caps.get('discovery.fixture-fingerprint')!, sideEffect: 'reversible-write' }, 'isolated-lab')).toMatchObject({ ok: false })
  })
})
