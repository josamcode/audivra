import { describe, expect, it } from 'vitest'
import type {
  ComparisonControls,
  ComparisonPlanInput,
  ComparisonResult,
  RetestResult,
  SecurityAttackPath,
  SecurityComparison,
  SecurityFinding,
  SecurityGraphEdge,
  SecurityGraphNode,
  VerificationCheck,
} from '@audivra/contracts'
import {
  applyAdaptation,
  blockerState,
  classifyFindings,
  classifyRetest,
  compareCoverage,
  diffAttackPaths,
  diffGraph,
  evaluateRetestEligibility,
  matchFindings,
  reevaluateChecks,
  summarizeFindingChanges,
  validateAdaptation,
  createRuntimeRegistry,
} from '@audivra/security'

/*
 * Phase 6C unit tests — the pure retest/history logic, no database. The load-bearing guarantee is that a fix
 * is never asserted without positive evidence: a consistent replay with no working control is cannot-reproduce
 * (not fixed), and a previous finding merely absent from a later assessment is not-tested (not fixed).
 */

const T = '2026-10-14T00:00:00.000Z'

function comparison(overrides: Partial<SecurityComparison> & { result: ComparisonResult; controls: ComparisonControls; subjectStatus?: 'executed' | 'blocked' | 'failed' }): SecurityComparison {
  const subjectStatus = overrides.subjectStatus ?? 'executed'
  return {
    id: 'cmp_x',
    engagementId: 'e',
    hypothesisId: null,
    dimension: 'object-boundary',
    dedupeKey: 'k',
    title: 't',
    resourceRef: 'doc1',
    action: 'read',
    resourceRelationship: 'different-owner',
    invariantRef: null,
    status: overrides.status ?? 'completed',
    arms: [
      { role: 'subject', identityRef: 'bob', sessionRef: 's', resourceRef: 'doc1', url: 'http://x/doc1', method: 'GET', body: null, expected: { outcome: 'deny', basis: 'declared', invariantRef: null, sourceRef: null, rationale: '' }, status: subjectStatus, statusReason: subjectStatus === 'blocked' ? 'no session' : null, executionId: 'sx_1', observation: null },
      { role: 'positive-control', identityRef: 'alice', sessionRef: 's2', resourceRef: 'doc1', url: 'http://x/doc1', method: 'GET', body: null, expected: { outcome: 'allow', basis: 'observed', invariantRef: null, sourceRef: null, rationale: '' }, status: 'executed', statusReason: null, executionId: 'sx_2', observation: null },
    ],
    controls: overrides.controls,
    semanticDifferences: [],
    state: null,
    result: overrides.result,
    resultReason: overrides.resultReason ?? 'reason',
    confidence: 0.8,
    invariantEvaluation: null,
    evidenceRefs: overrides.evidenceRefs ?? ['ev_1'],
    cleanupAction: null,
    stateProbe: null,
    cleanup: { required: false, attempted: false, succeeded: null, detail: null },
    coverageSampled: false,
    origin: 'user',
    retries: 0,
    history: [],
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }
}

const withPositive: ComparisonControls = { positive: true, negative: true }
const noPositive: ComparisonControls = { positive: false, negative: false }
const needsControl = { positive: true, negative: false }

describe('classifyRetest — a fix requires positive evidence of remediation', () => {
  it('consistent replay with a working positive control → fixed', () => {
    const r = classifyRetest(comparison({ result: 'consistent', controls: withPositive }), { controlsRequired: needsControl, originalSeverity: 'high' })
    expect(r.state).toBe('fixed')
    expect(r.controlValid).toBe(true)
  })

  it('consistent replay with NO working positive control → cannot-reproduce, NEVER fixed', () => {
    const r = classifyRetest(comparison({ result: 'consistent', controls: noPositive }), { controlsRequired: needsControl, originalSeverity: 'high' })
    expect(r.state).toBe('cannot-reproduce')
    expect(r.state).not.toBe('fixed')
    expect(r.controlValid).toBe(false)
  })

  it('inconsistent replay with a working control → still-present', () => {
    const r = classifyRetest(comparison({ result: 'inconsistent', controls: withPositive }), { controlsRequired: needsControl, originalSeverity: 'high' })
    expect(r.state).toBe('still-present')
    expect(r.severityNow).toBe('high')
  })

  it('a blocked replay → blocked, never fixed', () => {
    const r = classifyRetest(comparison({ result: 'blocked', controls: noPositive, status: 'blocked' }), { controlsRequired: needsControl, originalSeverity: 'high' })
    expect(r.state).toBe('blocked')
  })

  it('a subject that did not execute → cannot-reproduce, never fixed', () => {
    const r = classifyRetest(comparison({ result: 'inconclusive', controls: withPositive, subjectStatus: 'failed' }), { controlsRequired: needsControl, originalSeverity: 'high' })
    expect(r.state).toBe('cannot-reproduce')
  })

  it('an inconclusive replay → inconclusive', () => {
    const r = classifyRetest(comparison({ result: 'inconclusive', controls: withPositive }), { controlsRequired: needsControl, originalSeverity: 'medium' })
    expect(r.state).toBe('inconclusive')
  })
})

