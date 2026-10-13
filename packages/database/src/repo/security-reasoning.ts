import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  redactSensitive,
  type ReasoningAction,
  type ReasoningRun,
  type ReasoningRunStatus,
  type SecurityHypothesis,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { securityHypotheses, securityHypothesisLinks, securityReasoningActions, securityReasoningRuns } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Persistence for hypotheses, reasoning runs and proposed actions. The reasoning engine (in
 * @audivra/security) validates everything a model produced before it reaches these functions; this module
 * stores rows and redacts free text at the boundary. Run state is updated with guarded, conditional writes
 * so a recovered or duplicated job can never move a run backwards.
 */

export type HypothesisRow = typeof securityHypotheses.$inferSelect
export type HypothesisInsert = typeof securityHypotheses.$inferInsert
export type HypothesisLinkRow = typeof securityHypothesisLinks.$inferSelect
export type ReasoningRunRow = typeof securityReasoningRuns.$inferSelect
export type ReasoningRunInsert = typeof securityReasoningRuns.$inferInsert
export type ReasoningActionRow = typeof securityReasoningActions.$inferSelect
export type ReasoningActionInsert = typeof securityReasoningActions.$inferInsert

export const newHypothesisId = () => newId('hy')
export const newReasoningRunId = () => newId('rr')
export const newReasoningActionId = () => newId('ra')

const iso = (d: Date) => d.toISOString()
const clean = (text: string, max: number) => redactSensitive({ t: text }).value.t.slice(0, max)

// ── Hypotheses ───────────────────────────────────────────────────────────────────────────────────────

