import type { Logger } from '@audivra/config'
import type { SecurityActor, SecurityAssessmentComparison, SecurityEventType, SecurityFinding } from '@audivra/contracts'
import { FINDING_WORTHY_STATES } from '@audivra/contracts'
import {
  getEngagementRow,
  listAnalystDecisions,
  listAttackPathsForEngagement,
  listFindingsForEngagement,
  listRetestResultsByIssueKey,
  loadGraphRows,
  newAssessmentComparisonId,
  recordSecurityEvent,
  toAssessmentComparison,
  toGraphEdge,
  toGraphNode,
  upsertAssessmentComparison,
  type Db,
} from '@audivra/database'
import { comparisonCoverage } from '../comparison/coverage.ts'
import { FindingReadService } from '../verification/read.ts'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import { classifyFindings, summarizeFindingChanges } from './compare.ts'
import { compareCoverage, type AssessmentMeasurements } from './coverage.ts'
import { diffGraph } from './graph.ts'
import { matchFindings, type ManualLink } from './match.ts'
import { diffAttackPaths } from './paths.ts'

/*
 * Phase 6C — compare two authorized assessments into a persisted historical comparison. It assembles the
 * finding classification (exact-key then cautious semantic matching, with manual analyst links honoured), the
 * attack-path diff, the important graph changes and the coverage comparison. A finding absent from the current
 * assessment is never classified fixed without a retest result; coverage changes are surfaced alongside the
 * counts so a reduction in findings is never silently read as improvement.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export interface HistoryServiceOptions {
  db: Db
  now?: () => Date
  log?: Logger
}

export class HistoryService {
  readonly #db: Db
  readonly #findings: FindingReadService
  readonly #log: Logger | undefined

  constructor(options: HistoryServiceOptions) {
    this.#db = options.db
    this.#findings = new FindingReadService({ db: options.db })
    this.#log = options.log
  }

  async compareAssessments(previousEngagementId: string, currentEngagementId: string, options: { persist?: boolean } = {}): Promise<SecurityAssessmentComparison> {
    const previous = await this.#engagement(previousEngagementId)
    const current = await this.#engagement(currentEngagementId)
    if (previous.id === current.id) throw new SecurityRequestError(400, 'Cannot compare an assessment with itself')

    const prevFindings = (await listFindingsForEngagement(this.#db, previous.id)).filter((f) => FINDING_WORTHY_STATES.includes(f.verificationState))
    const curFindings = (await listFindingsForEngagement(this.#db, current.id)).filter((f) => FINDING_WORTHY_STATES.includes(f.verificationState))

    const manualLinks = await this.#manualLinks(current.id)
    const retestsByIssueKey = await this.#retestsByIssueKey([...prevFindings, ...curFindings])

    const [prevMeasure, curMeasure] = await Promise.all([this.#measurements(previous.id), this.#measurements(current.id)])
    const coverage = compareCoverage(previous.id, current.id, prevMeasure, curMeasure)

    const matches = matchFindings(prevFindings, curFindings, manualLinks)
    const findingChanges = classifyFindings(prevFindings, curFindings, matches, { retestsByIssueKey, coverageRegressed: coverage.coverageRegressed })
    const summary = summarizeFindingChanges(findingChanges)

    const [prevPaths, curPaths] = await Promise.all([listAttackPathsForEngagement(this.#db, previous.id), listAttackPathsForEngagement(this.#db, current.id)])
    const pathChanges = diffAttackPaths(prevPaths.filter((p) => !p.dominatedBy), curPaths.filter((p) => !p.dominatedBy))

    const [prevGraph, curGraph] = await Promise.all([this.#graphSnapshot(previous.id), this.#graphSnapshot(current.id)])
    const graphChanges = diffGraph(prevGraph, curGraph)

    if (options.persist === false) {
      return { id: 'transient', previousEngagementId: previous.id, currentEngagementId: current.id, summary, findingChanges, pathChanges, graphChanges, coverage, createdAt: new Date().toISOString() }
    }
    const row = await upsertAssessmentComparison(this.#db, { id: newAssessmentComparisonId(), previousEngagementId: previous.id, currentEngagementId: current.id, summary, findingChanges, pathChanges, graphChanges, coverage })
    await this.#event(current.id, 'history.comparison-created', `Compared assessment ${previous.id} → ${current.id}: ${summary.fixed} fixed, ${summary.regressed} regressed, ${summary.stillPresent} still present, ${summary.new} new`, { previousEngagementId: previous.id, ...summary })
    this.#log?.info({ previousEngagementId: previous.id, currentEngagementId: current.id, ...summary }, 'assessment comparison computed')
    return toAssessmentComparison(row)
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }

  async #manualLinks(currentEngagementId: string): Promise<ManualLink[]> {
    const decisions = await listAnalystDecisions(this.#db, currentEngagementId, {})
    return decisions
      .filter((d) => d.kind === 'link-historical' && d.relatedRef)
      .map((d) => ({ previousIssueKey: d.subjectRef, currentIssueKey: d.relatedRef! }))
  }

  async #retestsByIssueKey(findings: SecurityFinding[]) {
    const keys = [...new Set(findings.map((f) => f.issueKey))]
    const map = new Map<string, Awaited<ReturnType<typeof listRetestResultsByIssueKey>>>()
    for (const key of keys) map.set(key, await listRetestResultsByIssueKey(this.#db, key))
    return map
  }

  async #measurements(engagementId: string): Promise<AssessmentMeasurements> {
    const [verification, comparison, paths] = await Promise.all([this.#findings.coverage(engagementId), comparisonCoverage(this.#db, engagementId), listAttackPathsForEngagement(this.#db, engagementId)])
    return { verification, comparison, pathsTotal: paths.filter((p) => !p.dominatedBy).length }
  }

  async #graphSnapshot(engagementId: string) {
    const rows = await loadGraphRows(this.#db, engagementId)
    const keys = new Map(rows.nodes.map((n) => [n.id, n.key]))
    return { nodes: rows.nodes.map(toGraphNode), edges: rows.edges.map((e) => toGraphEdge(e, keys)) }
  }

  async #event(engagementId: string, type: SecurityEventType, message: string, data: Record<string, unknown>, actor: SecurityActor = LOCAL_USER): Promise<void> {
    const engagement = await getEngagementRow(this.#db, engagementId)
    await recordSecurityEvent(this.#db, { engagementId, type, level: 'info', message, actor, configVersion: engagement?.configVersion ?? 0, data })
  }
}
