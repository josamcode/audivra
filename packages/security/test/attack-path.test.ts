import { describe, expect, it } from 'vitest'
import type { EdgeVerificationState, SecurityFinding, SecurityGraphEdge, SecurityGraphNode } from '@audivra/contracts'
import {
  attackPathKey,
  buildAiChain,
  dedupeAndDominate,
  discoverPaths,
  findingEnablement,
  graphEdgeVerification,
  pathImpactPriority,
  pathVerdict,
  validatePath,
  type AttackPathView,
  type CandidatePath,
} from '../src/index.ts'

/*
 * The Phase 6B attack-path core without a database: condition mapping, deterministic discovery (single
 * findings + real connector chains), bounded + cycle-safe search, independent validation, weakest-edge
 * verification/confidence, stable keys, dedupe/dominance, and that an AI proposal can neither invent entities
 * nor turn a missing connector into a verified step.
 */

const T = '2026-10-14T10:00:00.000Z'
const BOB = 'identity:bob'
const DOC = 'resource:document:doc1'
const ACTION = 'business-action:approve'

function node(kind: SecurityGraphNode['kind'], key: string, label: string): SecurityGraphNode {
  return { id: `gn_${key}`, engagementId: 'e', kind, key, label, attributes: {}, scopeClass: 'in-scope', basis: 'declared', confidence: 1, corroboration: 1, tools: [], status: 'active', statusReason: null, conflicts: [], firstObservedAt: T, lastObservedAt: T, firstExecutionId: null, lastExecutionId: null, updatedAt: T }
}

function edge(type: SecurityGraphEdge['type'], fromKey: string, toKey: string, over: Partial<SecurityGraphEdge> = {}): SecurityGraphEdge {
  return { id: `ge_${type}_${fromKey}_${toKey}`, engagementId: 'e', key: `${type}|${fromKey}|${toKey}`, type, fromId: `gn_${fromKey}`, toId: `gn_${toKey}`, fromKey, toKey, attributes: {}, basis: 'declared', confidence: 1, corroboration: 1, tools: [], status: 'active', statusReason: null, conflicts: [], firstObservedAt: T, lastObservedAt: T, firstExecutionId: null, lastExecutionId: null, updatedAt: T, ...over }
}

function finding(over: Partial<SecurityFinding> & { id: string; category: SecurityFinding['category'] }): SecurityFinding {
  return {
    engagementId: 'e',
    issueKey: `${over.category}:${over.id}`,
    title: `Finding ${over.id}`,
    severity: 'high',
    severityReason: 'r',
    confidence: 0.8,
    verificationState: 'verified',
    status: 'verified',
    affectedEntities: [],
    claim: 'c',
    evidenceRefs: [`EV-${over.id}`],
    contradictingEvidenceRefs: [],
    impact: '',
    remediation: '',
    reproduction: null,
    severityInputs: { category: over.category, scopeClass: 'in-scope', privilegeBoundaryCrossed: false, tenantBoundaryCrossed: false, dataSensitivity: 'unknown', exploitPrerequisites: 'authenticated', confidence: 0.8, environment: 'isolated-lab' },
    confidenceFactors: { directObservation: true, independentCorroboration: true, positiveControl: true, negativeControl: true, deterministicReproduction: true, contradictoryEvidence: false, aiInferenceDependency: false },
    candidateIds: [],
    hypothesisIds: [],
    comparisonIds: [],
    invariantRefs: [],
    reviewed: false,
    reviewNote: null,
    history: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  }
}

const nodes = [node('identity', BOB, 'bob'), node('resource', DOC, 'doc1'), node('business-action', ACTION, 'approve')]

// A: bob reads doc1 (object-boundary) → data access. B: bob invokes approve (business-logic) → state change.
const findingA = finding({ id: 'A', category: 'authorization', affectedEntities: [{ key: BOB, kind: 'identity', label: 'bob' }, { key: DOC, kind: 'resource', label: 'doc1' }], reproduction: { executionIds: ['ex_a'], comparisonId: 'cmp_a', arms: [{ role: 'subject', identityRef: 'bob', sessionRef: null, resourceRef: 'doc1', url: 'u', method: 'GET', responseClass: 'success', status: 200 }], stateBefore: null, stateAfter: null, evidenceRefs: ['EV-A'] } })
const findingB = finding({ id: 'B', category: 'business-logic', affectedEntities: [{ key: BOB, kind: 'identity', label: 'bob' }, { key: ACTION, kind: 'business-action', label: 'approve' }] })

