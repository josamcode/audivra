import { and, asc, desc, eq } from 'drizzle-orm'
import type {
  AnalystDecision,
  AnalystDecisionKind,
  AssessmentComparisonSummary,
  AttackPathDiffEntry,
  CapabilityVersionRef,
  ComparisonPlanInput,
  ComparisonResult,
  CoverageComparison,
  FindingCategory,
  FindingComparisonEntry,
  GraphChangeEntry,
  RetestAdaptation,
  RetestCase,
  RetestEligibility,
  RetestResult,
  RetestState,
  ReproductionFormat,
  SecurityAssessmentComparison,
  Severity,
  VerificationCheck,
  VerificationCheckResult,
} from '@audivra/contracts'
import { newId } from '../ids.ts'
import { securityAnalystDecisions, securityAssessmentComparisons, securityRetestCases, securityRetestResults } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Phase 6C persistence. Four tables, all reference-only (ids, issue/path keys, entity keys) — never secret
 * material. The repo stores what the retest/history engines computed; it never decides a retest state or a
 * historical classification.
 */

export type RetestCaseRow = typeof securityRetestCases.$inferSelect
export type RetestResultRow = typeof securityRetestResults.$inferSelect
export type AssessmentComparisonRow = typeof securityAssessmentComparisons.$inferSelect
export type AnalystDecisionRow = typeof securityAnalystDecisions.$inferSelect

export const newRetestCaseId = () => newId('rc')
export const newRetestResultId = () => newId('rr')
export const newAssessmentComparisonId = () => newId('sac')
export const newAnalystDecisionId = () => newId('ad')

// ── Retest cases ────────────────────────────────────────────────────────────────────────────────────────

export function toRetestCase(row: RetestCaseRow): RetestCase {
  return {
    id: row.id,
    engagementId: row.engagementId,
    findingId: row.findingId,
    issueKey: row.issueKey,
    category: row.category,
    title: row.title,
    reproductionFormat: row.reproductionFormat,
    affectedEntityKeys: row.affectedEntityKeys,
    identityRefs: row.identityRefs,
    resourceRef: row.resourceRef ?? null,
    action: row.action ?? null,
    invariantRef: row.invariantRef ?? null,
    sourceComparisonId: row.sourceComparisonId ?? null,
    reproduction: row.reproduction ?? null,
    requiredChecks: row.requiredChecks,
    controlsRequired: row.controlsRequired,
    preconditions: row.preconditions,
    capabilityIds: row.capabilityIds,
    cleanupRequired: row.cleanupRequired,
    originalEvidenceRefs: row.originalEvidenceRefs,
    originalSeverity: row.originalSeverity,
    eligibility: row.eligibility,
    planned: row.planned,
    plannedReason: row.plannedReason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface CreateRetestCaseRecord {
  id: string
  engagementId: string
  findingId: string
  issueKey: string
  category: FindingCategory
  title: string
  reproductionFormat: ReproductionFormat
  affectedEntityKeys: string[]
  identityRefs: string[]
  resourceRef: string | null
  action: string | null
  invariantRef: string | null
  sourceComparisonId: string | null
  reproduction: ComparisonPlanInput | null
  requiredChecks: VerificationCheck[]
  controlsRequired: { positive: boolean; negative: boolean }
  preconditions: string[]
  capabilityIds: string[]
  cleanupRequired: boolean
  originalEvidenceRefs: string[]
  originalSeverity: Severity
  eligibility: RetestEligibility
  planned: boolean
  plannedReason: string | null
}

export interface RetestCasePatch {
  title?: string
  reproductionFormat?: ReproductionFormat
  reproduction?: ComparisonPlanInput | null
  requiredChecks?: VerificationCheck[]
  controlsRequired?: { positive: boolean; negative: boolean }
  preconditions?: string[]
  capabilityIds?: string[]
  eligibility?: RetestEligibility
  planned?: boolean
  plannedReason?: string | null
}

export async function insertRetestCase(db: DbOrTx, input: CreateRetestCaseRecord): Promise<RetestCaseRow> {
  const [row] = await db
    .insert(securityRetestCases)
    .values({ ...input, title: input.title.slice(0, 300) })
    .returning()
  if (!row) throw new Error('Failed to record retest case')
  return row
}

export async function updateRetestCase(db: DbOrTx, id: string, patch: RetestCasePatch): Promise<RetestCaseRow | undefined> {
  const [row] = await db
    .update(securityRetestCases)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securityRetestCases.id, id))
    .returning()
  return row
}

