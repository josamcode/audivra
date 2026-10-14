import { and, asc, desc, eq } from 'drizzle-orm'
import type {
  AttackPathTransition,
  AttackStep,
  EndImpact,
  ImpactClass,
  MissingEvidenceRequirement,
  PathOrigin,
  PathState,
  SecurityAttackPath,
  Severity,
  StartCondition,
  TrustBoundaryKind,
} from '@audivra/contracts'
import { newId } from '../ids.ts'
import { securityAttackPaths } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Phase 6B persistence for evidence-backed attack paths. One row holds the whole route — start, end, ordered
 * steps (each with its own edge verification state), the findings/comparisons/invariants it correlates, the
 * explicit missing-evidence requirements, and the path state/confidence AUDIVRA computed. Rows are
 * reference-only (ids and graph keys, never secrets). One row per (engagement, pathKey): the same semantic
 * route is advanced, never duplicated.
 */

export type AttackPathRow = typeof securityAttackPaths.$inferSelect

export const newAttackPathId = () => newId('ap')

export function toAttackPath(row: AttackPathRow): SecurityAttackPath {
  return {
    id: row.id,
    engagementId: row.engagementId,
    pathKey: row.pathKey,
    title: row.title,
    purpose: row.purpose,
    start: row.start,
    end: row.endImpact,
    steps: row.steps,
    affectedEntityKeys: row.affectedEntityKeys,
    findingIds: row.findingIds,
    comparisonIds: row.comparisonIds,
    invariantRefs: row.invariantRefs,
    confidence: row.confidence,
    state: row.state,
    stateReason: row.stateReason,
    missingEvidence: row.missingEvidence,
    impactClass: row.impactClass,
    impactPriority: row.impactPriority,
    boundariesCrossed: row.boundariesCrossed,
    origin: row.origin,
    providerId: row.providerId ?? null,
    explanation: row.explanation,
    dominatedBy: row.dominatedBy ?? null,
    history: row.history,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface CreateAttackPathRecord {
  id: string
  engagementId: string
  pathKey: string
  title: string
  purpose: string
  start: StartCondition
  endImpact: EndImpact
  steps: AttackStep[]
  affectedEntityKeys: string[]
  findingIds: string[]
  comparisonIds: string[]
  invariantRefs: string[]
  confidence: number
  state: PathState
  stateReason: string
  missingEvidence: MissingEvidenceRequirement[]
  impactClass: ImpactClass
  impactPriority: Severity
  boundariesCrossed: TrustBoundaryKind[]
  origin: PathOrigin
  providerId: string | null
  explanation: string
  dominatedBy: string | null
  history: AttackPathTransition[]
}

export interface AttackPathPatch {
  title?: string
  purpose?: string
  steps?: AttackStep[]
  affectedEntityKeys?: string[]
  findingIds?: string[]
  comparisonIds?: string[]
  invariantRefs?: string[]
  confidence?: number
  state?: PathState
  stateReason?: string
  missingEvidence?: MissingEvidenceRequirement[]
  impactClass?: ImpactClass
  impactPriority?: Severity
  boundariesCrossed?: TrustBoundaryKind[]
  origin?: PathOrigin
  providerId?: string | null
  explanation?: string
  dominatedBy?: string | null
  history?: AttackPathTransition[]
}

export async function insertAttackPath(db: DbOrTx, input: CreateAttackPathRecord): Promise<AttackPathRow> {
  const [row] = await db
    .insert(securityAttackPaths)
    .values({ ...input, title: input.title.slice(0, 300) })
    .returning()
  if (!row) throw new Error('Failed to record attack path')
  return row
}

export async function updateAttackPath(db: DbOrTx, id: string, patch: AttackPathPatch): Promise<AttackPathRow | undefined> {
  const [row] = await db
    .update(securityAttackPaths)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securityAttackPaths.id, id))
    .returning()
  return row
}

export async function getAttackPathRow(db: DbOrTx, id: string): Promise<AttackPathRow | undefined> {
  const [row] = await db.select().from(securityAttackPaths).where(eq(securityAttackPaths.id, id))
  return row
}

export async function findAttackPathByKey(db: DbOrTx, engagementId: string, pathKey: string): Promise<AttackPathRow | undefined> {
  const [row] = await db
    .select()
    .from(securityAttackPaths)
    .where(and(eq(securityAttackPaths.engagementId, engagementId), eq(securityAttackPaths.pathKey, pathKey)))
  return row
}

export async function listAttackPathRows(db: DbOrTx, engagementId: string, options: { state?: PathState; limit?: number } = {}): Promise<AttackPathRow[]> {
  return db
    .select()
    .from(securityAttackPaths)
    .where(and(eq(securityAttackPaths.engagementId, engagementId), options.state ? eq(securityAttackPaths.state, options.state) : undefined))
    .orderBy(asc(securityAttackPaths.createdAt))
    .limit(Math.min(options.limit ?? 500, 2000))
}

export async function listAttackPathsForEngagement(db: DbOrTx, engagementId: string, limit = 2000): Promise<SecurityAttackPath[]> {
  return (await listAttackPathRows(db, engagementId, { limit })).map(toAttackPath)
}

/** Removes a persisted path (used when a re-analysis finds a prior path no longer holds). */
export async function deleteAttackPath(db: DbOrTx, id: string): Promise<void> {
  await db.delete(securityAttackPaths).where(eq(securityAttackPaths.id, id))
}