function view(over: { findings?: SecurityFinding[]; edges?: SecurityGraphEdge[] } = {}): AttackPathView {
  const edges = over.edges ?? []
  const edgesByFrom = new Map<string, SecurityGraphEdge[]>()
  for (const e of edges) edgesByFrom.set(e.fromKey, [...(edgesByFrom.get(e.fromKey) ?? []), e])
  return { engagementId: 'e', environment: 'isolated-lab', findings: over.findings ?? [findingA, findingB], nodesByKey: new Map(nodes.map((n) => [n.key, n])), edges, edgesByFrom }
}

describe('condition mapping', () => {
  it('maps a finding to the condition it requires and the impact it reaches', () => {
    const e = findingEnablement(findingA)
    expect(e.principalKey).toBe(BOB)
    expect(e.precondition.kind).toBe('authenticated-identity')
    expect(e.impact).toBe('unauthorized-data-access')
    const b = findingEnablement(findingB)
    expect(b.impact).toBe('unauthorized-state-change')
  })
})

describe('deterministic discovery', () => {
  it('produces a single-finding path for each finding and a same-principal escalation chain', () => {
    const { paths } = discoverPaths(view())
    const single = paths.filter((p) => p.findingIds.length === 1)
    const chains = paths.filter((p) => p.findingIds.length > 1)
    expect(single.length).toBe(2)
    expect(chains.some((c) => c.findingIds[0] === 'A' && c.findingIds[1] === 'B')).toBe(true)
  })

  it('does NOT chain findings with no shared principal and no connecting edge', () => {
    const carolFinding = finding({ id: 'C', category: 'authorization', affectedEntities: [{ key: 'identity:carol', kind: 'identity', label: 'carol' }, { key: 'resource:document:doc9', kind: 'resource', label: 'doc9' }] })
    const { paths } = discoverPaths(view({ findings: [findingA, carolFinding] }))
    expect(paths.every((p) => p.findingIds.length === 1)).toBe(true)
  })

  it('bounds depth and never revisits a finding (cycle-safe)', () => {
    const { paths, stats } = discoverPaths(view(), { maxDepth: 2, maxCandidatePaths: 100, maxExpansions: 500 })
    expect(paths.every((p) => p.findingIds.length <= 2)).toBe(true)
    expect(paths.every((p) => new Set(p.findingIds).size === p.findingIds.length)).toBe(true)
    expect(stats.terminationReason).toBe('complete')
  })
})

describe('weakest-edge verification and confidence', () => {
  const steps = (states: EdgeVerificationState[]) => states.map((s) => ({ edgeVerification: s }))
  it('a verified→verified→inferred path is partially-verified, not verified', () => {
    const v = pathVerdict(steps(['verified', 'verified', 'inferred']))
    expect(v.state).toBe('partially-verified')
    expect(v.confidence).toBeLessThan(0.9)
  })
  it('a missing edge makes a path speculative', () => {
    expect(pathVerdict(steps(['verified', 'missing'])).state).toBe('speculative')
  })
  it('a contradicted step rejects the path', () => {
    expect(pathVerdict(steps(['verified', 'contradicted'])).state).toBe('rejected')
  })
  it('all-verified is verified with high confidence', () => {
    const v = pathVerdict(steps(['verified', 'verified']))
    expect(v.state).toBe('verified')
    expect(v.confidence).toBeGreaterThanOrEqual(0.9)
  })
})

describe('impact priority (separate from finding severity)', () => {
  it('a cross-tenant anonymous path with multiple boundaries ranks critical, a speculative one lower', () => {
    const base: CandidatePath = { start: { kind: 'anonymous', identityRef: null, entityKey: null, label: 'anon' }, end: { impactClass: 'cross-tenant-access', entityKey: null, label: 'x' }, steps: [], findingIds: [], comparisonIds: [], invariantRefs: [], affectedEntityKeys: [], boundariesCrossed: ['tenant', 'role'], impactClass: 'cross-tenant-access', transitions: [], origin: 'deterministic' }
    expect(pathImpactPriority(base, pathVerdict([{ edgeVerification: 'verified' }]))).toBe('critical')
    expect(pathImpactPriority(base, pathVerdict([{ edgeVerification: 'missing' }]))).not.toBe('critical')
  })
})

