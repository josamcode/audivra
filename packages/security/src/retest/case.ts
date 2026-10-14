import type {
  ComparisonArmPlan,
  ComparisonPlanInput,
  ReproductionFormat,
  SecurityComparison,
  SecurityFinding,
  SecurityVerificationCandidate,
  VerificationCheck,
} from '@audivra/contracts'
import type { CreateRetestCaseRecord } from '@audivra/database'

/*
 * Phase 6C — turn a verified finding into a structured, replayable retest case. The reproduction is a frozen,
 * validated comparison plan reconstructed from the finding's original comparison (the same arms, identities,
 * resources, methods and — crucially — expectations and controls). The verification requirements are the 6A
 * candidate's own machine-checkable checks, so the retest re-evaluates the ORIGINAL claim, not a new one.
 * Nothing is invented; a finding without a replayable comparison yields an observation-only / unsupported
 * case (never silently "fixable").
 */

const readCapabilityId = (method: string): string => (method === 'GET' || method === 'HEAD' ? 'access.identity-read' : 'access.identity-action')

/** Reconstruct the comparison plan (arms, controls, cleanup, state probe) from the original comparison. */
export function reproductionFromComparison(comparison: SecurityComparison): ComparisonPlanInput {
  const arms: ComparisonArmPlan[] = comparison.arms.map((a) => ({
    role: a.role,
    identityRef: a.identityRef,
    resourceRef: a.resourceRef,
    url: a.url,
    method: a.method,
    body: a.body,
    expected: a.expected,
  }))
  return {
    hypothesisId: null,
    dimension: comparison.dimension,
    resourceRef: comparison.resourceRef,
    action: comparison.action,
    invariantRef: comparison.invariantRef,
    arms,
    cleanupRequired: comparison.cleanupAction !== null,
    cleanup: comparison.cleanupAction,
    stateProbeUrl: comparison.stateProbe?.url ?? null,
    expectedTransition: comparison.stateProbe?.expectedTransition ?? null,
    reason: `Retest of ${comparison.dimension} on "${comparison.resourceRef}"`,
    coverageSampled: comparison.coverageSampled,
  }
}

export interface BuildRetestCaseInput {
  id: string
  finding: SecurityFinding
  candidate: SecurityVerificationCandidate | null
  comparison: SecurityComparison | null
}

/**
 * Build the persisted retest-case record from a finding (and its source candidate + comparison). The
 * reproduction format is `differential-comparison` when a replayable comparison exists, `observation-only`
 * when the finding is evidence-only, and `unsupported` when nothing can be reconstructed.
 */
export function buildRetestCase(input: BuildRetestCaseInput): Omit<CreateRetestCaseRecord, 'eligibility'> {
  const { finding, candidate, comparison } = input
  const reproduction = comparison ? reproductionFromComparison(comparison) : null
  const format: ReproductionFormat = reproduction && reproduction.arms.length > 0 ? 'differential-comparison' : finding.reproduction && finding.reproduction.evidenceRefs.length > 0 ? 'observation-only' : 'unsupported'

  const requiredChecks: VerificationCheck[] = candidate?.requiredChecks ?? []
  const controlsRequired = comparison
    ? { positive: comparison.controls.positive, negative: comparison.controls.negative }
    : { positive: requiredChecks.some((c) => c.check === 'positive-control'), negative: requiredChecks.some((c) => c.check === 'negative-control') }

  const identityRefs = [...new Set((reproduction?.arms ?? []).map((a) => a.identityRef).filter((r): r is string => !!r))]
  const capabilityIds = [...new Set((reproduction?.arms ?? []).map((a) => readCapabilityId(a.method)))]

  const preconditions: string[] = []
  if (format === 'differential-comparison' && reproduction) {
    const subject = reproduction.arms.find((a) => a.role === 'subject')
    if (subject?.identityRef) preconditions.push(`An active session for identity "${subject.identityRef}"`)
    if (controlsRequired.positive) {
      const pos = reproduction.arms.find((a) => a.role === 'positive-control')
      if (pos?.identityRef) preconditions.push(`A working positive control as "${pos.identityRef}" (proves the test is meaningful)`)
    }
    if (reproduction.resourceRef) preconditions.push(`Resource "${reproduction.resourceRef}" still exists`)
    if (reproduction.cleanupRequired) preconditions.push('Cleanup/rollback for a state-changing replay')
  }

  return {
    id: input.id,
    engagementId: finding.engagementId,
    findingId: finding.id,
    issueKey: finding.issueKey,
    category: finding.category,
    title: finding.title,
    reproductionFormat: format,
    affectedEntityKeys: finding.affectedEntities.map((e) => e.key),
    identityRefs,
    resourceRef: comparison?.resourceRef ?? null,
    action: comparison?.action ?? null,
    invariantRef: comparison?.invariantRef ?? (finding.invariantRefs[0] ?? null),
    sourceComparisonId: comparison?.id ?? finding.reproduction?.comparisonId ?? null,
    reproduction,
    requiredChecks,
    controlsRequired,
    preconditions,
    capabilityIds,
    cleanupRequired: reproduction?.cleanupRequired ?? false,
    originalEvidenceRefs: finding.evidenceRefs,
    originalSeverity: finding.severity,
    planned: false,
    plannedReason: null,
  }
}
