import type { ComparisonCoverage, CoverageComparison, CoverageDelta, VerificationCoverage } from '@audivra/contracts'

/*
 * Phase 6C — compare the measurement coverage of two assessments. This is critical: fewer findings in a later
 * assessment can mean the site got safer OR that less was tested. By surfacing the identity/resource/
 * comparison deltas and a `coverageRegressed` flag, Audivra forces that distinction before anyone reads a
 * drop in findings as an improvement.
 */

const delta = (previous: number, current: number): CoverageDelta => ({ previous, current, delta: current - previous })

export interface AssessmentMeasurements {
  verification: VerificationCoverage
  comparison: ComparisonCoverage
  pathsTotal: number
}

export function compareCoverage(previousEngagementId: string, currentEngagementId: string, previous: AssessmentMeasurements, current: AssessmentMeasurements): CoverageComparison {
  const identitiesTested = delta(previous.comparison.entities.identities, current.comparison.entities.identities)
  const resourcesSampled = delta(previous.comparison.entities.resources, current.comparison.entities.resources)
  const comparisonsRun = delta(previous.comparison.comparisons.total, current.comparison.comparisons.total)
  const findingsTotal = delta(previous.verification.findings.total, current.verification.findings.total)
  const pathsTotal = delta(previous.pathsTotal, current.pathsTotal)

  const notes: string[] = []
  if (identitiesTested.delta < 0) notes.push(`Fewer identities tested (${identitiesTested.previous} → ${identitiesTested.current})`)
  if (resourcesSampled.delta < 0) notes.push(`Fewer resources sampled (${resourcesSampled.previous} → ${resourcesSampled.current})`)
  if (comparisonsRun.delta < 0) notes.push(`Fewer comparisons run (${comparisonsRun.previous} → ${comparisonsRun.current})`)
  const coverageRegressed = identitiesTested.delta < 0 || resourcesSampled.delta < 0 || comparisonsRun.delta < 0
  if (coverageRegressed) notes.push('Coverage decreased — interpret any reduction in findings with caution')
  else if (findingsTotal.delta < 0) notes.push('Fewer findings with equal-or-greater coverage (a likely genuine improvement)')

  return { previousEngagementId, currentEngagementId, identitiesTested, resourcesSampled, comparisonsRun, findingsTotal, pathsTotal, coverageRegressed, notes }
}
