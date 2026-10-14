import type { ResearchCoverageSnapshot, ResidualUncertainty } from '@audivra/contracts'
import { listAttackPathsForEngagement, listKnowledgeGaps, listSpecialistRunsForEngagement, type Db } from '@audivra/database'
import { comparisonCoverage } from '../comparison/coverage.ts'
import { FindingReadService } from '../verification/read.ts'

/*
 * Phase 6E — a bounded numeric coverage snapshot assembled from the EXISTING coverage services (never a new
 * measurement system), plus an honest residual-uncertainty statement. A research run never claims a complete
 * penetration test: it reports what was tested, partially tested, not tested and still unknown.
 */

export async function coverageSnapshot(db: Db, engagementId: string): Promise<ResearchCoverageSnapshot> {
  const findings = new FindingReadService({ db })
  const [verification, comparison, paths, gaps, specialist] = await Promise.all([
    findings.coverage(engagementId),
    comparisonCoverage(db, engagementId),
    listAttackPathsForEngagement(db, engagementId),
    listKnowledgeGaps(db, engagementId, { status: 'open' }),
    listSpecialistRunsForEngagement(db, engagementId),
  ])
  const by = (m: Record<string, number>, k: string) => m[k] ?? 0
  return {
    findings: verification.findings.total,
    verifiedFindings: by(verification.findings.byVerification, 'verified'),
    supportedFindings: by(verification.findings.byVerification, 'supported'),
    comparisons: comparison.comparisons.total,
    identitiesTested: comparison.entities.identities,
    resourcesSampled: comparison.entities.resources,
    attackPaths: paths.filter((p) => !p.dominatedBy).length,
    openGaps: gaps.length,
    specialistRuns: specialist.length,
  }
}

export async function residualUncertainty(db: Db, engagementId: string, snapshot: ResearchCoverageSnapshot): Promise<ResidualUncertainty> {
  const gaps = await listKnowledgeGaps(db, engagementId, { status: 'open' })
  const gapKinds = [...new Set(gaps.map((g) => g.kind))].slice(0, 12)
  const tested: string[] = []
  const partiallyTested: string[] = []
  const notTested: string[] = []
  const unknown: string[] = []

  if (snapshot.comparisons > 0) tested.push(`authorization/business boundaries (${snapshot.comparisons} controlled comparison${snapshot.comparisons === 1 ? '' : 's'}, ${snapshot.identitiesTested} identit${snapshot.identitiesTested === 1 ? 'y' : 'ies'})`)
  else notTested.push('authorization/business boundaries (no controlled comparison ran)')
  if (snapshot.verifiedFindings + snapshot.supportedFindings > 0) tested.push(`${snapshot.verifiedFindings} verified + ${snapshot.supportedFindings} supported finding(s)`)
  if (snapshot.attackPaths > 0) tested.push(`${snapshot.attackPaths} evidence-backed attack path(s)`)
  if (snapshot.specialistRuns > 0) partiallyTested.push(`${snapshot.specialistRuns} specialist research run(s) (results are signals, not verdicts)`)
  if (snapshot.openGaps > 0) partiallyTested.push(`${snapshot.openGaps} open knowledge gap(s) awaiting corroboration`)
  for (const k of gapKinds) unknown.push(k)
  if (!unknown.length) unknown.push('No tracked open knowledge gaps, but coverage is representative — not exhaustive.')

  return { tested, partiallyTested, notTested, unknown }
}
