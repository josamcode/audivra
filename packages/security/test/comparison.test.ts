import { describe, expect, it } from 'vitest'
import type { ComparisonArm, ComparisonArmPlan, ExpectedBehavior } from '@audivra/contracts'
import type { ProbeCapture } from '../src/capabilities/comparison-probe.ts'
import { classifyComparison, classifyRelationship, comparisonDedupeKey } from '../src/comparison/classify.ts'
import { diffObservations, normalizeProbe, responseClassOf } from '../src/comparison/normalize.ts'
import { proposeComparisons, validateProposedComparison, type PlannerInput } from '../src/comparison/plan.ts'

/*
 * Phase 5 Step 4 pure logic: response normalization (semantics beyond status, volatile noise stripped),
 * semantic diffing, deterministic classification with controls, the resource-relationship classifier, the
 * bounded planner (pruning + dedupe + ranking) and adversarial-proposal rejection. No DB, no network.
 */

const probe = (over: Partial<ProbeCapture> = {}): ProbeCapture => ({
  method: 'GET',
  status: 200,
  finalUrl: 'http://127.0.0.1/api/resources/doc1',
  contentType: 'application/json',
  contentLength: null,
  redirectLocation: null,
  bodyBytes: 40,
  bodySha256: 'abc',
  bodySample: '{"id":"doc1","owner":"alice","state":"draft"}',
  authenticated: true,
  identityRef: 'bob',
  sessionRef: 'sess_x',
  ...over,
})

describe('response normalization', () => {
  it('classifies responses semantically, not by status alone', () => {
    expect(responseClassOf(200, null, 40)).toBe('success')
    expect(responseClassOf(200, null, 0)).toBe('empty')
    expect(responseClassOf(401, null, 10)).toBe('auth-required')
    expect(responseClassOf(403, null, 10)).toBe('denied')
    expect(responseClassOf(404, null, 10)).toBe('not-found')
    expect(responseClassOf(302, 'http://x/login', 0)).toBe('redirect-login')
    expect(responseClassOf(500, null, 10)).toBe('error')
  })

  it('extracts fields/object and hashes content after stripping volatile noise', () => {
    const a = normalizeProbe(probe({ bodySample: '{"id":"doc1","token":"aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc","ts":"2026-01-01T00:00:00Z"}' }), 'sx_1', ['EV-1'])
    const b = normalizeProbe(probe({ bodySample: '{"id":"doc1","token":"zzzzzzzzzzzzzzzzzzzzzzzz.yyyyyyyyyyyy.xxxxxxxxxxxx","ts":"2027-02-02T12:00:00Z"}' }), 'sx_2', ['EV-2'])
    expect(a.fields).toContain('id')
    expect(a.objectRef).toBe('doc1')
    // Volatile token + timestamp stripped → the two responses are content-equal.
    expect(a.normalizedHash).toBe(b.normalizedHash)
  })

  it('flags a mutating method that succeeded as a state mutation', () => {
    expect(normalizeProbe(probe({ method: 'POST', status: 200, bodySample: '{"id":"doc1","state":"approved"}' }), 'sx', []).stateMutation).toBe(true)
    expect(normalizeProbe(probe({ method: 'GET', status: 200 }), 'sx', []).stateMutation).toBe(false)
  })

  it('diffs two observations and flags security-relevant access differences', () => {
    const granted = normalizeProbe(probe({ status: 200 }), 's1', [])
    const denied = normalizeProbe(probe({ status: 403, bodySample: '{"error":"forbidden"}' }), 's2', [])
    const diffs = diffObservations(granted, denied, ['subject', 'negative-control'])
    const classDiff = diffs.find((d) => d.aspect === 'response-class')
    expect(classDiff?.securityRelevant).toBe(true)
  })
})

const arm = (role: ComparisonArm['role'], expected: ExpectedBehavior['outcome'], obs: ProbeCapture | null, status: ComparisonArm['status'] = 'executed'): ComparisonArm => ({
  role,
  identityRef: role === 'negative-control' ? null : 'id',
  sessionRef: null,
  resourceRef: 'doc1',
  url: 'http://x/doc1',
  method: 'GET',
  body: null,
  expected: { outcome: expected, basis: 'declared', invariantRef: null, sourceRef: null, rationale: '' },
  status,
  statusReason: null,
  executionId: 's',
  observation: obs ? normalizeProbe(obs, 's', []) : null,
})