describe('reevaluateChecks — re-runs the original 6A requirements against the fresh evidence', () => {
  it('a comparison-result check is met only when the fresh result matches', () => {
    const checks: VerificationCheck[] = [{ check: 'comparison-result', results: ['inconsistent'] }, { check: 'positive-control' }]
    const stillPresent = reevaluateChecks(checks, comparison({ result: 'inconsistent', controls: withPositive }))
    expect(stillPresent.find((c) => c.check === 'comparison-result')?.met).toBe(true)
    const fixed = reevaluateChecks(checks, comparison({ result: 'consistent', controls: withPositive }))
    expect(fixed.find((c) => c.check === 'comparison-result')?.met).toBe(false)
  })
})

// ── Finding builders ─────────────────────────────────────────────────────────────────────────────────

function finding(overrides: Partial<SecurityFinding> & { id: string; issueKey: string }): SecurityFinding {
  return {
    engagementId: 'e',
    title: `Finding ${overrides.id}`,
    category: 'authorization',
    severity: 'high',
    severityReason: '',
    confidence: 0.8,
    verificationState: 'verified',
    status: 'verified',
    affectedEntities: [{ key: 'identity:bob', kind: 'identity', label: 'bob' }, { key: 'resource:doc1', kind: 'resource', label: 'doc1' }],
    claim: '',
    evidenceRefs: [],
    contradictingEvidenceRefs: [],
    impact: '',
    remediation: '',
    reproduction: null,
    severityInputs: { category: 'authorization', scopeClass: 'in-scope', privilegeBoundaryCrossed: false, tenantBoundaryCrossed: false, dataSensitivity: 'unknown', exploitPrerequisites: 'authenticated', confidence: 0.8, environment: 'staging' },
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
    ...overrides,
  }
}

const retest = (over: Partial<RetestResult> & { state: RetestResult['state']; issueKey: string }): RetestResult => ({
  id: 'rr_1',
  engagementId: 'e2',
  retestCaseId: 'rc_1',
  findingId: 'fnd_1',
  sourceEngagementId: 'e1',
  reason: '',
  freshComparisonId: null,
  freshResult: null,
  controlValid: true,
  checkResults: [],
  executionIds: [],
  identityRefs: [],
  evidenceRefs: [],
  capabilityVersions: [],
  adaptation: null,
  severityNow: null,
  createdAt: T,
  ...over,
})

describe('matchFindings — exact keys win, semantic matching is cautious', () => {
  it('matches identical issue keys exactly', () => {
    const matches = matchFindings([finding({ id: 'a', issueKey: 'K1' })], [finding({ id: 'b', issueKey: 'K1' })])
    expect(matches).toHaveLength(1)
    expect(matches[0]!.basis).toBe('exact-issue-key')
    expect(matches[0]!.confidence).toBe(1)
  })

  it('never matches across categories', () => {
    const prev = [finding({ id: 'a', issueKey: 'K1', category: 'authorization' })]
    const cur = [finding({ id: 'b', issueKey: 'K2', category: 'tenant-isolation' })]
    const matches = matchFindings(prev, cur)
    expect(matches.find((m) => m.previousFindingId === 'a')?.basis).toBe('unmatched')
    expect(matches.find((m) => m.currentFindingId === 'b')?.basis).toBe('unmatched')
  })

  it('semantically matches same category with a shared entity but a different key', () => {
    const prev = [finding({ id: 'a', issueKey: 'K1' })]
    const cur = [finding({ id: 'b', issueKey: 'K2' })] // same category + shared identity:bob/resource:doc1
    const matches = matchFindings(prev, cur)
    const m = matches.find((x) => x.previousFindingId === 'a')!
    expect(m.basis).toBe('semantic-match')
    expect(m.confidence).toBeLessThan(1)
  })

  it('reports a current-only finding as new (unmatched previous side null)', () => {
    const matches = matchFindings([], [finding({ id: 'b', issueKey: 'K9', category: 'exposure' })])
    expect(matches[0]!.previousFindingId).toBeNull()
    expect(matches[0]!.currentFindingId).toBe('b')
  })
})

