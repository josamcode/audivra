import { describe, expect, it } from 'vitest'
import type { ComparisonPlanInput, SecurityComparison, SecurityFinding, SecurityResearchAction, SecurityResearchRun } from '@audivra/contracts'
import { assess, budgetExhausted, defaultBudget, rankCandidates, validateBatch, zeroUsage, type AssessContext, type CandidateAction } from '@audivra/security'

/*
 * Phase 6E unit tests — the deterministic planning core (no database). ASSESS proposes cheap-first candidates
 * from stored state; VALIDATE rejects invalid/duplicate/too-expensive proposals; RANK orders by information
 * gain / cost / failed-action memory with the AI's priority only advisory; budgets bound the loop.
 */

const plan = (resourceRef: string): ComparisonPlanInput => ({
  hypothesisId: null,
  dimension: 'object-boundary',
  resourceRef,
  action: 'read',
  invariantRef: null,
  arms: [
    { role: 'subject', identityRef: 'bob', resourceRef, url: `http://x/${resourceRef}`, method: 'GET', body: null, expected: { outcome: 'deny', basis: 'declared', invariantRef: null, sourceRef: null, rationale: '' } },
    { role: 'positive-control', identityRef: 'alice', resourceRef, url: `http://x/${resourceRef}`, method: 'GET', body: null, expected: { outcome: 'allow', basis: 'observed', invariantRef: null, sourceRef: null, rationale: '' } },
  ],
  cleanupRequired: false,
  cleanup: null,
  stateProbeUrl: null,
  expectedTransition: null,
  reason: 'r',
  coverageSampled: false,
})

const run = (over: Partial<SecurityResearchRun> = {}): SecurityResearchRun => ({
  id: 'rsr_1',
  engagementId: 'e',
  parentRunId: null,
  mode: 'investigate',
  objective: 'maximize-coverage',
  objectiveNote: null,
  objectiveDetail: {},
  state: 'running',
  stage: 'assess',
  iteration: 0,
  budget: defaultBudget('investigate'),
  usage: zeroUsage(),
  coverageBefore: { findings: 0, verifiedFindings: 0, supportedFindings: 0, comparisons: 0, identitiesTested: 0, resourcesSampled: 0, attackPaths: 0, openGaps: 0, specialistRuns: 0 },
  coverageAfter: null,
  residual: { tested: [], partiallyTested: [], notTested: [], unknown: [] },
  terminationReason: null,
  lastDecision: '',
  startingGraphRevision: null,
  providerAvailable: true,
  createdAt: 't',
  startedAt: null,
  finishedAt: null,
  updatedAt: 't',
  ...over,
})

const comparison = (result: SecurityComparison['result']): SecurityComparison => ({
  id: 'cmp', engagementId: 'e', hypothesisId: null, dimension: 'object-boundary', dedupeKey: 'k', title: 't', resourceRef: 'doc1', action: 'read', resourceRelationship: 'different-owner', invariantRef: null, status: 'completed', arms: [], controls: { positive: true, negative: false }, semanticDifferences: [], state: null, result, resultReason: '', confidence: 0.8, invariantEvaluation: null, evidenceRefs: [], cleanupAction: null, stateProbe: null, cleanup: { required: false, attempted: false, succeeded: null, detail: null }, coverageSampled: false, origin: 'user', retries: 0, history: [], createdAt: 't', updatedAt: 't',
})
const finding = (id: string): SecurityFinding => ({
  id, engagementId: 'e', issueKey: id, title: id, category: 'authorization', severity: 'high', severityReason: '', confidence: 0.8, verificationState: 'supported', status: 'open', affectedEntities: [], claim: '', evidenceRefs: [], contradictingEvidenceRefs: [], impact: '', remediation: '', reproduction: null,
  severityInputs: { category: 'authorization', scopeClass: 'in-scope', privilegeBoundaryCrossed: false, tenantBoundaryCrossed: false, dataSensitivity: 'unknown', exploitPrerequisites: 'authenticated', confidence: 0.8, environment: 'staging' },
  confidenceFactors: { directObservation: true, independentCorroboration: true, positiveControl: true, negativeControl: false, deterministicReproduction: true, contradictoryEvidence: false, aiInferenceDependency: false },
  candidateIds: [], hypothesisIds: [], comparisonIds: [], invariantRefs: [], reviewed: false, reviewNote: null, history: [], createdAt: 't', updatedAt: 't',
})

const ctx = (over: Partial<AssessContext> = {}): AssessContext => ({
  run: run(),
  proposals: [{ plan: plan('doc1'), informationGain: 5, reason: 'compare doc1' }],
  comparisons: [],
  candidates: [],
  findings: [],
  attackPaths: [],
  retestCases: [],
  specialistAvailable: true,
  specialistBudgetLeft: true,
  ...over,
})

describe('ASSESS — cheap-first candidates from stored state', () => {
  it('proposes a comparison for each ranked plan', () => {
    const out = assess(ctx())
    expect(out.some((a) => a.kind === 'comparison' && a.costClass === 'normal')).toBe(true)
  })
  it('proposes verification when inconsistent comparisons lack findings', () => {
    const out = assess(ctx({ comparisons: [comparison('inconsistent')], findings: [] }))
    expect(out.some((a) => a.kind === 'verify')).toBe(true)
  })
  it('proposes an attack-path refresh once findings exist', () => {
    const out = assess(ctx({ findings: [finding('f1')] }))
    expect(out.some((a) => a.kind === 'attack-path')).toBe(true)
  })
  it('does NOT propose the expensive specialist while a cheaper comparison remains', () => {
    const out = assess(ctx())
    expect(out.some((a) => a.kind === 'specialist')).toBe(false)
  })
  it('proposes the specialist only as a last resort (no cheaper work left)', () => {
    const out = assess(ctx({ proposals: [], objective: undefined } as never))
    // With no proposals + no findings + no comparisons, and a broad objective, specialist becomes a candidate.
    const broad = assess(ctx({ proposals: [], findings: [], comparisons: [] }))
    expect(broad.some((a) => a.kind === 'specialist' && a.costClass === 'expensive')).toBe(true)
    void out
  })
})

