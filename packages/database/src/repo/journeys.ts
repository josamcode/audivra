import { asc, desc, eq } from 'drizzle-orm'
import type { JourneyHealth, JourneyItem, JourneyStep, JourneyType } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { findings, journeys } from '../schema.ts'

export interface NewJourney {
  ref: string
  journeyKey: string
  type: JourneyType
  name: string
  goal: string
  description: string
  isPrimary: boolean
  confidence: number
  steps: JourneyStep[]
  health: JourneyHealth[]
}

/** Replaces an audit's journeys atomically (finalization and journey analysis can be retried). */
export async function replaceJourneys(
  db: Db,
  auditId: string,
  items: NewJourney[],
  source: 'audit' | 'analysis',
  agentRunId: string | null = null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(journeys).where(eq(journeys.auditId, auditId))
    for (const [index, item] of items.entries()) {
      await tx.insert(journeys).values({ id: newId('jr'), auditId, rank: index + 1, source, agentRunId, ...item })
    }
  })
}

const refNumber = (ref: string) => Number(ref.replace(/\D/g, '')) || 0

/** Journeys of an audit (primary first) with the findings that affect them. */
export async function listJourneys(db: Db, auditId: string): Promise<JourneyItem[]> {
  const rows = await db.select().from(journeys).where(eq(journeys.auditId, auditId)).orderBy(desc(journeys.isPrimary), asc(journeys.rank))
  if (rows.length === 0) return []
  const links = await db.select({ ref: findings.ref, journeyRefs: findings.journeyRefs }).from(findings).where(eq(findings.auditId, auditId))
  return rows.map((row) => {
    const evidence = new Set<string>()
    for (const step of row.steps) step.evidenceIds.forEach((ref) => evidence.add(ref))
    for (const dim of row.health) dim.evidenceIds.forEach((ref) => evidence.add(ref))
    return {
      id: row.id,
      ref: row.ref,
      auditId: row.auditId,
      journeyKey: row.journeyKey,
      type: row.type,
      name: row.name,
      goal: row.goal,
      description: row.description,
      isPrimary: row.isPrimary,
      confidence: row.confidence,
      steps: row.steps,
      health: row.health,
      findingRefs: links
        .filter((f) => (f.journeyRefs ?? []).includes(row.ref))
        .map((f) => f.ref)
        .sort((a, b) => refNumber(a) - refNumber(b)),
      evidenceRefs: [...evidence].sort((a, b) => refNumber(a) - refNumber(b)),
      source: row.source,
      rank: row.rank,
      createdAt: row.createdAt.toISOString(),
    }
  })
}