export function toHypothesis(row: HypothesisRow, links: HypothesisLinkRow[]): SecurityHypothesis {
  const of = (role: HypothesisLinkRow['role']) => links.filter((l) => l.hypothesisId === row.id && l.role === role).map((l) => l.targetId)
  return {
    id: row.id,
    engagementId: row.engagementId,
    dedupeKey: row.dedupeKey,
    claim: row.claim,
    category: row.category,
    status: row.status,
    statusReason: row.statusReason,
    confidence: row.confidence,
    impact: row.impact,
    rationale: row.rationale,
    subjectEntityIds: of('affects'),
    gapIds: of('gap'),
    supportingObservationIds: of('supports'),
    contradictingObservationIds: of('contradicts'),
    evidenceChecks: row.evidenceChecks,
    checkResults: row.checkResults,
    candidateCapabilities: row.candidateCapabilities,
    ranking: row.ranking ?? null,
    expectedInformationGain: row.expectedInformationGain,
    estimatedCost: row.estimatedCost,
    executionRisk: row.executionRisk,
    attempts: row.attempts,
    origin: row.origin,
    review: row.review,
    history: row.history,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export async function insertHypothesis(db: DbOrTx, row: HypothesisInsert): Promise<HypothesisRow> {
  const [inserted] = await db
    .insert(securityHypotheses)
    .values({ ...row, claim: clean(row.claim, 300), rationale: clean(row.rationale, 600) })
    .returning()
  if (!inserted) throw new Error('Failed to record hypothesis')
  return inserted
}

export async function updateHypothesis(db: DbOrTx, id: string, patch: Partial<HypothesisInsert>): Promise<HypothesisRow | undefined> {
  const [row] = await db
    .update(securityHypotheses)
    .set({ ...patch, ...(patch.statusReason !== undefined ? { statusReason: clean(patch.statusReason, 600) } : {}), updatedAt: new Date() })
    .where(eq(securityHypotheses.id, id))
    .returning()
  return row
}

export async function getHypothesisRow(db: DbOrTx, id: string): Promise<HypothesisRow | undefined> {
  const [row] = await db.select().from(securityHypotheses).where(eq(securityHypotheses.id, id))
  return row
}

export async function listHypothesisRows(db: DbOrTx, engagementId: string, options: { statuses?: SecurityHypothesis['status'][]; limit?: number } = {}): Promise<HypothesisRow[]> {
  return db
    .select()
    .from(securityHypotheses)
    .where(and(eq(securityHypotheses.engagementId, engagementId), options.statuses?.length ? inArray(securityHypotheses.status, options.statuses) : undefined))
    .orderBy(desc(securityHypotheses.priority), asc(securityHypotheses.createdAt))
    .limit(Math.min(options.limit ?? 200, 500))
}

export async function listHypothesisLinks(db: DbOrTx, hypothesisIds: string[]): Promise<HypothesisLinkRow[]> {
  if (hypothesisIds.length === 0) return []
  return db.select().from(securityHypothesisLinks).where(inArray(securityHypothesisLinks.hypothesisId, hypothesisIds))
}

/** Hypotheses that link to a target (entity → hypotheses). */
export async function hypothesisIdsLinkedTo(db: DbOrTx, engagementId: string, targetType: HypothesisLinkRow['targetType'], targetIds: string[]): Promise<string[]> {
  if (targetIds.length === 0) return []
  const rows = await db
    .selectDistinct({ id: securityHypothesisLinks.hypothesisId })
    .from(securityHypothesisLinks)
    .where(and(eq(securityHypothesisLinks.engagementId, engagementId), eq(securityHypothesisLinks.targetType, targetType), inArray(securityHypothesisLinks.targetId, targetIds)))
  return rows.map((r) => r.id)
}

/** Adds links idempotently (a repeated link is a no-op). */
export async function addHypothesisLinks(
  db: DbOrTx,
  engagementId: string,
  hypothesisId: string,
  links: { role: HypothesisLinkRow['role']; targetType: HypothesisLinkRow['targetType']; targetId: string; addedBy: HypothesisLinkRow['addedBy']; note?: string | null }[],
): Promise<number> {
  if (links.length === 0) return 0
  const rows = await db
    .insert(securityHypothesisLinks)
    .values(links.map((l) => ({ id: newId('hl'), engagementId, hypothesisId, role: l.role, targetType: l.targetType, targetId: l.targetId, addedBy: l.addedBy, note: l.note ? clean(l.note, 400) : null })))
    .onConflictDoNothing()
    .returning({ id: securityHypothesisLinks.id })
  return rows.length
}

// ── Reasoning runs ───────────────────────────────────────────────────────────────────────────────────

export function toReasoningRun(row: ReasoningRunRow): ReasoningRun {
  return {
    id: row.id,
    engagementId: row.engagementId,
    mode: row.mode,
    status: row.status,
    stage: row.stage,
    iteration: row.iteration,
    budget: row.budget,
    usage: row.usage,
    stopReason: row.stopReason,
    stopDetail: row.stopDetail,
    aiCoverage: row.aiCoverage,
    decisions: row.decisions,
    aiRuns: row.aiRuns,
    waitingOn: row.waitingOn,
    requestedBy: row.requestedBy,
    cancelRequestedAt: row.cancelRequestedAt ? iso(row.cancelRequestedAt) : null,
    createdAt: iso(row.createdAt),
    startedAt: row.startedAt ? iso(row.startedAt) : null,
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    updatedAt: iso(row.updatedAt),
  }
}

export async function insertReasoningRun(db: DbOrTx, row: ReasoningRunInsert): Promise<ReasoningRunRow> {
  const [inserted] = await db.insert(securityReasoningRuns).values(row).returning()
  if (!inserted) throw new Error('Failed to record reasoning run')
  return inserted
}

export async function getReasoningRunRow(db: DbOrTx, id: string): Promise<ReasoningRunRow | undefined> {
  const [row] = await db.select().from(securityReasoningRuns).where(eq(securityReasoningRuns.id, id))
  return row
}

export async function listReasoningRunRows(db: DbOrTx, engagementId: string, limit = 50): Promise<ReasoningRunRow[]> {
  return db.select().from(securityReasoningRuns).where(eq(securityReasoningRuns.engagementId, engagementId)).orderBy(desc(securityReasoningRuns.createdAt)).limit(limit)
}

/** Runs not yet finished (queued, running, waiting) across every engagement — for worker recovery. */
export async function listUnfinishedReasoningRuns(db: DbOrTx): Promise<ReasoningRunRow[]> {
  return db
    .select()
    .from(securityReasoningRuns)
    .where(inArray(securityReasoningRuns.status, ['queued', 'running', 'waiting']))
    .orderBy(asc(securityReasoningRuns.createdAt))
}

/** Runs waiting on an execution (to wake them when it settles). */
export async function listRunsWaitingOn(db: DbOrTx, executionId: string): Promise<ReasoningRunRow[]> {
  return db
    .select()
    .from(securityReasoningRuns)
    .where(and(eq(securityReasoningRuns.status, 'waiting'), sql`${securityReasoningRuns.waitingOn} @> ${JSON.stringify([executionId])}::jsonb`))
}

/**
 * Guarded update: applied only while the run is in one of `from` (and, with `leaseOwner`, still leased by
 * that owner). Returns the updated row, or undefined when the guard did not match.
 */
export async function updateReasoningRun(
  db: DbOrTx,
  id: string,
  guard: { from?: ReasoningRunStatus[]; leaseOwner?: string },
  patch: Partial<ReasoningRunInsert>,
): Promise<ReasoningRunRow | undefined> {
  const [row] = await db
    .update(securityReasoningRuns)
    .set({ ...patch, ...(patch.stopDetail ? { stopDetail: clean(patch.stopDetail, 600) } : {}), updatedAt: new Date() })
    .where(
      and(
        eq(securityReasoningRuns.id, id),
        guard.from?.length ? inArray(securityReasoningRuns.status, guard.from) : undefined,
        guard.leaseOwner ? eq(securityReasoningRuns.leaseOwner, guard.leaseOwner) : undefined,
      ),
    )
    .returning()
  return row
}

/**
 * Claims a run for one driver: a queued/waiting run, or a running run whose lease has expired (its driver
 * died). Exactly one concurrent caller wins.
 */
export async function claimReasoningRun(db: DbOrTx, id: string, ownerId: string, leaseExpiredBefore: Date): Promise<ReasoningRunRow | undefined> {
  const [row] = await db
    .update(securityReasoningRuns)
    .set({ status: 'running', leaseOwner: ownerId, heartbeatAt: new Date(), updatedAt: new Date(), startedAt: sql`coalesce(${securityReasoningRuns.startedAt}, now())` })
    .where(
      and(
        eq(securityReasoningRuns.id, id),
        sql`(${securityReasoningRuns.status} in ('queued', 'waiting') or (${securityReasoningRuns.status} = 'running' and (${securityReasoningRuns.heartbeatAt} is null or ${securityReasoningRuns.heartbeatAt} < ${leaseExpiredBefore})))`,
      ),
    )
    .returning()
  return row
}

export async function heartbeatReasoningRun(db: DbOrTx, id: string, ownerId: string): Promise<boolean> {
  const rows = await db
    .update(securityReasoningRuns)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(securityReasoningRuns.id, id), eq(securityReasoningRuns.leaseOwner, ownerId), eq(securityReasoningRuns.status, 'running')))
    .returning({ id: securityReasoningRuns.id })
  return rows.length > 0
}

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────

