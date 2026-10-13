import type { CandidateOrigin, FindingCategory, VerificationCheck } from '@audivra/contracts'

/*
 * Phase 6A — the deterministic, machine-checkable evidence a candidate MUST have before it can become a
 * finding. Requirements are chosen by (origin, category), never by the AI: a differential authorization
 * candidate must carry a positive AND a negative control and an inconsistent comparison result; a
 * source/runtime inconsistency must have both a source signal and an independent runtime corroboration; and
 * every candidate must have a known affected entity and no unresolved material contradiction. The verifier
 * (AI) reasons about these; it never substitutes for them.
 */

/** Categories whose truth comes from a differential comparison (controls + inconsistency). */
const COMPARISON_CATEGORIES: readonly FindingCategory[] = ['authorization', 'tenant-isolation', 'business-logic']

export function requirementsFor(origin: CandidateOrigin, category: FindingCategory): VerificationCheck[] {
  const common: VerificationCheck[] = [{ check: 'affected-entity-known' }, { check: 'no-material-contradiction' }]
  switch (origin) {
    case 'differential-comparison':
      return [
        ...common,
        { check: 'comparison-result', results: ['inconsistent'] },
        { check: 'semantic-difference' },
        { check: 'positive-control' },
        { check: 'negative-control' },
        { check: 'expectation-provenance' },
      ]
    case 'contradicted-invariant':
      return [...common, { check: 'invariant-contradicted' }, { check: 'comparison-result', results: ['inconsistent'] }, { check: 'expectation-provenance' }]
    case 'confirmed-signal-hypothesis':
      // A corroborated signal still needs an affected entity, direct evidence and two independent sensors.
      return [...common, { check: 'evidence-present', min: 1 }, { check: 'independent-corroboration', min: 2 }]
    case 'corroborated-observation':
      return [...common, { check: 'evidence-present', min: 1 }, ...categoryEvidence(category), { check: 'independent-corroboration', min: 2 }]
    case 'source-runtime-correlation':
      // The source signal AND a runtime observation that corroborates it (two independent bases).
      return [...common, { check: 'evidence-present', min: 2 }, { check: 'config-observation', observationType: 'source-finding' }, { check: 'independent-corroboration', min: 2 }]
  }
}

/** Category-specific evidence a corroborated observation must additionally carry. */
function categoryEvidence(category: FindingCategory): VerificationCheck[] {
  switch (category) {
    case 'dependency':
      return [{ check: 'dependency-evidence' }]
    case 'transport-tls':
      return [{ check: 'config-observation', observationType: 'tls-config' }]
    case 'configuration':
      return [{ check: 'config-observation', observationType: 'http-header' }]
    default:
      return []
  }
}

export { COMPARISON_CATEGORIES }