describe('classification', () => {
  it('flags inconsistent when the subject is granted access that a positive control proves is controlled', () => {
    const c = classifyComparison([arm('subject', 'deny', probe({ status: 200 })), arm('positive-control', 'allow', probe({ status: 200 })), arm('negative-control', 'deny', probe({ status: 401 }))], 'object-boundary', 'inv-1')
    expect(c.result).toBe('inconsistent')
    expect(c.invariantEvaluation).toBe('contradicted')
    expect(c.controls).toEqual({ positive: true, negative: true })
    expect(c.confidence).toBeGreaterThanOrEqual(0.85)
  })

  it('is consistent when the subject is denied as expected', () => {
    const c = classifyComparison([arm('subject', 'deny', probe({ status: 403 })), arm('positive-control', 'allow', probe({ status: 200 }))], 'object-boundary', 'inv-1')
    expect(c.result).toBe('consistent')
    expect(c.invariantEvaluation).toBe('supported')
  })

  it('is inconclusive when access was obtained but no positive control proves the resource is controlled', () => {
    const c = classifyComparison([arm('subject', 'deny', probe({ status: 200 }))], 'object-boundary', null)
    expect(c.result).toBe('inconclusive')
  })

  it('is blocked when the subject arm was blocked by policy/validation', () => {
    const c = classifyComparison([arm('subject', 'deny', null, 'blocked')], 'state-transition', null)
    expect(c.result).toBe('blocked')
  })

  // G1 regression: a field-boundary "limited view expected" is only a finding when a field-level policy is
  // DECLARED (invariant-backed). Two roles that both legitimately read the resource and see the SAME fields
  // must NOT be flagged as a vulnerability without evidence that a limited view was required.
  it('does NOT flag identical field views as inconsistent without a declared field-level policy (G1)', () => {
    const c = classifyComparison([arm('subject', 'limited', probe()), arm('positive-control', 'allow', probe())], 'field-boundary', null)
    expect(c.result).toBe('inconclusive')
    expect(c.resultReason).toMatch(/no field-level policy/i)
  })

  it('flags identical field views as inconsistent ONLY when a field-level policy is declared (G1)', () => {
    const c = classifyComparison([arm('subject', 'limited', probe()), arm('positive-control', 'allow', probe())], 'field-boundary', 'inv-field')
    expect(c.result).toBe('inconsistent')
    expect(c.invariantEvaluation).toBe('contradicted')
  })

  it('is consistent when a declared field-level policy is met (subject sees a different, limited view) (G1)', () => {
    const c = classifyComparison([arm('subject', 'limited', probe({ bodySample: '{"id":"doc1"}', bodyBytes: 12 })), arm('positive-control', 'allow', probe())], 'field-boundary', 'inv-field')
    expect(c.result).toBe('consistent')
    expect(c.invariantEvaluation).toBe('supported')
  })

  it('classifies the resource relationship from ownership/tenant', () => {
    expect(classifyRelationship({ dimension: 'object-boundary', subjectIdentityRef: 'bob', resourceOwnerRef: 'alice', subjectTenantRef: 't1', resourceTenantRef: 't1' })).toBe('different-owner')
    expect(classifyRelationship({ dimension: 'object-boundary', subjectIdentityRef: 'alice', resourceOwnerRef: 'alice', subjectTenantRef: 't1', resourceTenantRef: 't1' })).toBe('same-owner')
    expect(classifyRelationship({ dimension: 'tenant-boundary', subjectIdentityRef: 'carol', resourceOwnerRef: null, subjectTenantRef: 't2', resourceTenantRef: 't1' })).toBe('different-tenant')
    expect(classifyRelationship({ dimension: 'object-boundary', subjectIdentityRef: 'bob', resourceOwnerRef: null, subjectTenantRef: null, resourceTenantRef: null })).toBe('unknown')
  })

  it('computes a stable, order-independent dedupe key', () => {
    const arms: ComparisonArmPlan[] = [
      { role: 'subject', identityRef: 'bob', resourceRef: 'doc1', url: 'http://x/doc1', method: 'GET', body: null, expected: { outcome: 'deny', basis: 'declared', invariantRef: null, sourceRef: null, rationale: '' } },
      { role: 'positive-control', identityRef: 'alice', resourceRef: 'doc1', url: 'http://x/doc1', method: 'GET', body: null, expected: { outcome: 'allow', basis: 'observed', invariantRef: null, sourceRef: null, rationale: '' } },
    ]
    expect(comparisonDedupeKey('object-boundary', 'read', arms)).toBe(comparisonDedupeKey('object-boundary', 'read', [...arms].reverse()))
    expect(comparisonDedupeKey('object-boundary', 'read', arms)).not.toBe(comparisonDedupeKey('tenant-boundary', 'read', arms))
  })
})