export function toReasoningAction(row: ReasoningActionRow): ReasoningAction {
  return {
    id: row.id,
    engagementId: row.engagementId,
    runId: row.runId,
    hypothesisId: row.hypothesisId,
    capabilityId: row.capabilityId,
    input: row.input,
    actionKey: row.actionKey,
    expectedEvidence: row.expectedEvidence,
    reason: row.reason,
    status: row.status,
    statusReason: row.statusReason,
    decision: row.decision ?? null,
    executionId: row.executionId,
    result: row.result ?? null,
    costClass: row.costClass,
    origin: row.origin,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export async function insertReasoningAction(db: DbOrTx, row: ReasoningActionInsert): Promise<ReasoningActionRow> {
  const [inserted] = await db
    .insert(securityReasoningActions)
    .values({ ...row, expectedEvidence: clean(row.expectedEvidence, 300), reason: clean(row.reason, 400), input: redactSensitive(row.input ?? {}).value })
    .returning()
  if (!inserted) throw new Error('Failed to record reasoning action')
  return inserted
}

export async function updateReasoningAction(db: DbOrTx, id: string, patch: Partial<ReasoningActionInsert>): Promise<ReasoningActionRow | undefined> {
  const [row] = await db
    .update(securityReasoningActions)
    .set({ ...patch, ...(patch.statusReason ? { statusReason: clean(patch.statusReason, 600) } : {}), updatedAt: new Date() })
    .where(eq(securityReasoningActions.id, id))
    .returning()
  return row
}

export async function listReasoningActionRows(db: DbOrTx, filter: { engagementId?: string; runId?: string; hypothesisIds?: string[]; actionKey?: string; limit?: number }): Promise<ReasoningActionRow[]> {
  return db
    .select()
    .from(securityReasoningActions)
    .where(
      and(
        filter.engagementId ? eq(securityReasoningActions.engagementId, filter.engagementId) : undefined,
        filter.runId ? eq(securityReasoningActions.runId, filter.runId) : undefined,
        filter.hypothesisIds ? (filter.hypothesisIds.length ? inArray(securityReasoningActions.hypothesisId, filter.hypothesisIds) : sql`false`) : undefined,
        filter.actionKey ? eq(securityReasoningActions.actionKey, filter.actionKey) : undefined,
      ),
    )
    .orderBy(desc(securityReasoningActions.createdAt))
    .limit(Math.min(filter.limit ?? 300, 1000))
}

export async function countReasoningActions(db: Db, engagementId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: securityReasoningActions.status, n: sql<number>`count(*)::int` })
    .from(securityReasoningActions)
    .where(eq(securityReasoningActions.engagementId, engagementId))
    .groupBy(securityReasoningActions.status)
  return Object.fromEntries(rows.map((r) => [r.status, r.n]))
}
