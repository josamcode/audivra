import type { RetestCase, RetestState, SecurityComparison, Severity, VerificationCheck, VerificationCheckResult } from '@audivra/contracts'
import { classifyComparison } from '../comparison/classify.ts'

/*
 * Phase 6C — the deterministic heart of retesting, and the single guarantee that a "fix" is never asserted
 * without positive evidence of remediation.
 *
 * A finding is FIXED only when: the retest actually ran, the subject executed, the positive control STILL
 * proves the test meaningful, and the vulnerable behaviour is now absent (the fresh comparison is consistent).
 * If the control no longer works, the behaviour cannot be established, or the subject did not execute, the
 * result is CANNOT_REPRODUCE / BLOCKED / INCONCLUSIVE — never FIXED. A timeout, a missing session, an
 * unavailable tool or a changed route is a gap, never a fix.
 *
 * REGRESSED and CHANGED are decided one layer up (they need the issue's history / cross-assessment continuity);
 * this returns STILL_PRESENT for "present again", which the service may relabel REGRESSED given the timeline.
 */

export interface RetestClassification {
  state: RetestState
  reason: string
  controlValid: boolean
  severityNow: Severity | null
}

export function classifyRetest(fresh: SecurityComparison, testCase: Pick<RetestCase, 'controlsRequired' | 'originalSeverity'>): RetestClassification {
  const subject = fresh.arms.find((a) => a.role === 'subject') ?? fresh.arms[0]
  const positiveRequired = testCase.controlsRequired.positive
  const controlValid = fresh.controls.positive

  // The whole comparison, or the subject arm, could not run → blocked (never a fix).
  if (fresh.status === 'blocked' || fresh.result === 'blocked') {
    return { state: 'blocked', reason: `The replay was blocked: ${fresh.resultReason}`, controlValid: false, severityNow: null }
  }
  if (!subject || subject.status === 'blocked') {
    return { state: 'blocked', reason: subject?.statusReason ?? 'The subject arm was blocked', controlValid: false, severityNow: null }
  }
  if (subject.status !== 'executed') {
    return { state: 'cannot-reproduce', reason: `The subject arm did not execute (${subject.statusReason ?? subject.status}); the condition could not be reconstructed`, controlValid: false, severityNow: null }
  }

  // The positive control was part of what made the original finding trustworthy, and it no longer works →
  // the test itself is broken (e.g. auth changed, resource gone): we cannot tell a fix from a broken test.
  if (positiveRequired && !controlValid) {
    return {
      state: 'cannot-reproduce',
      reason: 'The positive control no longer establishes the baseline, so a fix cannot be distinguished from a broken reproduction',
      controlValid: false,
      severityNow: null,
    }
  }

  switch (fresh.result) {
    case 'inconsistent':
      // The vulnerable behaviour is still observed with a meaningful control → still present.
      return { state: 'still-present', reason: `The vulnerable behaviour was reproduced (${fresh.resultReason})`, controlValid, severityNow: testCase.originalSeverity }
    case 'consistent':
      // The behaviour now matches the boundary (the subject is denied where it was granted) AND the control
      // still works → this is the only path to FIXED.
      return { state: 'fixed', reason: `The vulnerable behaviour is no longer present and the positive control still works (${fresh.resultReason})`, controlValid, severityNow: null }
    case 'inconclusive':
      return { state: 'inconclusive', reason: `The replay was inconclusive: ${fresh.resultReason}`, controlValid, severityNow: null }
    case 'not-tested':
      return { state: 'not-tested', reason: fresh.resultReason || 'The comparison did not run', controlValid: false, severityNow: null }
    default:
      return { state: 'inconclusive', reason: fresh.resultReason, controlValid, severityNow: null }
  }
}

/**
 * Re-evaluate the ORIGINAL 6A verification requirements against the fresh comparison evidence. This reuses the
 * same requirement vocabulary the Verification Engine used to synthesize the finding — so a retest answers
 * "do the checks that made this a finding still hold?" rather than inventing a new claim. Only the
 * comparison-backed checks are evaluated against a single fresh comparison; non-comparison checks are reported
 * as not-applicable (met=false, clearly explained), since a controlled retest re-establishes them via the
 * comparison itself.
 */
export function reevaluateChecks(requiredChecks: VerificationCheck[], fresh: SecurityComparison): VerificationCheckResult[] {
  return requiredChecks.map((check, index): VerificationCheckResult => {
    const base = { index, check: check.check }
    switch (check.check) {
      case 'positive-control':
        return { ...base, met: fresh.controls.positive, detail: `Positive control ${fresh.controls.positive ? 'still works' : 'no longer works'} on replay`, evidenceRefs: [] }
      case 'negative-control':
        return { ...base, met: fresh.controls.negative, detail: `Negative control ${fresh.controls.negative ? 'present' : 'absent'} on replay`, evidenceRefs: [] }
      case 'comparison-result':
        return { ...base, met: fresh.status === 'completed' && check.results.includes(fresh.result), detail: `Replay → ${fresh.result} (needs ${check.results.join('/')})`, evidenceRefs: fresh.evidenceRefs.slice(0, 20) }
      case 'invariant-contradicted':
        return { ...base, met: fresh.invariantEvaluation === 'contradicted', detail: `Replay invariant evaluation: ${fresh.invariantEvaluation ?? 'none'}`, evidenceRefs: [] }
      case 'semantic-difference': {
        const relevant = fresh.semanticDifferences.filter((d) => d.securityRelevant)
        return { ...base, met: relevant.length > 0, detail: relevant.length ? `${relevant.length} security-relevant difference(s) on replay` : 'No security-relevant difference on replay', evidenceRefs: [] }
      }
      case 'expectation-provenance': {
        const subject = fresh.arms.find((a) => a.role === 'subject')
        const basis = subject?.expected.basis ?? 'unknown'
        const grounded = basis === 'declared' || basis === 'code-derived' || basis === 'observed'
        return { ...base, met: grounded, detail: `Expectation basis on replay: ${basis}`, evidenceRefs: [] }
      }
      case 'evidence-present':
        return { ...base, met: fresh.evidenceRefs.length >= check.min, detail: `${fresh.evidenceRefs.length} fresh evidence artifact(s); needs ${check.min}`, evidenceRefs: fresh.evidenceRefs.slice(0, 20) }
      case 'no-material-contradiction':
        return { ...base, met: fresh.result !== 'inconclusive', detail: fresh.result === 'inconclusive' ? 'The replay was inconclusive' : 'No material contradiction on replay', evidenceRefs: [] }
      case 'affected-entity-known':
        return { ...base, met: true, detail: 'Affected entity carried over from the original finding', evidenceRefs: [] }
      default:
        return { ...base, met: false, detail: `Check "${check.check}" is re-established by the controlled retest, not evaluated standalone`, evidenceRefs: [] }
    }
  })
}

// Keep the classifier total over comparison dimensions by re-exporting the Phase 5 classifier (used by the
// executor when it needs to classify a freshly-assembled arm set without persisting a comparison).
export { classifyComparison }