describe('stable key, dedupe and dominance', () => {
  it('the same route yields the same key; different transitions differ', () => {
    const start = { kind: 'authenticated-identity' as const, identityRef: 'bob', entityKey: BOB, label: 'bob' }
    const end = { impactClass: 'unauthorized-state-change' as const, entityKey: DOC, label: 'x' }
    const k1 = attackPathKey(start, ['unauthorized-data-access', 'unauthorized-state-change'], end, [BOB])
    expect(attackPathKey(start, ['unauthorized-data-access', 'unauthorized-state-change'], end, [BOB])).toBe(k1)
    expect(attackPathKey(start, ['unauthorized-state-change'], end, [BOB])).not.toBe(k1)
  })

  it('marks a single-finding prefix as dominated by the escalation chain', () => {
    const { paths } = discoverPaths(view())
    const keyed = dedupeAndDominate(paths)
    const aAlone = keyed.find((p) => p.findingIds.length === 1 && p.findingIds[0] === 'A')!
    const chain = keyed.find((p) => p.findingIds.length === 2)!
    expect(aAlone.dominatedBy).toBe(chain.pathKey)
  })
})

describe('independent validation', () => {
  it('rejects a path that cites an unknown finding', () => {
    const [p] = discoverPaths(view()).paths
    const tampered: CandidatePath = { ...p!, steps: p!.steps.map((s) => ({ ...s, references: [{ kind: 'finding', ref: 'ghost', label: 'ghost' }] })) }
    expect(validatePath(tampered, view()).ok).toBe(false)
  })

  it('keeps a missing connector as an explicit evidence gap, never silent', () => {
    // Two findings with different principals and no connecting edge, forced into an AI chain.
    const carol = finding({ id: 'C', category: 'authorization', affectedEntities: [{ key: 'identity:carol', kind: 'identity', label: 'carol' }, { key: 'resource:document:doc9', kind: 'resource', label: 'doc9' }] })
    const v = view({ findings: [findingA, carol] })
    const chain = buildAiChain([findingA, carol], [], v)
    expect(chain.ok).toBe(true)
    expect(chain.steps.some((s) => s.edgeVerification === 'missing')).toBe(true)
    const candidate: CandidatePath = { start: findingEnablement(findingA).precondition, end: { impactClass: 'unauthorized-data-access', entityKey: null, label: 'x' }, steps: chain.steps, findingIds: ['A', 'C'], comparisonIds: [], invariantRefs: [], affectedEntityKeys: [], boundariesCrossed: [], impactClass: 'unauthorized-data-access', transitions: [], origin: 'ai-proposed' }
    const validation = validatePath(candidate, v)
    expect(validation.ok).toBe(true)
    expect(validation.missingEvidence.length).toBeGreaterThan(0)
    expect(pathVerdict(chain.steps).state).toBe('speculative') // a missing edge is never verified
  })

  it('an AI proposal citing a nonexistent entity key is rejected', () => {
    expect(buildAiChain([findingA, findingB], ['resource:document:ghost'], view()).ok).toBe(false)
  })
})

describe('graph edge verification', () => {
  it('a declared/observed/derived edge is verified; an inferred one stays inferred; a contradicted one is contradicted', () => {
    expect(graphEdgeVerification(edge('CAN_ACCESS', BOB, DOC, { basis: 'derived' }))).toBe('verified')
    expect(graphEdgeVerification(edge('CAN_ACCESS', BOB, DOC, { basis: 'inferred' }))).toBe('inferred')
    expect(graphEdgeVerification(edge('CAN_ACCESS', BOB, DOC, { status: 'contradicted' }))).toBe('contradicted')
  })

  it('chains two findings across a verified graph edge between their entities', () => {
    // A grants access to doc1; a declared ACTS_ON edge from doc1 to an action B concerns.
    const actionFinding = finding({ id: 'B2', category: 'business-logic', affectedEntities: [{ key: 'identity:carol', kind: 'identity', label: 'carol' }, { key: ACTION, kind: 'business-action', label: 'approve' }] })
    const v = view({ findings: [findingA, actionFinding], edges: [edge('ACTS_ON', DOC, ACTION, { basis: 'declared' })] })
    const { paths } = discoverPaths(v)
    expect(paths.some((p) => p.findingIds.length === 2 && p.findingIds[0] === 'A' && p.findingIds[1] === 'B2')).toBe(true)
  })
})
