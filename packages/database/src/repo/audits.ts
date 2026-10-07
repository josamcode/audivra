import { desc, eq } from 'drizzle-orm'
import type { AuditDetail, AuditListItem } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newAuditId } from '../ids.ts'
import { audits } from '../schema.ts'
import { countEvidence } from './evidence.ts'
import { emptySeverityCounts, findingCounts } from './findings.ts'
import { initSteps, listSteps } from './steps.ts'

export type AuditRow = typeof audits.$inferSelect
export type AuditPatch = Partial<Omit<typeof audits.$inferInsert, 'id'>>

export interface CreateAuditRecordInput {
  url: string
  normalizedUrl: string
  domain: string
  clientName?: string | null
  aiEnabled: boolean
  options?: Record<string, unknown>
}

export async function createAuditRecord(db: Db, input: CreateAuditRecordInput): Promise<AuditRow> {
  const id = newAuditId()
  const [row] = await db
    .insert(audits)
    .values({
      id,
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      domain: input.domain,
      clientName: input.clientName?.trim() || null,
      aiEnabled: input.aiEnabled,
      options: input.options ?? {},
    })
    .returning()
  if (!row) throw new Error('Failed to create audit')
  await initSteps(db, id)
  return row
}

export async function getAuditRow(db: Db, id: string): Promise<AuditRow | undefined> {
  const [row] = await db.select().from(audits).where(eq(audits.id, id))
  return row
}

export async function updateAudit(db: Db, id: string, patch: AuditPatch): Promise<void> {
  await db.update(audits).set(patch).where(eq(audits.id, id))
}

function toListItem(
  row: AuditRow,
  counts: { severity: ReturnType<typeof emptySeverityCounts>; total: number } | undefined,
): AuditListItem {
  return {
    id: row.id,
    url: row.normalizedUrl,
    domain: row.domain,
    clientName: row.clientName,
    status: row.status,
    stage: row.stage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    severityCounts: counts?.severity ?? emptySeverityCounts(),
    findingCount: counts?.total ?? 0,
  }
}

export async function listAudits(db: Db, limit = 200): Promise<AuditListItem[]> {
  const rows = await db.select().from(audits).orderBy(desc(audits.createdAt)).limit(limit)
  const counts = await findingCounts(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((row) => toListItem(row, counts.get(row.id)))
}

export async function getAuditDetail(db: Db, id: string): Promise<AuditDetail | undefined> {
  const row = await getAuditRow(db, id)
  if (!row) return undefined
  const [counts, steps, evidenceCount] = await Promise.all([
    findingCounts(db, [id]),
    listSteps(db, id),
    countEvidence(db, id),
  ])
  const entry = counts.get(id)
  return {
    ...toListItem(row, entry),
    normalizedUrl: row.normalizedUrl,
    error: row.error ?? null,
    steps,
    summary: row.summary ?? null,
    baseline: row.baseline ?? null,
    categoryCounts: entry?.categories ?? {},
    evidenceCount,
    aiEnabled: row.aiEnabled,
  }
}