describe('VALIDATE — deterministic rejection, cheap-before-expensive', () => {
  const cmp: CandidateAction = { kind: 'comparison', origin: 'deterministic', objectiveRef: 'doc1', capabilityId: null, inputRef: plan('doc1') as unknown as Record<string, unknown>, fingerprint: 'fp-cmp', costClass: 'normal', expectedInformationGain: 5, reason: 'r' }
  const spec: CandidateAction = { kind: 'specialist', origin: 'deterministic', objectiveRef: null, capabilityId: 'specialist.strix-research', inputRef: { mode: 'source-only' }, fingerprint: 'fp-spec', costClass: 'expensive', expectedInformationGain: 2, reason: 'r' }
  const base = { run: run(), history: [] as SecurityResearchAction[], declaredResourceRefs: new Set(['doc1']), findingIds: new Set<string>(), specialistAvailable: true }

  it('rejects an expensive specialist action while a cheaper valid action remains (§15)', () => {
    const results = validateBatch([cmp, spec], base)
    expect(results.find((r) => r.candidate.fingerprint === 'fp-spec')!.rejection).toBe('too-expensive')
    expect(results.find((r) => r.candidate.fingerprint === 'fp-cmp')!.ok).toBe(true)
  })
  it('allows the specialist when it is the only option', () => {
    const results = validateBatch([spec], base)
    expect(results[0]!.ok).toBe(true)
  })
  it('rejects a duplicate of completed work', () => {
    const history: SecurityResearchAction[] = [{ id: 'a', runId: 'rsr_1', engagementId: 'e', iteration: 0, kind: 'comparison', origin: 'deterministic', state: 'completed', objectiveRef: 'doc1', capabilityId: null, inputRef: {}, fingerprint: 'fp-cmp', costClass: 'normal', expectedInformationGain: 5, rank: 0, reason: '', rejection: null, usefulness: 'useful', outcome: '', producedRefs: [], createdAt: 't', updatedAt: 't' }]
    expect(validateBatch([cmp], { ...base, history })[0]!.rejection).toBe('duplicate')
  })
  it('rejects a specialist action when the engine is unavailable', () => {
    expect(validateBatch([spec], { ...base, specialistAvailable: false })[0]!.rejection).toBe('specialist-unavailable')
  })
  it('rejects an AI proposal that invents a resource', () => {
    const invented: CandidateAction = { kind: 'comparison', origin: 'ai-proposed', objectiveRef: 'ghost', capabilityId: null, inputRef: { resourceRef: 'ghost', arms: undefined }, fingerprint: 'fp-ghost', costClass: 'normal', expectedInformationGain: 2, reason: 'r' }
    const rej = validateBatch([invented], base)[0]!.rejection
    expect(rej === 'input-invalid' || rej === 'reference-missing').toBe(true)
  })
})

describe('RANK — deterministic; AI priority advisory', () => {
  const cheap: CandidateAction = { kind: 'verify', origin: 'deterministic', objectiveRef: null, capabilityId: null, inputRef: {}, fingerprint: 'fp-v', costClass: 'cheap', expectedInformationGain: 3, reason: 'r' }
  const normal: CandidateAction = { kind: 'comparison', origin: 'deterministic', objectiveRef: 'doc1', capabilityId: null, inputRef: {}, fingerprint: 'fp-c', costClass: 'normal', expectedInformationGain: 5, reason: 'r' }
  it('ranks higher information gain first, penalizing cost', () => {
    const ranked = rankCandidates([cheap, normal], [], new Map())
    expect(ranked[0]!.candidate.fingerprint).toBe('fp-c') // gain 5 beats gain 3 even with cost
  })
  it('penalizes a fingerprint that previously failed', () => {
    const history: SecurityResearchAction[] = [{ id: 'a', runId: 'r', engagementId: 'e', iteration: 0, kind: 'comparison', origin: 'deterministic', state: 'completed', objectiveRef: null, capabilityId: null, inputRef: {}, fingerprint: 'fp-c', costClass: 'normal', expectedInformationGain: 5, rank: 0, reason: '', rejection: null, usefulness: 'no-new-information', outcome: '', producedRefs: [], createdAt: 't', updatedAt: 't' }]
    const ranked = rankCandidates([cheap, normal], history, new Map())
    expect(ranked[0]!.candidate.fingerprint).toBe('fp-v') // the previously unproductive action sinks
  })
})

describe('budget', () => {
  it('clamps user overrides within the mode ceiling', () => {
    expect(defaultBudget('investigate', { maxActions: 999 }).maxActions).toBe(defaultBudget('investigate').maxActions)
    expect(defaultBudget('investigate', { maxActions: 3 }).maxActions).toBe(3)
  })
  it('detects exhaustion', () => {
    const b = defaultBudget('investigate')
    expect(budgetExhausted(b, { ...zeroUsage(), iterations: b.maxIterations })).toBe('budget-exhausted')
    expect(budgetExhausted(b, { ...zeroUsage(), actions: b.maxActions })).toBe('action-limit')
    expect(budgetExhausted(b, zeroUsage())).toBeNull()
  })
})
