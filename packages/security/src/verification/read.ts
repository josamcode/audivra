import type {
  FindingCategory,
  FindingStatus,
  SecurityAssessmentReport,
  SecurityFinding,
  SecurityFindingDetail,
  SecurityVerificationCandidate,
  VerificationCoverage,
  VerificationState,
} from '@audivra/contracts'
import { FINDING_WORTHY_STATES } from '@audivra/contracts'
import {
  getFindingRow,
  listCandidatesForEngagement,
  listComparisonsForEngagement,
  listFindingsForEngagement,
  listHypothesisRows,
  listSecurityEvidence,
  toFinding,
  toHypothesis,
  type Db,
} from '@audivra/database'
import { SecurityRequestError } from '../service.ts'

/*
 * Phase 6A read side — findings, candidates, coverage and the assessment report, built ONLY from persisted
 * state (never by re-running the AI or any capability). The report keeps verified findings, supported
 * signals, open investigation and coverage apart: a supported signal is honestly not a verified finding, and
 * an inconclusive or blocked candidate is shown as open work, never dressed up as a result.
 */

export class FindingReadService {
  readonly #db: Db

  constructor(options: { db: Db }) {
    this.#db = options.db
  }

  async listFindings(engagementId: string, filters: { category?: FindingCategory; status?: FindingStatus; verificationState?: VerificationState } = {}): Promise<SecurityFinding[]> {
    const findings = await listFindingsForEngagement(this.#db, engagementId)
    return findings.filter(
      (f) => (!filters.category || f.category === filters.category) && (!filters.status || f.status === filters.status) && (!filters.verificationState || f.verificationState === filters.verificationState),
    )
  }

  async listCandidates(engagementId: string, filters: { status?: VerificationState } = {}): Promise<SecurityVerificationCandidate[]> {
    const candidates = await listCandidatesForEngagement(this.#db, engagementId)
    return filters.status ? candidates.filter((c) => c.status === filters.status) : candidates
  }

  async getFinding(findingId: string): Promise<SecurityFindingDetail> {
    const row = await getFindingRow(this.#db, findingId)
    if (!row) throw new SecurityRequestError(404, `No security finding ${findingId}`)
    const finding = toFinding(row)
    const [candidates, evidenceItems, hypothesisRows, comparisons] = await Promise.all([
      listCandidatesForEngagement(this.#db, finding.engagementId),
      listSecurityEvidence(this.#db, finding.engagementId),
      listHypothesisRows(this.#db, finding.engagementId, { limit: 500 }),
      listComparisonsForEngagement(this.#db, finding.engagementId),
    ])
    const evidenceByRef = new Map(evidenceItems.map((e) => [e.ref, e]))
    const evidence = finding.evidenceRefs
      .map((ref) => evidenceByRef.get(ref))
      .filter((e) => !!e)
      .map((e) => ({ ref: e!.ref, type: e!.type, title: e!.title, identityRef: e!.provenance.identityRef, sessionRef: e!.provenance.sessionRef }))
    const hypotheses = hypothesisRows
      .map((h) => toHypothesis(h, []))
      .filter((h) => finding.hypothesisIds.includes(h.id))
      .map((h) => ({ id: h.id, claim: h.claim, status: h.status }))
    const relatedComparisons = comparisons.filter((c) => finding.comparisonIds.includes(c.id)).map((c) => ({ id: c.id, dimension: c.dimension, result: c.result }))
    return {
      finding,
      candidates: candidates.filter((c) => c.findingId === findingId || c.issueKey === finding.issueKey),
      evidence,
      hypotheses,
      comparisons: relatedComparisons,
    }
  }

  async coverage(engagementId: string): Promise<VerificationCoverage> {
    const [candidates, findings] = await Promise.all([listCandidatesForEngagement(this.#db, engagementId), listFindingsForEngagement(this.#db, engagementId)])
    const tally = <T extends string>(items: readonly T[]): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const k of items) out[k] = (out[k] ?? 0) + 1
      return out
    }
    return {
      candidates: { total: candidates.length, byStatus: tally(candidates.map((c) => c.status)) },
      findings: {
        total: findings.length,
        byCategory: tally(findings.map((f) => f.category)),
        bySeverity: tally(findings.map((f) => f.severity)),
        byVerification: tally(findings.map((f) => f.verificationState)),
        byStatus: tally(findings.map((f) => f.status)),
      },
    }
  }

  /** The assessment report: verified findings, supported signals and open investigation kept strictly apart. */
  async report(engagementId: string): Promise<SecurityAssessmentReport> {
    const [findings, candidates, coverage] = await Promise.all([listFindingsForEngagement(this.#db, engagementId), listCandidatesForEngagement(this.#db, engagementId), this.coverage(engagementId)])
    const openStates: VerificationState[] = ['unverified', 'needs-evidence', 'inconclusive', 'blocked']
    return {
      engagementId,
      generatedAt: new Date().toISOString(),
      verifiedFindings: findings.filter((f) => f.verificationState === 'verified'),
      supportedSignals: findings.filter((f) => f.verificationState === 'supported'),
      openInvestigation: candidates.filter((c) => openStates.includes(c.status) && !FINDING_WORTHY_STATES.includes(c.status)),
      coverage,
    }
  }
}