export async function getRetestCaseRow(db: DbOrTx, id: string): Promise<RetestCaseRow | undefined> {
  const [row] = await db.select().from(securityRetestCases).where(eq(securityRetestCases.id, id))
  return row
}

export async function findRetestCaseByFinding(db: DbOrTx, engagementId: string, findingId: string): Promise<RetestCaseRow | undefined> {
  const [row] = await db
    .select()
    .from(securityRetestCases)
    .where(and(eq(securityRetestCases.engagementId, engagementId), eq(securityRetestCases.findingId, findingId)))
  return row
}

export async function listRetestCaseRows(db: DbOrTx, engagementId: string, limit = 2000): Promise<RetestCaseRow[]> {
  return db
    .select()
    .from(securityRetestCases)
    .where(eq(securityRetestCases.engagementId, engagementId))
    .orderBy(asc(securityRetestCases.createdAt))
    .limit(Math.min(limit, 2000))
}

export async function listRetestCasesForEngagement(db: DbOrTx, engagementId: string, limit = 2000): Promise<RetestCase[]> {
  return (await listRetestCaseRows(db, engagementId, limit)).map(toRetestCase)
}

// ── Retest results ──────────────────────────────────────────────────────────────────────────────────────

export function toRetestResult(row: RetestResultRow): RetestResult {
  return {
    id: row.id,
    engagementId: row.engagementId,
    retestCaseId: row.retestCaseId,
    findingId: row.findingId,
    issueKey: row.issueKey,
    sourceEngagementId: row.sourceEngagementId,
    state: row.state,
    reason: row.reason,
    freshComparisonId: row.freshComparisonId ?? null,
    freshResult: row.freshResult ?? null,
    controlValid: row.controlValid,
    checkResults: row.checkResults,
    executionIds: row.executionIds,
    identityRefs: row.identityRefs,
    evidenceRefs: row.evidenceRefs,
    capabilityVersions: row.capabilityVersions,
    adaptation: row.adaptation ?? null,
    severityNow: row.severityNow ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export interface CreateRetestResultRecord {
  id: string
  engagementId: string
  retestCaseId: string
  findingId: string
  issueKey: string
  sourceEngagementId: string
  state: RetestState
  reason: string
  freshComparisonId: string | null
  freshResult: ComparisonResult | null
  controlValid: boolean
  checkResults: VerificationCheckResult[]
  executionIds: string[]
  identityRefs: string[]
  evidenceRefs: string[]
  capabilityVersions: CapabilityVersionRef[]
  adaptation: RetestAdaptation | null
  severityNow: Severity | null
}

export async function insertRetestResult(db: DbOrTx, input: CreateRetestResultRecord): Promise<RetestResultRow> {
  const [row] = await db.insert(securityRetestResults).values(input).returning()
  if (!row) throw new Error('Failed to record retest result')
  return row
}

export async function getRetestResultRow(db: DbOrTx, id: string): Promise<RetestResultRow | undefined> {
  const [row] = await db.select().from(securityRetestResults).where(eq(securityRetestResults.id, id))
  return row
}

export async function listRetestResultRows(
  db: DbOrTx,
  engagementId: string,
  options: { issueKey?: string; findingId?: string; limit?: number } = {},
): Promise<RetestResultRow[]> {
  return db
    .select()
    .from(securityRetestResults)
    .where(
      and(
        eq(securityRetestResults.engagementId, engagementId),
        options.issueKey ? eq(securityRetestResults.issueKey, options.issueKey) : undefined,
        options.findingId ? eq(securityRetestResults.findingId, options.findingId) : undefined,
      ),
    )
    .orderBy(desc(securityRetestResults.createdAt))
    .limit(Math.min(options.limit ?? 1000, 5000))
}

export async function listRetestResultsForEngagement(db: DbOrTx, engagementId: string, limit = 2000): Promise<RetestResult[]> {
  return (await listRetestResultRows(db, engagementId, { limit })).map(toRetestResult)
}

/** Retest results anywhere that concern a given issue key (used to assemble a finding's cross-assessment timeline). */
export async function listRetestResultsByIssueKey(db: DbOrTx, issueKey: string, limit = 2000): Promise<RetestResult[]> {
  const rows = await db
    .select()
    .from(securityRetestResults)
    .where(eq(securityRetestResults.issueKey, issueKey))
    .orderBy(asc(securityRetestResults.createdAt))
    .limit(Math.min(limit, 5000))
  return rows.map(toRetestResult)
}

// ── Assessment comparisons ──────────────────────────────────────────────────────────────────────────────

export function toAssessmentComparison(row: AssessmentComparisonRow): SecurityAssessmentComparison {
  return {
    id: row.id,
    previousEngagementId: row.previousEngagementId,
    currentEngagementId: row.currentEngagementId,
    summary: row.summary,
    findingChanges: row.findingChanges,
    pathChanges: row.pathChanges,
    graphChanges: row.graphChanges,
    coverage: row.coverage,
    createdAt: row.createdAt.toISOString(),
  }
}

export interface CreateAssessmentComparisonRecord {
  id: string
  previousEngagementId: string
  currentEngagementId: string
  summary: AssessmentComparisonSummary
  findingChanges: FindingComparisonEntry[]
  pathChanges: AttackPathDiffEntry[]
  graphChanges: GraphChangeEntry[]
  coverage: CoverageComparison
}

/** Upsert by (previous, current): a re-run of the comparison replaces the stored snapshot. */
export async function upsertAssessmentComparison(db: DbOrTx, input: CreateAssessmentComparisonRecord): Promise<AssessmentComparisonRow> {
  const existing = await findAssessmentComparison(db, input.previousEngagementId, input.currentEngagementId)
  if (existing) {
    const [row] = await db
      .update(securityAssessmentComparisons)
      .set({ summary: input.summary, findingChanges: input.findingChanges, pathChanges: input.pathChanges, graphChanges: input.graphChanges, coverage: input.coverage, createdAt: new Date() })
      .where(eq(securityAssessmentComparisons.id, existing.id))
      .returning()
    if (!row) throw new Error('Failed to update assessment comparison')
    return row
  }
  const [row] = await db.insert(securityAssessmentComparisons).values(input).returning()
  if (!row) throw new Error('Failed to record assessment comparison')
  return row
}

export async function findAssessmentComparison(db: DbOrTx, previousEngagementId: string, currentEngagementId: string): Promise<AssessmentComparisonRow | undefined> {
  const [row] = await db
    .select()
    .from(securityAssessmentComparisons)
    .where(and(eq(securityAssessmentComparisons.previousEngagementId, previousEngagementId), eq(securityAssessmentComparisons.currentEngagementId, currentEngagementId)))
  return row
}

export async function listAssessmentComparisonsForCurrent(db: DbOrTx, currentEngagementId: string, limit = 100): Promise<SecurityAssessmentComparison[]> {
  const rows = await db
    .select()
    .from(securityAssessmentComparisons)
    .where(eq(securityAssessmentComparisons.currentEngagementId, currentEngagementId))
    .orderBy(desc(securityAssessmentComparisons.createdAt))
    .limit(Math.min(limit, 500))
  return rows.map(toAssessmentComparison)
}

// ── Analyst decisions ───────────────────────────────────────────────────────────────────────────────────

export function toAnalystDecision(row: AnalystDecisionRow): AnalystDecision {
  return {
    id: row.id,
    engagementId: row.engagementId,
    kind: row.kind,
    subjectRef: row.subjectRef,
    relatedRef: row.relatedRef ?? null,
    note: row.note,
    actorId: row.actorId ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function insertAnalystDecision(
  db: DbOrTx,
  input: { id: string; engagementId: string; kind: AnalystDecisionKind; subjectRef: string; relatedRef: string | null; note: string; actorId: string | null },
): Promise<AnalystDecisionRow> {
  const [row] = await db
    .insert(securityAnalystDecisions)
    .values({ ...input, note: input.note.slice(0, 2000) })
    .returning()
  if (!row) throw new Error('Failed to record analyst decision')
  return row
}

export async function listAnalystDecisions(db: DbOrTx, engagementId: string, options: { subjectRef?: string; limit?: number } = {}): Promise<AnalystDecision[]> {
  const rows = await db
    .select()
    .from(securityAnalystDecisions)
    .where(and(eq(securityAnalystDecisions.engagementId, engagementId), options.subjectRef ? eq(securityAnalystDecisions.subjectRef, options.subjectRef) : undefined))
    .orderBy(desc(securityAnalystDecisions.createdAt))
    .limit(Math.min(options.limit ?? 500, 2000))
  return rows.map(toAnalystDecision)
}
