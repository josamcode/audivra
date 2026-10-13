import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  redactSensitive,
  type ObservationContribution,
  type ObservationScopeClass,
  type ObservationSourceType,
  type ObservationType,
  type SecurityObservation,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { securityObservations } from '../schema.ts'

/*
 * Persistence for normalized security observations. One row per (engagement, dedupe key): a second
 * sensor reporting the same thing merges its contribution and evidence onto the existing row, so
 * provenance is never lost and the same fact is not duplicated. Content is redacted at this boundary.
 */

export interface RecordObservationInput {
  engagementId: string
  dedupeKey: string
  type: ObservationType
  asset: string
  subject: string
  title: string
  scopeClass: ObservationScopeClass | null
  value: Record<string, unknown>
  sourceType: ObservationSourceType
  /** The one sensor run contributing this observation. */
  contribution: ObservationContribution
}

type ObservationRow = typeof securityObservations.$inferSelect

export function toObservation(row: ObservationRow): SecurityObservation {
  return {
    id: row.id,
    engagementId: row.engagementId,
    dedupeKey: row.dedupeKey,
    type: row.type,
    asset: row.asset,
    subject: row.subject,
    title: row.title,
    scopeClass: row.scopeClass,
    value: row.value,
    sourceType: row.sourceType,
    confidence: row.confidence,
    evidenceRefs: row.evidenceRefs,
    contributions: row.contributions,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }
}

/**
 * Records an observation, deduplicated by `(engagementId, dedupeKey)`: a new key inserts a row, an
 * existing one merges the contribution and evidence, keeps the highest confidence and the latest value,
 * and advances `lastSeenAt`. Serialized per key by a row lock so concurrent sensors cannot race.
 */
export async function recordSecurityObservation(db: Db, input: RecordObservationInput): Promise<SecurityObservation> {
  const content = redactSensitive({ title: input.title, subject: input.subject, value: input.value })
  const contribution = redactSensitive(input.contribution).value
  const evidenceRefs = contribution.evidenceRef ? [contribution.evidenceRef] : []
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(securityObservations)
      .where(and(eq(securityObservations.engagementId, input.engagementId), eq(securityObservations.dedupeKey, input.dedupeKey)))
      .for('update')
    const now = new Date()
    if (!existing) {
      const [row] = await tx
        .insert(securityObservations)
        .values({
          id: newId('obs'),
          engagementId: input.engagementId,
          dedupeKey: input.dedupeKey,
          type: input.type,
          asset: input.asset.slice(0, 2048),
          subject: content.value.subject.slice(0, 1024),
          title: content.value.title.slice(0, 300),
          scopeClass: input.scopeClass,
          value: content.value.value,
          sourceType: input.sourceType,
          confidence: contribution.confidence,
          evidenceRefs,
          contributions: [contribution],
        })
        .returning()
      if (!row) throw new Error('Failed to record security observation')
      return toObservation(row)
    }
    const mergedEvidence = [...new Set([...existing.evidenceRefs, ...evidenceRefs])]
    const [row] = await tx
      .update(securityObservations)
      .set({
        // Latest value/title/scope win; confidence is the max across contributions; provenance accrues.
        title: content.value.title.slice(0, 300),
        value: content.value.value,
        scopeClass: input.scopeClass ?? existing.scopeClass,
        sourceType: input.sourceType,
        confidence: Math.max(existing.confidence, contribution.confidence),
        evidenceRefs: mergedEvidence,
        contributions: [...existing.contributions, contribution].slice(-50),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(securityObservations.id, existing.id))
      .returning()
    if (!row) throw new Error('Failed to update security observation')
    return toObservation(row)
  })
}

/** Observations by id (bounded), e.g. to name the sources behind a graph fact. */
export async function getSecurityObservationsByIds(db: Db, ids: string[]): Promise<SecurityObservation[]> {
  if (ids.length === 0) return []
  const rows = await db.select().from(securityObservations).where(inArray(securityObservations.id, ids.slice(0, 500)))
  return rows.map(toObservation)
}

export interface ListObservationsOptions {
  type?: ObservationType
  asset?: string
  scopeClass?: ObservationScopeClass
  limit?: number
}

export async function listSecurityObservations(db: Db, engagementId: string, options: ListObservationsOptions = {}): Promise<SecurityObservation[]> {
  const rows = await db
    .select()
    .from(securityObservations)
    .where(
      and(
        eq(securityObservations.engagementId, engagementId),
        options.type ? eq(securityObservations.type, options.type) : undefined,
        options.asset ? eq(securityObservations.asset, options.asset) : undefined,
        options.scopeClass ? eq(securityObservations.scopeClass, options.scopeClass) : undefined,
      ),
    )
    .orderBy(asc(securityObservations.type), asc(securityObservations.asset), desc(securityObservations.lastSeenAt))
    .limit(options.limit ?? 2000)
  return rows.map(toObservation)
}

/** Counts of observations by type for an engagement (for coverage and the overview). */
export async function countObservationsByType(db: Db, engagementId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ type: securityObservations.type, n: sql<number>`count(*)::int` })
    .from(securityObservations)
    .where(eq(securityObservations.engagementId, engagementId))
    .groupBy(securityObservations.type)
  return Object.fromEntries(rows.map((r) => [r.type, r.n]))
}
