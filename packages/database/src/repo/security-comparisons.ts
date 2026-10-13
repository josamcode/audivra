import { and, desc, eq } from 'drizzle-orm'
import type {
  BusinessStateChange,
  CleanupAction,
  ComparisonArm,
  ComparisonControls,
  ComparisonDimension,
  ComparisonResult,
  ComparisonStatus,
  ComparisonTransition,
  InvariantEvalStatus,
  ResourceRelationship,
  SecurityComparison,
  SemanticDifference,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { securityComparisons } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Persistence for Phase 5 Step 4 differential comparisons. A row holds the whole experiment: the plan (arms),
 * the normalized observations, the semantic differences, controls, result and provenance — all secret-free
 * (session/credential material never reaches it; arms carry only references and evidence refs). One row per
 * (engagement, dedupeKey): the same experiment is not re-created, only advanced.
 */

export type ComparisonRow = typeof securityComparisons.$inferSelect

export const newComparisonId = () => newId('cmp')

export function toComparison(row: ComparisonRow): SecurityComparison {
  return {
    id: row.id,
    engagementId: row.engagementId,
    hypothesisId: row.hypothesisId,
    dimension: row.dimension,
    dedupeKey: row.dedupeKey,
    title: row.title,
    resourceRef: row.resourceRef,
    action: row.action,
    resourceRelationship: row.resourceRelationship,
    invariantRef: row.invariantRef,
    status: row.status,
    arms: row.arms,
    controls: row.controls,
    semanticDifferences: row.semanticDifferences,
    state: row.state ?? null,
    result: row.result,
    resultReason: row.resultReason,
    confidence: row.confidence,
    invariantEvaluation: row.invariantEvaluation ?? null,
    evidenceRefs: row.evidenceRefs,
    cleanupAction: row.cleanupAction ?? null,
    stateProbe: row.stateProbe ?? null,
    cleanup: row.cleanup,
    coverageSampled: row.coverageSampled,
    origin: row.origin,
    retries: row.retries,
    history: row.history,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface CreateComparisonRecord {
  id: string
  engagementId: string
  hypothesisId: string | null
  dimension: ComparisonDimension
  dedupeKey: string
  title: string
  resourceRef: string
  action: string
  resourceRelationship: ResourceRelationship
  invariantRef: string | null
  status: ComparisonStatus
  arms: ComparisonArm[]
  controls: ComparisonControls
  cleanupAction: CleanupAction | null
  stateProbe: { url: string; expectedTransition: string | null } | null
  coverageSampled: boolean
  origin: 'ai' | 'user'
  history: ComparisonTransition[]
}

export interface ComparisonPatch {
  status?: ComparisonStatus
  resourceRelationship?: ResourceRelationship
  arms?: ComparisonArm[]
  controls?: ComparisonControls
  semanticDifferences?: SemanticDifference[]
  state?: BusinessStateChange | null
  result?: ComparisonResult
  resultReason?: string
  confidence?: number
  invariantEvaluation?: InvariantEvalStatus | null
  evidenceRefs?: string[]
  cleanup?: SecurityComparison['cleanup']
  retries?: number
  history?: ComparisonTransition[]
  hypothesisId?: string | null
}

export async function insertComparison(db: Db, input: CreateComparisonRecord): Promise<ComparisonRow> {
  const [row] = await db
    .insert(securityComparisons)
    .values({ ...input, title: input.title.slice(0, 300) })
    .returning()
  if (!row) throw new Error('Failed to record comparison')
  return row
}

export async function updateComparison(db: Db, id: string, patch: ComparisonPatch): Promise<ComparisonRow | undefined> {
  const [row] = await db
    .update(securityComparisons)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securityComparisons.id, id))
    .returning()
  return row
}

export async function getComparisonRow(db: Db, id: string): Promise<ComparisonRow | undefined> {
  const [row] = await db.select().from(securityComparisons).where(eq(securityComparisons.id, id))
  return row
}

export async function findComparisonByDedupe(db: Db, engagementId: string, dedupeKey: string): Promise<ComparisonRow | undefined> {
  const [row] = await db
    .select()
    .from(securityComparisons)
    .where(and(eq(securityComparisons.engagementId, engagementId), eq(securityComparisons.dedupeKey, dedupeKey)))
  return row
}

export async function listComparisonRows(
  db: DbOrTx,
  engagementId: string,
  options: { dimension?: ComparisonDimension; result?: ComparisonResult; hypothesisId?: string; limit?: number } = {},
): Promise<ComparisonRow[]> {
  return db
    .select()
    .from(securityComparisons)
    .where(
      and(
        eq(securityComparisons.engagementId, engagementId),
        options.dimension ? eq(securityComparisons.dimension, options.dimension) : undefined,
        options.result ? eq(securityComparisons.result, options.result) : undefined,
        options.hypothesisId ? eq(securityComparisons.hypothesisId, options.hypothesisId) : undefined,
      ),
    )
    .orderBy(desc(securityComparisons.createdAt))
    .limit(Math.min(options.limit ?? 500, 2000))
}

/** Every comparison of an engagement as domain objects — for the knowledge view, coverage and evidence checks. */
export async function listComparisonsForEngagement(db: DbOrTx, engagementId: string, limit = 2000): Promise<SecurityComparison[]> {
  return (await listComparisonRows(db, engagementId, { limit })).map(toComparison)
}