describe('classifyFindings — absence is never a fix', () => {
  const opts = { retestsByIssueKey: new Map<string, RetestResult[]>(), coverageRegressed: false }

  it('a previous finding absent with NO retest is not-tested, not fixed', () => {
    const matches = matchFindings([finding({ id: 'a', issueKey: 'K1' })], [])
    const entries = classifyFindings([finding({ id: 'a', issueKey: 'K1' })], [], matches, opts)
    expect(entries[0]!.class).toBe('not-tested')
  })

  it('a previous finding absent WITH a fixed retest is fixed', () => {
    const matches = matchFindings([finding({ id: 'a', issueKey: 'K1' })], [])
    const entries = classifyFindings([finding({ id: 'a', issueKey: 'K1' })], [], matches, { retestsByIssueKey: new Map([['K1', [retest({ state: 'fixed', issueKey: 'K1' })]]]), coverageRegressed: false })
    expect(entries[0]!.class).toBe('fixed')
  })

  it('a previous finding absent with a cannot-reproduce retest is cannot-reproduce (not fixed)', () => {
    const matches = matchFindings([finding({ id: 'a', issueKey: 'K1' })], [])
    const entries = classifyFindings([finding({ id: 'a', issueKey: 'K1' })], [], matches, { retestsByIssueKey: new Map([['K1', [retest({ state: 'cannot-reproduce', issueKey: 'K1' })]]]), coverageRegressed: false })
    expect(entries[0]!.class).toBe('cannot-reproduce')
  })

  it('present in both is still-present; prior fix makes it regressed', () => {
    const prev = [finding({ id: 'a', issueKey: 'K1' })]
    const cur = [finding({ id: 'b', issueKey: 'K1' })]
    expect(classifyFindings(prev, cur, matchFindings(prev, cur), opts)[0]!.class).toBe('still-present')
    const regressed = classifyFindings(prev, cur, matchFindings(prev, cur), { retestsByIssueKey: new Map([['K1', [retest({ state: 'fixed', issueKey: 'K1' })]]]), coverageRegressed: false })
    expect(regressed[0]!.class).toBe('regressed')
  })

  it('a current-only finding is new', () => {
    const cur = [finding({ id: 'b', issueKey: 'K9', category: 'exposure' })]
    expect(classifyFindings([], cur, matchFindings([], cur), opts)[0]!.class).toBe('new')
  })

  it('summarizes classes', () => {
    const prev = [finding({ id: 'a', issueKey: 'K1' })]
    const entries = classifyFindings(prev, [], matchFindings(prev, []), opts)
    expect(summarizeFindingChanges(entries).notTested).toBe(1)
  })
})

describe('diffAttackPaths — a vanished path is "disappeared", never silently fixed', () => {
  const path = (over: Partial<SecurityAttackPath> & { pathKey: string }): SecurityAttackPath => ({
    id: `ap_${over.pathKey}`,
    engagementId: 'e',
    pathKey: over.pathKey,
    title: 'route',
    purpose: '',
    start: { kind: 'authenticated-identity', identityRef: 'bob', entityKey: 'identity:bob', label: 'bob' },
    end: { impactClass: 'unauthorized-data-access', entityKey: 'resource:doc1', label: 'doc1' },
    steps: [{ index: 0, fromCondition: 'bob', relationship: 'reads doc1', toCondition: 'doc1 data', edgeVerification: 'verified', findingId: 'fnd_1', boundaryCrossed: null, references: [], evidenceRefs: [], rationale: '' }],
    affectedEntityKeys: ['identity:bob'],
    findingIds: ['fnd_1'],
    comparisonIds: [],
    invariantRefs: [],
    confidence: 0.9,
    state: 'verified',
    stateReason: '',
    missingEvidence: [],
    impactClass: 'unauthorized-data-access',
    impactPriority: 'high',
    boundariesCrossed: [],
    origin: 'deterministic',
    providerId: null,
    explanation: '',
    dominatedBy: null,
    history: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  })

  it('classifies a path present only before as disappeared', () => {
    const diff = diffAttackPaths([path({ pathKey: 'p1' })], [])
    expect(diff[0]!.class).toBe('disappeared')
    expect(diff[0]!.removedVerifiedEdges).toHaveLength(1)
  })

  it('classifies an unchanged path as still-present', () => {
    const diff = diffAttackPaths([path({ pathKey: 'p1' })], [path({ pathKey: 'p1' })])
    expect(diff[0]!.class).toBe('still-present')
  })
})

