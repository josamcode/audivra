import type { FindingComparisonEntry, SecurityAssessmentComparison, SecurityHistoricalReport } from '@audivra/contracts'

/*
 * Phase 6C — a deterministic historical report built from a persisted assessment comparison. The executive
 * summary never overstates: it states the counts, and it explicitly flags when coverage decreased so a drop
 * in findings is not read as improvement. `fixed`, `not tested`, `cannot reproduce` and `regressed` are kept
 * strictly apart.
 */

const byClass = (changes: readonly FindingComparisonEntry[], ...classes: FindingComparisonEntry['class'][]): FindingComparisonEntry[] => changes.filter((c) => classes.includes(c.class))

export function buildHistoricalReport(comparison: SecurityAssessmentComparison): SecurityHistoricalReport {
  const s = comparison.summary
  const parts = [
    `${s.fixed} fixed`,
    `${s.regressed} regressed`,
    `${s.stillPresent} still present`,
    `${s.changed} changed`,
    `${s.new} new`,
    `${s.cannotReproduce} could not be reproduced`,
    `${s.notTested} not retested`,
  ]
  const coverageNote = comparison.coverage.coverageRegressed
    ? ' Coverage decreased from the previous assessment, so a lower finding count does not necessarily mean the target is safer.'
    : ''
  const executiveSummary = `Comparing assessment ${comparison.previousEngagementId} → ${comparison.currentEngagementId}: ${parts.join(', ')}.${coverageNote}`

  return {
    previousEngagementId: comparison.previousEngagementId,
    currentEngagementId: comparison.currentEngagementId,
    generatedAt: new Date().toISOString(),
    executiveSummary,
    summary: s,
    newFindings: byClass(comparison.findingChanges, 'new'),
    fixedFindings: byClass(comparison.findingChanges, 'fixed'),
    regressedFindings: byClass(comparison.findingChanges, 'regressed'),
    changedFindings: byClass(comparison.findingChanges, 'changed'),
    cannotReproduce: byClass(comparison.findingChanges, 'cannot-reproduce', 'not-tested'),
    pathChanges: comparison.pathChanges,
    coverage: comparison.coverage,
  }
}
