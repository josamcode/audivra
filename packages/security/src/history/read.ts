import type { Logger } from '@audivra/config'
import type {
  AnalystDecision,
  AnalystDecisionInput,
  FindingLineage,
  FindingTimelineEntry,
  RetestCase,
  RetestResult,
  SecurityActor,
  SecurityAssessmentComparison,
  SecurityHistoricalReport,
} from '@audivra/contracts'
import {
  findAssessmentComparison,
  getEngagementRow,
  getFindingRow,
  getRetestResultRow,
  findFindingByIssueKey,
  insertAnalystDecision,
  listAnalystDecisions as listAnalystDecisionRows,
  listRetestCasesForEngagement,
  listRetestResultsByIssueKey,
  listRetestResultsForEngagement,
  newAnalystDecisionId,
  recordSecurityEvent,
  toAssessmentComparison,
  toFinding,
  toRetestResult,
  type Db,
} from '@audivra/database'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import { HistoryService } from './service.ts'
import { buildHistoricalReport } from './report.ts'

/*
 * Phase 6C read surface: retest cases/results, a finding's cross-assessment lineage/timeline, the persisted
 * assessment comparison (computed on demand when absent), the historical report, and the analyst-decision
 * audit trail. Everything is built from persisted state; nothing re-runs a retest, the AI or a capability.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export class HistoryReadService {
  readonly #db: Db
  readonly #history: HistoryService

  constructor(options: { db: Db; log?: Logger }) {
    this.#db = options.db
    this.#history = new HistoryService({ db: options.db, log: options.log })
  }

  async listRetestCases(engagementId: string): Promise<RetestCase[]> {
    await this.#engagement(engagementId)
    return listRetestCasesForEngagement(this.#db, engagementId)
  }

  async listRetestResults(engagementId: string, filters: { issueKey?: string; findingId?: string } = {}): Promise<RetestResult[]> {
    await this.#engagement(engagementId)
    const results = await listRetestResultsForEngagement(this.#db, engagementId)
    return results.filter((r) => (!filters.issueKey || r.issueKey === filters.issueKey) && (!filters.findingId || r.findingId === filters.findingId))
  }

  async getRetestResult(id: string): Promise<RetestResult> {
    const row = await getRetestResultRow(this.#db, id)
    if (!row) throw new SecurityRequestError(404, `No retest result ${id}`)
    return toRetestResult(row)
  }

  /** The cross-assessment timeline for a finding's issue (derived from findings + retest results, never overwritten). */
  async findingLineage(findingId: string): Promise<FindingLineage> {
    const row = await getFindingRow(this.#db, findingId)
    if (!row) throw new SecurityRequestError(404, `No finding ${findingId}`)
    const finding = toFinding(row)
    const retests = await listRetestResultsByIssueKey(this.#db, finding.issueKey)

    const engagementIds = [...new Set([finding.engagementId, ...retests.flatMap((r) => [r.sourceEngagementId, r.engagementId])])]
    const findingEntries: FindingTimelineEntry[] = []
    for (const eid of engagementIds) {
      const fr = await findFindingByIssueKey(this.#db, eid, finding.issueKey)
      if (!fr) continue
      const f = toFinding(fr)
      findingEntries.push({ engagementId: eid, assessmentAt: f.createdAt, findingId: f.id, verificationState: f.verificationState, severity: f.severity, retestResultId: null, retestState: null, matchBasis: 'exact-issue-key', changes: [], reason: `Assessment ${eid}: ${f.verificationState}` })
    }
    const retestEntries: FindingTimelineEntry[] = retests.map((r) => ({
      engagementId: r.engagementId,
      assessmentAt: r.createdAt,
      findingId: r.findingId,
      verificationState: null,
      severity: r.severityNow,
      retestResultId: r.id,
      retestState: r.state,
      matchBasis: 'exact-issue-key',
      changes: [],
      reason: r.reason,
    }))
    const entries = [...findingEntries, ...retestEntries].sort((a, b) => a.assessmentAt.localeCompare(b.assessmentAt))
    const severities = findingEntries.map((e) => e.severity).filter((s): s is NonNullable<typeof s> => !!s)
    return { issueKey: finding.issueKey, title: finding.title, category: finding.category, originalSeverity: severities[0] ?? finding.severity, currentSeverity: severities[severities.length - 1] ?? finding.severity, entries }
  }

  /** Get a persisted assessment comparison, computing + persisting it when none exists yet. */
  async assessmentComparison(previousEngagementId: string, currentEngagementId: string): Promise<SecurityAssessmentComparison> {
    const existing = await findAssessmentComparison(this.#db, previousEngagementId, currentEngagementId)
    if (existing) return toAssessmentComparison(existing)
    return this.#history.compareAssessments(previousEngagementId, currentEngagementId, { persist: true })
  }

  async report(previousEngagementId: string, currentEngagementId: string): Promise<SecurityHistoricalReport> {
    return buildHistoricalReport(await this.assessmentComparison(previousEngagementId, currentEngagementId))
  }

  async listAnalystDecisions(engagementId: string, subjectRef?: string): Promise<AnalystDecision[]> {
    await this.#engagement(engagementId)
    return listAnalystDecisionRows(this.#db, engagementId, subjectRef ? { subjectRef } : {})
  }

  /** Record a manual analyst decision (link/unlink/accept-risk/note). It never changes underlying evidence. */
  async recordAnalystDecision(engagementId: string, input: AnalystDecisionInput, actor: SecurityActor = LOCAL_USER): Promise<AnalystDecision> {
    const engagement = await this.#engagement(engagementId)
    const row = await insertAnalystDecision(this.#db, {
      id: newAnalystDecisionId(),
      engagementId,
      kind: input.kind,
      subjectRef: input.subjectRef,
      relatedRef: input.relatedRef,
      note: input.note,
      actorId: actor.id ?? null,
    })
    await recordSecurityEvent(this.#db, { engagementId, type: 'history.analyst-decision', level: 'info', message: `Analyst decision (${input.kind}): ${input.subjectRef}`, actor, configVersion: engagement.configVersion, data: { kind: input.kind, subjectRef: input.subjectRef } })
    return { id: row.id, engagementId, kind: row.kind, subjectRef: row.subjectRef, relatedRef: row.relatedRef ?? null, note: row.note, actorId: row.actorId ?? null, createdAt: row.createdAt.toISOString() }
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }
}
