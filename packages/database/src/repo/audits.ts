import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  getTemplate,
  siteKeyFor,
  type AuditDetail,
  type AuditError,
  type AuditListItem,
  type AuditStatus,
  type SeverityCounts,
} from '@audivra/contracts'
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
  /** Audit focus; recorded with its version so later changes to the template never rewrite history. */
  template?: { key: string; version: number }
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
      templateKey: input.template?.key ?? null,
      templateVersion: input.template?.version ?? null,
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

/** Columns needed to list audits: everything except the large JSON documents (summary, baseline, coverage, plan). */
const briefColumns = {
  id: audits.id,
  normalizedUrl: audits.normalizedUrl,
  domain: audits.domain,
  siteKey: audits.siteKey,
  clientName: audits.clientName,
  status: audits.status,
  stage: audits.stage,
  aiEnabled: audits.aiEnabled,
  benchmark: audits.benchmark,
  templateKey: audits.templateKey,
  templateVersion: audits.templateVersion,
  error: audits.error,
  createdAt: audits.createdAt,
  startedAt: audits.startedAt,
  finishedAt: audits.finishedAt,
}
type BriefRow = Pick<AuditRow, keyof typeof briefColumns>

function toListItem(
  row: BriefRow,
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
    template: templateUsage(row),
  }
}

function templateUsage(row: Pick<AuditRow, 'templateKey' | 'templateVersion'>): AuditListItem['template'] {
  if (!row.templateKey) return null
  const template = getTemplate(row.templateKey)
  return { key: template.key, version: row.templateVersion ?? template.version, name: template.name }
}

export async function listAudits(db: Db, limit = 200): Promise<AuditListItem[]> {
  const rows = await db.select(briefColumns).from(audits).orderBy(desc(audits.createdAt)).limit(limit)
  const counts = await findingCounts(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((row) => toListItem(row, counts.get(row.id)))
}

export interface AuditBrief extends AuditListItem {
  aiEnabled: boolean
  error: AuditError | null
}

/** Most recent audits (newest first) with finding counts; benchmark audits only when asked for. */
export async function listAuditBriefs(
  db: Db,
  options: { includeBenchmarks: boolean; limit?: number },
): Promise<AuditBrief[]> {
  const rows = await db
    .select(briefColumns)
    .from(audits)
    .where(options.includeBenchmarks ? undefined : eq(audits.benchmark, false))
    .orderBy(desc(audits.createdAt))
    .limit(options.limit ?? 200)
  const counts = await findingCounts(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((row) => ({ ...toListItem(row, counts.get(row.id)), aiEnabled: row.aiEnabled, error: row.error ?? null }))
}

export interface AuditGroupStat {
  siteKey: string
  benchmark: boolean
  status: AuditStatus
  aiEnabled: boolean
  count: number
  /** Audits of the group with both a start and a finish time. */
  timed: number
  /** Summed wall-clock duration of the timed audits. */
  durationMs: number
}

/** Audit counts and durations grouped by site, benchmark flag, status and AI mode: one small aggregate. */
export async function auditGroupStats(db: Db): Promise<AuditGroupStat[]> {
  const timed = sql`${audits.startedAt} is not null and ${audits.finishedAt} is not null`
  return db
    .select({
      siteKey: audits.siteKey,
      benchmark: audits.benchmark,
      status: audits.status,
      aiEnabled: audits.aiEnabled,
      count: sql<number>`count(*)::int`,
      timed: sql<number>`(count(*) filter (where ${timed}))::int`,
      durationMs: sql<number>`coalesce(sum(extract(epoch from ${audits.finishedAt} - ${audits.startedAt}) * 1000) filter (where ${timed}), 0)::float8`,
    })
    .from(audits)
    .groupBy(audits.siteKey, audits.benchmark, audits.status, audits.aiEnabled)
}

const FINISHED = ['completed', 'partial'] as const

/** A completed/partial AI audit with its final finding counts: one point of a site's history. */
export interface FinishedAiAudit {
  id: string
  siteKey: string
  domain: string
  benchmark: boolean
  createdAt: string
  severityCounts: SeverityCounts
}

/** Every finished AI audit (oldest first) with severity counts; benchmark audits only when asked for. */
export async function listFinishedAiAudits(db: Db, options: { includeBenchmarks: boolean }): Promise<FinishedAiAudit[]> {
  const scope = and(
    inArray(audits.status, [...FINISHED]),
    eq(audits.aiEnabled, true),
    options.includeBenchmarks ? undefined : eq(audits.benchmark, false),
  )
  const [rows, counts] = await Promise.all([
    db
      .select({ id: audits.id, siteKey: audits.siteKey, domain: audits.domain, benchmark: audits.benchmark, createdAt: audits.createdAt })
      .from(audits)
      .where(scope)
      .orderBy(audits.createdAt),
    db
      .select({ auditId: findings.auditId, severity: findings.severity, count: sql<number>`count(*)::int` })
      .from(findings)
      .innerJoin(audits, eq(audits.id, findings.auditId))
      .where(scope)
      .groupBy(findings.auditId, findings.severity),
  ])
  const byAudit = new Map<string, SeverityCounts>()
  for (const row of counts) {
    const entry = byAudit.get(row.auditId) ?? emptySeverityCounts()
    entry[row.severity] += row.count
    byAudit.set(row.auditId, entry)
  }
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    severityCounts: byAudit.get(row.id) ?? emptySeverityCounts(),
  }))
}

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