describe('compareCoverage — a reduction is visible', () => {
  it('flags coverageRegressed when fewer identities/resources were tested', () => {
    const base = { verification: { candidates: { total: 0, byStatus: {} }, findings: { total: 2, byCategory: {}, bySeverity: {}, byVerification: {}, byStatus: {} } }, comparison: emptyComparisonCoverage(3, 4, 6), pathsTotal: 2 }
    const less = { verification: { candidates: { total: 0, byStatus: {} }, findings: { total: 1, byCategory: {}, bySeverity: {}, byVerification: {}, byStatus: {} } }, comparison: emptyComparisonCoverage(1, 2, 2), pathsTotal: 1 }
    const cov = compareCoverage('e1', 'e2', base, less)
    expect(cov.coverageRegressed).toBe(true)
    expect(cov.identitiesTested.delta).toBe(-2)
    expect(cov.notes.join(' ')).toMatch(/caution/i)
  })
})

function emptyComparisonCoverage(identities: number, resources: number, comparisons: number) {
  return {
    entities: { identities, roles: 0, tenants: 0, resources, actions: 0, businessStates: 0, invariants: 0 },
    comparisons: { total: comparisons, byResult: {}, sampled: 0 },
    dimensions: {},
    controls: { positive: 0, negative: 0, both: 0, neither: 0 },
    invariants: { total: 0, supported: 0, contradicted: 0, inconclusive: 0, notTested: 0 },
  }
}

describe('diffGraph — only important security entities, by stable key', () => {
  const node = (key: string, kind: SecurityGraphNode['kind'], status: SecurityGraphNode['status'] = 'active'): SecurityGraphNode => ({ id: `gn_${key}`, engagementId: 'e', kind, key, label: key, attributes: {}, scopeClass: null, basis: 'declared', confidence: 1, corroboration: 1, tools: [], status, statusReason: null, conflicts: [], firstObservedAt: T, lastObservedAt: T, firstExecutionId: null, lastExecutionId: null, updatedAt: T })
  it('reports added, removed and status-changed entities', () => {
    const prev = { nodes: [node('resource:doc1', 'resource'), node('resource:doc2', 'resource')], edges: [] as SecurityGraphEdge[] }
    const cur = { nodes: [node('resource:doc1', 'resource', 'contradicted'), node('resource:doc3', 'resource')], edges: [] as SecurityGraphEdge[] }
    const changes = diffGraph(prev, cur)
    expect(changes.find((c) => c.key === 'resource:doc3')?.kind).toBe('added')
    expect(changes.find((c) => c.key === 'resource:doc2')?.kind).toBe('removed')
    expect(changes.find((c) => c.key === 'resource:doc1')?.kind).toBe('changed')
  })
})

