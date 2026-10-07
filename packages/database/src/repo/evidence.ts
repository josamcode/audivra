import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { EvidenceItem, EvidenceSource, EvidenceType } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { audits, evidence } from '../schema.ts'

export interface CreateEvidenceInput {
  auditId: string
  source: EvidenceSource
  type: EvidenceType
  title: string
  summary: string
  url?: string | null
  artifactPath?: string | null
  metadata?: Record<string, unknown>
  toolRunId?: string | null
  agentRunId?: string | null
}

type EvidenceRow = typeof evidence.$inferSelect

export function toEvidenceItem(row: EvidenceRow): EvidenceItem {
  return {
    id: row.id,
    ref: row.ref,
    auditId: row.auditId,
    source: row.source,
    type: row.type,
    title: row.title,
    summary: row.summary,
    url: row.url,
    artifactPath: row.artifactPath,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Creates evidence with the next sequential per-audit reference (EV-1, EV-2, ...). */
export async function createEvidence(db: Db, input: CreateEvidenceInput): Promise<EvidenceItem> {
  return db.transaction(async (tx) => {
    const [seq] = await tx
      .update(audits)
      .set({ evidenceSeq: sql`${audits.evidenceSeq} + 1` })
      .where(eq(audits.id, input.auditId))
      .returning({ value: audits.evidenceSeq })
    if (!seq) throw new Error(`Audit ${input.auditId} not found`)
    const [row] = await tx
      .insert(evidence)
      .values({
        id: newId('ev'),
        auditId: input.auditId,
        ref: `EV-${seq.value}`,
        source: input.source,
        type: input.type,
        title: input.title.slice(0, 300),
        summary: input.summary.slice(0, 4000),
        url: input.url ?? null,
        artifactPath: input.artifactPath ?? null,
        metadata: input.metadata ?? {},
        toolRunId: input.toolRunId ?? null,
        agentRunId: input.agentRunId ?? null,
      })
      .returning()
    if (!row) throw new Error('Failed to create evidence')
    return toEvidenceItem(row)
  })
}

export async function listEvidence(db: Db, auditId: string): Promise<EvidenceItem[]> {
  const rows = await db
    .select()
    .from(evidence)
    .where(eq(evidence.auditId, auditId))
    .orderBy(asc(evidence.createdAt), asc(evidence.id))
  return rows.map(toEvidenceItem)
}

export async function getEvidenceByRefs(db: Db, auditId: string, refs: string[]): Promise<EvidenceItem[]> {
  if (refs.length === 0) return []
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.auditId, auditId), inArray(evidence.ref, refs)))
  return rows.map(toEvidenceItem)
}

export async function getEvidence(
  db: Db,
  auditId: string,
  idOrRef: string,
): Promise<EvidenceItem | undefined> {
  const column = idOrRef.startsWith('ev_') ? evidence.id : evidence.ref
  const [row] = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.auditId, auditId), eq(column, idOrRef)))
  return row ? toEvidenceItem(row) : undefined
}

export async function countEvidence(db: Db, auditId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(evidence)
    .where(eq(evidence.auditId, auditId))
  return row?.count ?? 0
}
