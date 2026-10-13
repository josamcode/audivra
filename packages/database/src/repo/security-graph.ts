import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import {
  redactSensitive,
  type FactStatus,
  type GapStatus,
  type GraphEntityKind,
  type GraphRelationType,
  type KnowledgeBasis,
  type KnowledgeGap,
  type SecurityGraphEdge,
  type SecurityGraphNode,
  type SecurityGraphProvenance,
  type SecurityObservation,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { securityExecutions, securityGraphEdges, securityGraphGaps, securityGraphNodes, securityGraphProvenance, securityObservations } from '../schema.ts'
import { toObservation } from './security-observations.ts'

/*
 * Persistence for the Security Graph. The deterministic projector (in @audivra/security) computes the
 * desired graph and the diff; this module stores rows. Writes happen inside `withGraphLock`, which
 * serializes projections of one engagement with a transaction-scoped advisory lock, so two projections
 * (two workers finishing executions at once) can never interleave and duplicate a fact.
 */

export type GraphNodeRow = typeof securityGraphNodes.$inferSelect
export type GraphEdgeRow = typeof securityGraphEdges.$inferSelect
export type GraphProvenanceRow = typeof securityGraphProvenance.$inferSelect
export type GraphGapRow = typeof securityGraphGaps.$inferSelect
export type GraphNodeInsert = typeof securityGraphNodes.$inferInsert
export type GraphEdgeInsert = typeof securityGraphEdges.$inferInsert
export type GraphProvenanceInsert = typeof securityGraphProvenance.$inferInsert
export type GraphGapInsert = typeof securityGraphGaps.$inferInsert

/** A database handle or an open transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export const newGraphNodeId = () => newId('gn')
export const newGraphEdgeId = () => newId('ge')
export const newGraphProvenanceId = () => newId('gp')
export const newGraphGapId = () => newId('gg')

/** Runs `fn` in a transaction holding the engagement's graph lock (released at commit/rollback). */
export async function withGraphLock<T>(db: Db, engagementId: string, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`security-graph:${engagementId}`}))`)
    return fn(tx)
  })
}

export interface GraphRows {
  nodes: GraphNodeRow[]
  edges: GraphEdgeRow[]
  provenance: GraphProvenanceRow[]
  gaps: GraphGapRow[]
}

/** Everything stored for an engagement's graph (the projector diffs against it). */
export async function loadGraphRows(db: DbOrTx, engagementId: string): Promise<GraphRows> {
  // Sequential on purpose: inside a transaction every query shares one client.
  const nodes = await db.select().from(securityGraphNodes).where(eq(securityGraphNodes.engagementId, engagementId))
  const edges = await db.select().from(securityGraphEdges).where(eq(securityGraphEdges.engagementId, engagementId))
  const provenance = await db.select().from(securityGraphProvenance).where(eq(securityGraphProvenance.engagementId, engagementId))
  const gaps = await db.select().from(securityGraphGaps).where(eq(securityGraphGaps.engagementId, engagementId))
  return { nodes, edges, provenance, gaps }
}

/** Every observation of an engagement (inside the graph lock, so a projection sees one consistent set). */
export async function listObservationsForGraph(db: DbOrTx, engagementId: string, limit = 20_000): Promise<SecurityObservation[]> {
  const rows = await db.select().from(securityObservations).where(eq(securityObservations.engagementId, engagementId)).orderBy(asc(securityObservations.id)).limit(limit)
  return rows.map(toObservation)
}

/** What staleness needs about each execution: capability, the URL it targeted, status and sensor result state. */
export async function listExecutionFactsForGraph(
  db: DbOrTx,
  engagementId: string,
): Promise<{ id: string; capabilityId: string; target: string | null; status: string; sensorState: string | null; finishedAt: string | null }[]> {
  const rows = await db
    .select({
      id: securityExecutions.id,
      capabilityId: securityExecutions.capabilityId,
      status: securityExecutions.status,
      target: sql<string | null>`${securityExecutions.snapshot}->'input'->>'url'`,
      sensorState: sql<string | null>`${securityExecutions.result}->'output'->>'state'`,
      finishedAt: securityExecutions.finishedAt,
    })
    .from(securityExecutions)
    .where(eq(securityExecutions.engagementId, engagementId))
  return rows.map((r) => ({ ...r, finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null }))
}

const CHUNK = 200
async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK))
}

export async function insertGraphNodes(db: DbOrTx, rows: GraphNodeInsert[]): Promise<void> {
  await insertChunked(rows, (chunk) => db.insert(securityGraphNodes).values(chunk))
}
export async function insertGraphEdges(db: DbOrTx, rows: GraphEdgeInsert[]): Promise<void> {
  await insertChunked(rows, (chunk) => db.insert(securityGraphEdges).values(chunk))
}
export async function insertGraphProvenance(db: DbOrTx, rows: GraphProvenanceInsert[]): Promise<void> {
  // Redaction at the persistence boundary, like observations and evidence.
  await insertChunked(
    rows.map((r) => ({ ...r, rationale: r.rationale ? redactSensitive({ t: r.rationale }).value.t : r.rationale })),
    (chunk) => db.insert(securityGraphProvenance).values(chunk),
  )
}
export async function insertGraphGaps(db: DbOrTx, rows: GraphGapInsert[]): Promise<void> {
  await insertChunked(rows, (chunk) => db.insert(securityGraphGaps).values(chunk))
}

export async function updateGraphNode(db: DbOrTx, id: string, patch: Partial<GraphNodeInsert>): Promise<void> {
  await db.update(securityGraphNodes).set(patch).where(eq(securityGraphNodes.id, id))
}
export async function updateGraphEdge(db: DbOrTx, id: string, patch: Partial<GraphEdgeInsert>): Promise<void> {
  await db.update(securityGraphEdges).set(patch).where(eq(securityGraphEdges.id, id))
}
export async function updateGraphProvenance(db: DbOrTx, id: string, patch: Partial<GraphProvenanceInsert>): Promise<void> {
  await db.update(securityGraphProvenance).set(patch).where(eq(securityGraphProvenance.id, id))
}
export async function updateGraphGap(db: DbOrTx, id: string, patch: Partial<GraphGapInsert>): Promise<void> {
  await db.update(securityGraphGaps).set(patch).where(eq(securityGraphGaps.id, id))
}

// ── Converters ───────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString()

export function toGraphNode(row: GraphNodeRow): SecurityGraphNode {
  return {
    id: row.id,
    engagementId: row.engagementId,
    kind: row.kind,
    key: row.key,
    label: row.label,
    attributes: row.attributes,
    scopeClass: row.scopeClass,
    basis: row.basis,
    confidence: row.confidence,
    corroboration: row.corroboration,
    tools: row.tools,
    status: row.status,
    statusReason: row.statusReason,
    conflicts: row.conflicts,
    firstObservedAt: iso(row.firstObservedAt),
    lastObservedAt: iso(row.lastObservedAt),
    firstExecutionId: row.firstExecutionId,
    lastExecutionId: row.lastExecutionId,
    updatedAt: iso(row.updatedAt),
  }
}

export function toGraphEdge(row: GraphEdgeRow, keys: Map<string, string>): SecurityGraphEdge {
  return {
    id: row.id,
    engagementId: row.engagementId,
    type: row.type,
    key: row.key,
    fromId: row.fromNodeId,
    toId: row.toNodeId,
    fromKey: keys.get(row.fromNodeId) ?? '',
    toKey: keys.get(row.toNodeId) ?? '',
    attributes: row.attributes,
    basis: row.basis,
    confidence: row.confidence,
    corroboration: row.corroboration,
    tools: row.tools,
    status: row.status,
    statusReason: row.statusReason,
    conflicts: row.conflicts,
    firstObservedAt: iso(row.firstObservedAt),
    lastObservedAt: iso(row.lastObservedAt),
    firstExecutionId: row.firstExecutionId,
    lastExecutionId: row.lastExecutionId,
    updatedAt: iso(row.updatedAt),
  }
}

export function toGraphProvenance(row: GraphProvenanceRow): SecurityGraphProvenance {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    source: row.source,
    trust: row.trust,
    sourceRef: row.sourceRef,
    observationId: row.observationId,
    evidenceRefs: row.evidenceRefs,
    executionIds: row.executionIds,
    capabilityIds: row.capabilityIds,
    tools: row.tools,
    confidence: row.confidence,
    rationale: row.rationale,
    reasoningRunId: row.reasoningRunId,
    firstAt: iso(row.firstAt),
    lastAt: iso(row.lastAt),
  }
}

export function toKnowledgeGap(row: GraphGapRow): KnowledgeGap {
  return {
    id: row.id,
    engagementId: row.engagementId,
    kind: row.kind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectKey: row.subjectKey,
    question: row.question,
    status: row.status,
    resolution: row.resolution,
    resolvedBy: row.resolvedBy ?? null,
    answeredBy: row.answeredBy,
    firstDetectedAt: iso(row.firstDetectedAt),
    resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    updatedAt: iso(row.updatedAt),
  }
}

// ── Bounded reads for the API ────────────────────────────────────────────────────────────────────────

export interface ListGraphNodesOptions {
  kind?: GraphEntityKind
  status?: FactStatus
  basis?: KnowledgeBasis
  /** Case-insensitive substring of the label or key. */
  q?: string
  limit?: number
}

export async function listGraphNodes(db: DbOrTx, engagementId: string, options: ListGraphNodesOptions = {}): Promise<SecurityGraphNode[]> {
  const q = options.q?.trim().toLowerCase()
  const rows = await db
    .select()
    .from(securityGraphNodes)
    .where(
      and(
        eq(securityGraphNodes.engagementId, engagementId),
        options.kind ? eq(securityGraphNodes.kind, options.kind) : undefined,
        options.status ? eq(securityGraphNodes.status, options.status) : undefined,
        options.basis ? eq(securityGraphNodes.basis, options.basis) : undefined,
        q ? or(sql`lower(${securityGraphNodes.label}) like ${`%${q}%`}`, sql`lower(${securityGraphNodes.key}) like ${`%${q}%`}`) : undefined,
      ),
    )
    .orderBy(asc(securityGraphNodes.kind), asc(securityGraphNodes.key))
    .limit(Math.min(options.limit ?? 500, 1000))
  return rows.map(toGraphNode)
}

export async function getGraphNodeRow(db: DbOrTx, id: string): Promise<GraphNodeRow | undefined> {
  const [row] = await db.select().from(securityGraphNodes).where(eq(securityGraphNodes.id, id))
  return row
}

export async function getGraphNodeRows(db: DbOrTx, ids: string[]): Promise<GraphNodeRow[]> {
  if (ids.length === 0) return []
  return db.select().from(securityGraphNodes).where(inArray(securityGraphNodes.id, ids))
}

/** Edges touching any of the nodes, newest first, bounded. */
export async function listEdgesTouching(db: DbOrTx, nodeIds: string[], limit = 300): Promise<GraphEdgeRow[]> {
  if (nodeIds.length === 0) return []
  return db
    .select()
    .from(securityGraphEdges)
    .where(or(inArray(securityGraphEdges.fromNodeId, nodeIds), inArray(securityGraphEdges.toNodeId, nodeIds)))
    .orderBy(desc(securityGraphEdges.lastObservedAt))
    .limit(limit)
}

export interface ListGraphEdgesOptions {
  type?: GraphRelationType
  status?: FactStatus
  basis?: KnowledgeBasis
  limit?: number
}

export async function listGraphEdgeRows(db: DbOrTx, engagementId: string, options: ListGraphEdgesOptions = {}): Promise<GraphEdgeRow[]> {
  return db
    .select()
    .from(securityGraphEdges)
    .where(
      and(
        eq(securityGraphEdges.engagementId, engagementId),
        options.type ? eq(securityGraphEdges.type, options.type) : undefined,
        options.status ? eq(securityGraphEdges.status, options.status) : undefined,
        options.basis ? eq(securityGraphEdges.basis, options.basis) : undefined,
      ),
    )
    .orderBy(asc(securityGraphEdges.type), asc(securityGraphEdges.key))
    .limit(Math.min(options.limit ?? 500, 2000))
}

/** id → key for the given node ids (to render edge endpoints). */
export async function nodeKeysById(db: DbOrTx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: securityGraphNodes.id, key: securityGraphNodes.key }).from(securityGraphNodes).where(inArray(securityGraphNodes.id, [...new Set(ids)]))
  return new Map(rows.map((r) => [r.id, r.key]))
}

export async function listProvenanceFor(db: DbOrTx, subjectIds: string[], limit = 200): Promise<SecurityGraphProvenance[]> {
  if (subjectIds.length === 0) return []
  const rows = await db
    .select()
    .from(securityGraphProvenance)
    .where(inArray(securityGraphProvenance.subjectId, subjectIds))
    .orderBy(desc(securityGraphProvenance.lastAt))
    .limit(limit)
  return rows.map(toGraphProvenance)
}

/** Graph facts an observation supports (observation → entities). */
export async function listProvenanceForObservations(db: DbOrTx, engagementId: string, observationIds: string[]): Promise<GraphProvenanceRow[]> {
  if (observationIds.length === 0) return []
  return db
    .select()
    .from(securityGraphProvenance)
    .where(and(eq(securityGraphProvenance.engagementId, engagementId), inArray(securityGraphProvenance.observationId, observationIds)))
}

export async function listKnowledgeGaps(db: DbOrTx, engagementId: string, options: { status?: GapStatus; subjectIds?: string[]; limit?: number } = {}): Promise<KnowledgeGap[]> {
  const rows = await db
    .select()
    .from(securityGraphGaps)
    .where(
      and(
        eq(securityGraphGaps.engagementId, engagementId),
        options.status ? eq(securityGraphGaps.status, options.status) : undefined,
        options.subjectIds ? (options.subjectIds.length ? inArray(securityGraphGaps.subjectId, options.subjectIds) : sql`false`) : undefined,
      ),
    )
    .orderBy(asc(securityGraphGaps.status), asc(securityGraphGaps.kind), asc(securityGraphGaps.subjectKey))
    .limit(Math.min(options.limit ?? 500, 2000))
  return rows.map(toKnowledgeGap)
}

export interface GraphCounts {
  byKind: Record<string, number>
  byRelation: Record<string, number>
  byBasis: Record<string, number>
  byStatus: Record<string, number>
  edgeByBasis: Record<string, number>
  edgeByStatus: Record<string, number>
  gaps: { kind: string; status: string; n: number }[]
  lastChangedAt: Date | null
}

export async function graphCounts(db: DbOrTx, engagementId: string): Promise<GraphCounts> {
  const n = sql<number>`count(*)::int`
  const [kinds, relations, bases, statuses, edgeBases, edgeStatuses, gaps, latest] = await Promise.all([
    db.select({ k: securityGraphNodes.kind, n }).from(securityGraphNodes).where(eq(securityGraphNodes.engagementId, engagementId)).groupBy(securityGraphNodes.kind),
    db.select({ k: securityGraphEdges.type, n }).from(securityGraphEdges).where(eq(securityGraphEdges.engagementId, engagementId)).groupBy(securityGraphEdges.type),
    db.select({ k: securityGraphNodes.basis, n }).from(securityGraphNodes).where(eq(securityGraphNodes.engagementId, engagementId)).groupBy(securityGraphNodes.basis),
    db.select({ k: securityGraphNodes.status, n }).from(securityGraphNodes).where(eq(securityGraphNodes.engagementId, engagementId)).groupBy(securityGraphNodes.status),
    db.select({ k: securityGraphEdges.basis, n }).from(securityGraphEdges).where(eq(securityGraphEdges.engagementId, engagementId)).groupBy(securityGraphEdges.basis),
    db.select({ k: securityGraphEdges.status, n }).from(securityGraphEdges).where(eq(securityGraphEdges.engagementId, engagementId)).groupBy(securityGraphEdges.status),
    db
      .select({ kind: securityGraphGaps.kind, status: securityGraphGaps.status, n })
      .from(securityGraphGaps)
      .where(eq(securityGraphGaps.engagementId, engagementId))
      .groupBy(securityGraphGaps.kind, securityGraphGaps.status),
    db.select({ at: sql<Date | null>`max(${securityGraphNodes.updatedAt})` }).from(securityGraphNodes).where(eq(securityGraphNodes.engagementId, engagementId)),
  ])
  const record = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.n]))
  const at = latest[0]?.at
  return {
    byKind: record(kinds),
    byRelation: record(relations),
    byBasis: record(bases),
    byStatus: record(statuses),
    edgeByBasis: record(edgeBases),
    edgeByStatus: record(edgeStatuses),
    gaps,
    lastChangedAt: at ? new Date(at) : null,
  }
}
