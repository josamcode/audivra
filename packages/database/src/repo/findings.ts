import { asc, eq, inArray, sql } from 'drizzle-orm'
import {
  SEVERITIES,
  type Category,
  type EffortLevel,
  type FindingItem,
  type FindingType,
  type ImpactLevel,
  type Opportunity,
  type Severity,
  type SeverityCounts,
  type VerificationStatus,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { artifacts, evidence, findingEvidence, findings } from '../schema.ts'

export interface NewFinding {
  ref: string
  rank: number
  title: string
  category: Category
  severity: Severity
  type: FindingType
  description: string
  observed: string
  affectedUrls: string[]
  confidence: number
  verificationStatus: VerificationStatus
  whyItMatters: string
  businessImpact: string
  businessImpactLevel: ImpactLevel
  recommendation: string
  effort: EffortLevel
  opportunity: Opportunity | null
  createdBy: string
  sourceRefs: string[]
  /** Stable issue identity used to compare audits of the same site. */
  issueKey?: string | null
  /** Database evidence IDs (already validated to belong to the audit). */
  evidenceIds: string[]
}

/** Replaces the final finding set of an audit atomically (finalization can be retried). */
export async function replaceFindings(db: Db, auditId: string, items: NewFinding[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.delete(findings).where(eq(findings.auditId, auditId))
    const ids: string[] = []
    for (const item of items) {
      const id = newId('fd')
      ids.push(id)
      const { evidenceIds, ...values } = item
      await tx.insert(findings).values({ id, auditId, ...values })
      const unique = [...new Set(evidenceIds)]
      if (unique.length) {
        await tx.insert(findingEvidence).values(unique.map((evidenceId) => ({ findingId: id, evidenceId })))
      }
    }
    return ids
  })
}

export async function listFindings(db: Db, auditId: string): Promise<FindingItem[]> {
  const rows = await db
    .select()
    .from(findings)
    .where(eq(findings.auditId, auditId))
    .orderBy(asc(findings.rank))
  if (rows.length === 0) return []
  const links = await db
    .select({ findingId: findingEvidence.findingId, ref: evidence.ref })
    .from(findingEvidence)
    .innerJoin(evidence, eq(evidence.id, findingEvidence.evidenceId))
    .where(
      inArray(
        findingEvidence.findingId,
        rows.map((r) => r.id),
      ),
    )
  const refsByFinding = new Map<string, string[]>()
  for (const link of links) {
    const list = refsByFinding.get(link.findingId) ?? []
    list.push(link.ref)
    refsByFinding.set(link.findingId, list)
  }
  const artifactRows = await db
    .select({ ref: artifacts.ref, findingRefs: artifacts.findingRefs })
    .from(artifacts)
    .where(eq(artifacts.auditId, auditId))
  const artifactsByFinding = new Map<string, string[]>()
  for (const artifact of artifactRows) {
    for (const findingRef of artifact.findingRefs) {
      artifactsByFinding.set(findingRef, [...(artifactsByFinding.get(findingRef) ?? []), artifact.ref])
    }
  }
  const refNumber = (ref: string) => Number(ref.replace(/\D/g, '')) || 0
  return rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    auditId: row.auditId,
    title: row.title,
    category: row.category,
    severity: row.severity,
    type: row.type,
    description: row.description,
    observed: row.observed,
    affectedUrls: row.affectedUrls,
    confidence: row.confidence,
    verificationStatus: row.verificationStatus,
    whyItMatters: row.whyItMatters,
    businessImpact: row.businessImpact,
    businessImpactLevel: row.businessImpactLevel,
    recommendation: row.recommendation,
    effort: row.effort,
    opportunity: row.opportunity ?? null,
    evidenceRefs: (refsByFinding.get(row.id) ?? []).sort((a, b) => refNumber(a) - refNumber(b)),
    issueKey: row.issueKey ?? null,
    artifactRefs: (artifactsByFinding.get(row.ref) ?? []).sort((a, b) => refNumber(a) - refNumber(b)),
    createdBy: row.createdBy,
    rank: row.rank,
  }))
}

export function emptySeverityCounts(): SeverityCounts {
  return Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as SeverityCounts
}

export async function findingCounts(
  db: Db,
  auditIds: string[],
): Promise<Map<string, { severity: SeverityCounts; categories: Record<string, number>; total: number }>> {
  const result = new Map<
    string,
    { severity: SeverityCounts; categories: Record<string, number>; total: number }
  >()
  if (auditIds.length === 0) return result
  const rows = await db
    .select({
      auditId: findings.auditId,
      severity: findings.severity,
      category: findings.category,
      count: sql<number>`count(*)::int`,
    })
    .from(findings)
    .where(inArray(findings.auditId, auditIds))
    .groupBy(findings.auditId, findings.severity, findings.category)
  for (const row of rows) {
    const entry = result.get(row.auditId) ?? { severity: emptySeverityCounts(), categories: {}, total: 0 }
    entry.severity[row.severity] += row.count
    entry.categories[row.category] = (entry.categories[row.category] ?? 0) + row.count
    entry.total += row.count
    result.set(row.auditId, entry)
  }
  return result
}
