import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { siteKeyFor, type AuditDetail, type AuditListItem } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newAuditId } from '../ids.ts'
import { artifacts, audits, findings } from '../schema.ts'
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
  benchmark?: boolean
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
      siteKey: siteKeyFor(input.normalizedUrl),
      clientName: input.clientName?.trim() || null,
      aiEnabled: input.aiEnabled,
      benchmark: input.benchmark ?? false,
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
    siteKey: row.siteKey || siteKeyFor(row.normalizedUrl),
    clientName: row.clientName,
    status: row.status,
    stage: row.stage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    severityCounts: counts?.severity ?? emptySeverityCounts(),
    findingCount: counts?.total ?? 0,
    benchmark: row.benchmark,
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

const FINISHED = ['completed', 'partial'] as const

/** Completed/partial audits of the same site, oldest first. */
export async function listSiteAudits(db: Db, siteKey: string): Promise<AuditRow[]> {
  return db
    .select()
    .from(audits)
    .where(and(eq(audits.siteKey, siteKey), inArray(audits.status, [...FINISHED])))
    .orderBy(audits.createdAt)
}

/** The most recent finished audit of the same site created before `row`. */
export async function getPreviousSiteAudit(db: Db, row: AuditRow): Promise<AuditRow | undefined> {
  const [previous] = await db
    .select()
    .from(audits)
    .where(
      and(
        eq(audits.siteKey, row.siteKey),
        inArray(audits.status, [...FINISHED]),
        lt(audits.createdAt, row.createdAt),
        eq(audits.benchmark, row.benchmark),
      ),
    )
    .orderBy(desc(audits.createdAt))
    .limit(1)
  return previous
}

export async function getAuditDetail(db: Db, id: string): Promise<AuditDetail | undefined> {
  const row = await getAuditRow(db, id)
  if (!row) return undefined
  const [counts, steps, evidenceCount, typeRows, artifactRows, previous, siteCount] = await Promise.all([
    findingCounts(db, [id]),
    listSteps(db, id),
    countEvidence(db, id),
    db
      .select({ type: findings.type, count: sql<number>`count(*)::int` })
      .from(findings)
      .where(eq(findings.auditId, id))
      .groupBy(findings.type),
    db.select({ count: sql<number>`count(*)::int` }).from(artifacts).where(eq(artifacts.auditId, id)),
    getPreviousSiteAudit(db, row),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(audits)
      .where(and(eq(audits.siteKey, row.siteKey), inArray(audits.status, [...FINISHED]))),
  ])
  const entry = counts.get(id)
  const typeCount = (t: string) => typeRows.find((r) => r.type === t)?.count ?? 0
  return {
    ...toListItem(row, entry),
    normalizedUrl: row.normalizedUrl,
    error: row.error ?? null,
    steps,
    summary: row.summary ?? null,
    baseline: row.baseline ?? null,
    categoryCounts: entry?.categories ?? {},
    typeCounts: {
      verified: typeCount('verified'),
      observed: typeCount('supported-observation'),
      inferred: typeCount('inference'),
    },
    evidenceCount,
    artifactCount: artifactRows[0]?.count ?? 0,
    aiEnabled: row.aiEnabled,
    coverage: row.coverage ?? [],
    reportPlan: row.reportPlan ?? null,
    previousAuditId: previous?.id ?? null,
    siteAuditCount: siteCount[0]?.count ?? 0,
  }
}