describe('planner', () => {
  const base: PlannerInput = {
    environment: 'staging',
    identities: [
      { ref: 'alice', key: 'identity:alice', tenantRef: 't1', roleRefs: ['editor'], hasSession: true },
      { ref: 'bob', key: 'identity:bob', tenantRef: 't1', roleRefs: [], hasSession: true },
      { ref: 'carol', key: 'identity:carol', tenantRef: 't2', roleRefs: [], hasSession: true },
    ],
    resources: [
      { ref: 'doc1', key: 'resource:document:doc1', ownerRef: 'alice', tenantRef: 't1', testData: 'test-owned', url: 'http://x/api/resources/doc1' },
      { ref: 'doc2', key: 'resource:document:doc2', ownerRef: 'bob', tenantRef: 't1', testData: 'test-owned', url: 'http://x/api/resources/doc2' },
    ],
    invariants: [{ ref: 'inv', category: 'object-boundary', rule: 'only owner', resourceRefs: ['doc1'] }],
    actions: [{ ref: 'approve', verb: 'approve', endpointUrl: 'http://x/api/resources/doc1/approve', method: 'POST', stateProbeUrl: 'http://x/api/resources/doc1/state', requiredRoleRefs: ['editor'], requiredStateRef: 'draft', resultingStateRef: 'approved', actsOnRefs: ['doc1'] }],
    roles: [{ ref: 'editor', permits: ['approve'] }],
    openGaps: [{ kind: 'authorization-expectation-unknown', subjectKey: 'resource:document:doc1' }],
    existingDedupeKeys: new Set(),
  }

  it('proposes bounded, controlled comparisons across categories and reports pruning stats', () => {
    const { plans, stats } = proposeComparisons(base, 6)
    expect(plans.length).toBeGreaterThan(0)
    expect(plans.length).toBeLessThanOrEqual(6)
    for (const p of plans) {
      expect(p.plan.arms.some((a) => a.role === 'subject')).toBe(true)
      expect(p.plan.arms.some((a) => a.role === 'positive-control' || a.role === 'negative-control')).toBe(true)
      expect(p.plan.coverageSampled).toBe(true)
    }
    // Multiple boundary categories are covered (object + a role/function/field/session one).
    expect(new Set(plans.map((p) => p.plan.dimension)).size).toBeGreaterThanOrEqual(2)
    expect(plans.some((p) => p.plan.dimension === 'object-boundary')).toBe(true)
    // Pruning: candidates considered stay well under the raw Cartesian product.
    expect(stats.candidates).toBeLessThanOrEqual(stats.cartesian)
    expect(stats.proposed).toBe(plans.length)
  })

  it('does not re-propose an already-existing comparison', () => {
    const [first] = proposeComparisons(base, 6).plans
    const key = comparisonDedupeKey(first!.plan.dimension, first!.plan.action, first!.plan.arms)
    const after = proposeComparisons({ ...base, existingDedupeKeys: new Set([key]) }, 6)
    expect(after.plans.some((p) => comparisonDedupeKey(p.plan.dimension, p.plan.action, p.plan.arms) === key)).toBe(false)
  })

  // G1 regression: the planner must NOT manufacture a field-boundary comparison from a bare assumption that a
  // non-owner should see fewer fields. It proposes one only when a field-access invariant is declared.
  it('does not propose a field-boundary comparison without a declared field-access policy (G1)', () => {
    const { plans, stats } = proposeComparisons(base, 8)
    expect(plans.some((p) => p.plan.dimension === 'field-boundary')).toBe(false)
    expect(stats.discarded['field-no-declared-policy']).toBeGreaterThanOrEqual(1)
  })

  it('proposes a field-boundary comparison (invariant-backed) when a field-access policy is declared (G1)', () => {
    const withPolicy: PlannerInput = { ...base, invariants: [...base.invariants, { ref: 'inv-field', category: 'field-access', rule: 'viewers see a limited view of doc1', resourceRefs: ['doc1'] }] }
    const { plans } = proposeComparisons(withPolicy, 8)
    const fb = plans.find((p) => p.plan.dimension === 'field-boundary')
    expect(fb).toBeDefined()
    expect(fb!.plan.invariantRef).toBe('inv-field')
    expect(fb!.plan.arms.find((a) => a.role === 'subject')!.expected).toMatchObject({ outcome: 'limited', basis: 'declared', invariantRef: 'inv-field' })
  })

  it('rejects adversarial proposals (invented refs, no session, ownership mismatch, no controls)', () => {
    const p = (over: Record<string, unknown>) => ({ hypothesisId: 'hy_00000000000000', dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', invariantRef: null, expectedTransition: null, reason: 'x', arms: [], ...over }) as never
    expect(validateProposedComparison(p({ resourceRef: 'ghost' }), base)).toMatchObject({ ok: false, reason: 'unknown-resource' })
    const subjectArm = { role: 'subject', identityRef: 'alice', resourceRef: 'doc1', url: 'http://x/api/resources/doc1', method: 'GET', body: null, expected: { outcome: 'deny', basis: 'ai-inferred', invariantRef: null, sourceRef: null, rationale: 'x' } }
    // alice IS the owner of doc1, so a "deny" expectation for her is an ownership mismatch.
    expect(validateProposedComparison(p({ arms: [subjectArm, { ...subjectArm, role: 'positive-control', identityRef: 'bob', expected: { ...subjectArm.expected, outcome: 'allow' } }] }), base)).toMatchObject({ ok: false, reason: 'ownership-mismatch' })
    // A declared identity with no established session.
    const noSession: PlannerInput = { ...base, identities: [{ ref: 'dan', key: 'identity:dan', tenantRef: 't1', roleRefs: [], hasSession: false }] }
    expect(validateProposedComparison(p({ arms: [{ ...subjectArm, identityRef: 'dan' }] }), noSession)).toMatchObject({ ok: false, reason: 'no-session' })
    // An identity that is not declared at all.
    expect(validateProposedComparison(p({ arms: [{ ...subjectArm, identityRef: 'nobody' }] }), base)).toMatchObject({ ok: false, reason: 'unknown-identity' })
  })
})
