import { asc, eq, sql } from 'drizzle-orm'
import { Artifact, type ArtifactPlacement, type ArtifactType, type Category } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { artifacts, audits } from '../schema.ts'

export interface NewArtifact {
  type: ArtifactType
  title: string
  subtitle: string | null
  question: string
  description: string
  evidenceRefs: string[]
  findingRefs: string[]
  category: Category | null
  priority: number
  placement: ArtifactPlacement
  data: Record<string, unknown>
  createdBy: 'planner' | 'system'
  agentRunId?: string | null
}

type ArtifactRow = typeof artifacts.$inferSelect

/** Converts a stored row into the validated Artifact union; returns null if the row no longer validates. */
export function toArtifact(row: ArtifactRow): Artifact | null {
  const parsed = Artifact.safeParse({
    id: row.id,
    ref: row.ref,
    auditId: row.auditId,
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    question: row.question,
    description: row.description,
    evidenceIds: row.evidenceRefs,
    findingIds: row.findingRefs,
    category: row.category ?? null,
    priority: row.priority,
    placement: row.placement,
    data: row.data,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  })
  return parsed.success ? parsed.data : null
}

/**
 * Replaces an audit's artifacts (the presentation stage can be re-run) and assigns sequential refs
 * (A1, A2, ...) in the given order. Returns the stored artifacts.
 */
export async function replaceArtifacts(db: Db, auditId: string, items: NewArtifact[]): Promise<Artifact[]> {
  return db.transaction(async (tx) => {
    await tx.delete(artifacts).where(eq(artifacts.auditId, auditId))
    await tx.update(audits).set({ artifactSeq: 0 }).where(eq(audits.id, auditId))
    const stored: Artifact[] = []
    for (const [index, item] of items.entries()) {
      const [row] = await tx
        .insert(artifacts)
        .values({
          id: newId('art'),
          auditId,
          ref: `A${index + 1}`,
          type: item.type,
          title: item.title,
          subtitle: item.subtitle,
          question: item.question,
          description: item.description,
          evidenceRefs: item.evidenceRefs,
          findingRefs: item.findingRefs,
          category: item.category,
          priority: item.priority,
          placement: item.placement,
          data: item.data,
          createdBy: item.createdBy,
          agentRunId: item.agentRunId ?? null,
        })
        .returning()
      const artifact = row ? toArtifact(row) : null
      if (artifact) stored.push(artifact)
    }
    await tx
      .update(audits)
      .set({ artifactSeq: sql`${items.length}` })
      .where(eq(audits.id, auditId))
    return stored
  })
}

export async function listArtifacts(db: Db, auditId: string): Promise<Artifact[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.auditId, auditId))
    .orderBy(asc(artifacts.priority), asc(artifacts.createdAt))
  return rows.map(toArtifact).filter((a): a is Artifact => a !== null)
}

export async function getArtifact(db: Db, auditId: string, ref: string): Promise<Artifact | undefined> {
  const rows = await db.select().from(artifacts).where(eq(artifacts.auditId, auditId))
  const row = rows.find((r) => r.ref === ref || r.id === ref)
  return row ? (toArtifact(row) ?? undefined) : undefined
}