describe('adaptation — never changes the security property, only the location', () => {
  const repro: ComparisonPlanInput = {
    hypothesisId: null,
    dimension: 'object-boundary',
    resourceRef: 'doc1',
    action: 'read',
    invariantRef: null,
    arms: [
      { role: 'subject', identityRef: 'bob', resourceRef: 'doc1', url: 'http://x/old', method: 'GET', body: null, expected: { outcome: 'deny', basis: 'declared', invariantRef: null, sourceRef: null, rationale: '' } },
      { role: 'positive-control', identityRef: 'alice', resourceRef: 'doc1', url: 'http://x/old', method: 'GET', body: null, expected: { outcome: 'allow', basis: 'observed', invariantRef: null, sourceRef: null, rationale: '' } },
    ],
    cleanupRequired: false,
    cleanup: null,
    stateProbeUrl: null,
    expectedTransition: null,
    reason: 'r',
    coverageSampled: false,
  }
  const ctx = { graphEntityKeys: new Set(['resource:doc1', 'endpoint:/new']), declaredResourceRefs: new Set(['doc1']) }

  it('rejects a proposal referencing an entity that does not exist', () => {
    const a = validateAdaptation({ adaptable: true, kind: 'endpoint-moved', newUrl: 'http://x/new', newResourceRef: null, referencedEntityKeys: ['endpoint:/ghost'], reason: 'moved' }, repro, ctx, 'p')
    expect(a).toBeNull()
  })

  it('rejects when adaptable is false', () => {
    expect(validateAdaptation({ adaptable: false, kind: null, newUrl: null, newResourceRef: null, referencedEntityKeys: [], reason: 'no' }, repro, ctx, 'p')).toBeNull()
  })

  it('accepts a valid endpoint relocation and keeps the expectation intact', () => {
    const a = validateAdaptation({ adaptable: true, kind: 'endpoint-moved', newUrl: 'http://x/new', newResourceRef: null, referencedEntityKeys: ['endpoint:/new'], reason: 'moved' }, repro, ctx, 'p')
    expect(a).not.toBeNull()
    const adapted = applyAdaptation(repro, a!, 'http://x/new', null)
    expect(adapted.arms.find((arm) => arm.role === 'subject')!.url).toBe('http://x/new')
    expect(adapted.arms.find((arm) => arm.role === 'subject')!.expected.outcome).toBe('deny') // unchanged
    expect(adapted.arms.find((arm) => arm.role === 'positive-control')!.url).toBe('http://x/new')
  })
})

describe('evaluateRetestEligibility — blockers are explicit', () => {
  const registry = createRuntimeRegistry()
  const base = {
    reproductionFormat: 'differential-comparison' as const,
    capabilityIds: ['access.identity-read'],
    reproduction: {
      hypothesisId: null,
      dimension: 'object-boundary' as const,
      resourceRef: 'doc1',
      action: 'read',
      invariantRef: null,
      arms: [{ role: 'subject' as const, identityRef: 'bob', resourceRef: 'doc1', url: 'http://x/doc1', method: 'GET' as const, body: null, expected: { outcome: 'deny' as const, basis: 'declared' as const, invariantRef: null, sourceRef: null, rationale: '' } }],
      cleanupRequired: false,
      cleanup: null,
      stateProbeUrl: null,
      expectedTransition: null,
      reason: 'r',
      coverageSampled: false,
    },
  }
  const ctx = (over: Partial<Parameters<typeof evaluateRetestEligibility>[1]>) => ({
    environment: 'staging',
    scope: { version: 1 } as never,
    declaredIdentityRefs: new Set(['bob']),
    declaredResourceRefs: new Set(['doc1']),
    activeSessionIdentityRefs: new Set(['bob']),
    authorized: true,
    sourceEnvironment: 'staging',
    registry,
    ...over,
  })

  it('blocks an unsupported reproduction', () => {
    const e = evaluateRetestEligibility({ ...base, reproductionFormat: 'observation-only', reproduction: null }, ctx({}))
    expect(e.blocker).toBe('unsupported-reproduction')
    expect(blockerState('unsupported-reproduction')).toBe('cannot-reproduce')
  })

  it('blocks when the capability is unregistered', () => {
    expect(evaluateRetestEligibility({ ...base, capabilityIds: ['access.made-up'] }, ctx({})).blocker).toBe('capability-unavailable')
  })

  it('blocks when the engagement is not authorized', () => {
    expect(evaluateRetestEligibility(base, ctx({ authorized: false })).blocker).toBe('authorization-invalid')
  })

  it('blocks a missing resource, missing identity and missing session', () => {
    expect(evaluateRetestEligibility(base, ctx({ declaredResourceRefs: new Set() })).blocker).toBe('resource-missing')
    expect(evaluateRetestEligibility(base, ctx({ declaredIdentityRefs: new Set() })).blocker).toBe('identity-unavailable')
    expect(evaluateRetestEligibility(base, ctx({ activeSessionIdentityRefs: new Set() })).blocker).toBe('session-unavailable')
  })
})
