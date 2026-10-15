import { createHash } from 'node:crypto'
import type {
  ComparisonArm,
  ComparisonArmPlan,
  ComparisonControls,
  ComparisonDimension,
  ComparisonResult,
  InvariantEvalStatus,
  ResourceRelationship,
  SemanticDifference,
} from '@audivra/contracts'
import { diffObservations, grantedAccess } from './normalize.ts'

/*
 * Phase 5 Step 4 — deterministic classification. Given the executed arms (subject + controls), each with its
 * normalized observation and its expected behaviour, decide the result WITHOUT any model input: did the
 * subject behave as the boundary expects, and do the controls make the signal trustworthy? A strong
 * authorization signal (access where denial was expected) is only claimed when a positive control confirms
 * the resource is normally access-controlled — otherwise the result is INCONCLUSIVE, never overclaimed.
 */

export interface Classification {
  result: ComparisonResult
  resultReason: string
  confidence: number
  controls: ComparisonControls
  semanticDifferences: SemanticDifference[]
  invariantEvaluation: InvariantEvalStatus | null
}

export function classifyComparison(arms: ComparisonArm[], _dimension: ComparisonDimension, invariantRef: string | null): Classification {
  const executed = (role: ComparisonArm['role']) => arms.filter((a) => a.role === role && a.status === 'executed' && a.observation)
  const subject = arms.find((a) => a.role === 'subject') ?? arms[0]
  const controls: ComparisonControls = { positive: executed('positive-control').length > 0, negative: executed('negative-control').length > 0 }
  const none = (result: ComparisonResult, resultReason: string, confidence = 0): Classification => ({ result, resultReason, confidence, controls, semanticDifferences: [], invariantEvaluation: invariantRef ? 'inconclusive' : null })

  if (!subject) return none('not-tested', 'No subject arm')
  if (subject.status === 'blocked') return none('blocked', subject.statusReason ?? 'The subject arm was blocked by validation or policy')
  if (subject.status !== 'executed' || !subject.observation) return none('not-tested', subject.statusReason ?? 'The subject arm did not execute')

  const sObs = subject.observation
  const pos = executed('positive-control')[0]
  const neg = executed('negative-control')[0]
  const compareTo = pos ?? neg
  const diffs = compareTo?.observation ? diffObservations(sObs, compareTo.observation, ['subject', compareTo.role]) : []
  const granted = grantedAccess(sObs)
  const expected = subject.expected.outcome

  let result: ComparisonResult
  let resultReason: string
  let confidence: number

  switch (expected) {
    case 'deny':
      if (!granted) {
        result = 'consistent'
        resultReason = `Denied as expected (${sObs.responseClass})`
        confidence = controls.positive ? 0.85 : 0.7
      } else if (pos && pos.observation && grantedAccess(pos.observation)) {
        result = 'inconsistent'
        resultReason = `Obtained access where denial was expected (${sObs.responseClass}); the positive control confirms the resource is access-controlled`
        confidence = controls.negative ? 0.9 : 0.8
      } else {
        result = 'inconclusive'
        resultReason = 'Access was obtained where denial was expected, but no positive control confirms the resource is normally access-controlled (it may be public)'
        confidence = 0.4
      }
      break
    case 'allow':
      if (granted) {
        result = 'consistent'
        resultReason = `Accessed as expected (${sObs.responseClass})`
        confidence = controls.positive || controls.negative ? 0.75 : 0.6
      } else {
        result = 'inconsistent'
        resultReason = `Expected access but the response was ${sObs.responseClass} (an over-restriction, not an exposure)`
        confidence = 0.5
      }
      break
    case 'limited': {
      // A "limited view expected" is only a real authorization boundary when a field-level policy is
      // DECLARED for the resource (invariant-backed). Without that evidence, two roles seeing the SAME
      // fields is not a violation — they may legitimately share full read access — so we never flag it.
      const policyDeclared = invariantRef !== null
      if (pos && pos.observation && policyDeclared) {
        const identicalToPrivileged = sObs.normalizedHash !== null && sObs.normalizedHash === pos.observation.normalizedHash
        result = identicalToPrivileged ? 'inconsistent' : 'consistent'
        resultReason = identicalToPrivileged
          ? 'Subject saw the same content as the privileged identity (not the limited view the declared field-level policy requires)'
          : 'Subject saw the limited/different view the declared field-level policy requires'
        confidence = 0.6
      } else if (pos && pos.observation) {
        result = 'inconclusive'
        resultReason = 'Subject and the privileged identity returned the same fields, but no field-level policy is declared for this resource, so an equal view is not a violation'
        confidence = 0.3
      } else {
        result = 'inconclusive'
        resultReason = 'No privileged (positive-control) arm to compare the limited view against'
        confidence = 0.3
      }
      break
    }
    default:
      result = 'inconclusive'
      resultReason = 'The expected outcome is unknown; no basis to compare against'
      confidence = 0.25
  }

  const invariantEvaluation: InvariantEvalStatus | null = invariantRef ? (result === 'consistent' ? 'supported' : result === 'inconsistent' ? 'contradicted' : 'inconclusive') : null
  return { result, resultReason, confidence, controls, semanticDifferences: diffs, invariantEvaluation }
}

/** A stable key for a comparison: its dimension and its arms (identity × resource × method × expectation). */
export function comparisonDedupeKey(dimension: ComparisonDimension, action: string, arms: readonly ComparisonArmPlan[]): string {
  const parts = arms
    .map((a) => `${a.role}:${a.identityRef ?? 'anon'}:${a.resourceRef}:${a.method}:${new URL(a.url, 'http://x').pathname}:${a.expected.outcome}`)
    .sort()
  return `${dimension}|${action}|${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`
}

/** The relationship between the subject identity and the resource it targets, from declared ownership/tenant. */
export function classifyRelationship(opts: {
  dimension: ComparisonDimension
  subjectIdentityRef: string | null
  resourceOwnerRef: string | null
  subjectTenantRef: string | null
  resourceTenantRef: string | null
}): ResourceRelationship {
  const { subjectIdentityRef, resourceOwnerRef, subjectTenantRef, resourceTenantRef } = opts
  if (opts.dimension === 'tenant-boundary') {
    if (subjectTenantRef && resourceTenantRef) return subjectTenantRef === resourceTenantRef ? 'same-tenant' : 'different-tenant'
    return 'unknown'
  }
  if (resourceOwnerRef && subjectIdentityRef) return resourceOwnerRef === subjectIdentityRef ? 'same-owner' : 'different-owner'
  if (subjectTenantRef && resourceTenantRef) return subjectTenantRef === resourceTenantRef ? 'same-tenant' : 'different-tenant'
  return 'unknown'
}
