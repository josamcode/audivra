import type {
  FactStatus,
  GapStatus,
  GraphEntityKind,
  GraphNeighbor,
  GraphProjectionResult,
  GraphRelationType,
  KnowledgeBasis,
  KnowledgeGap,
  SecurityEvidenceItem,
  SecurityGraphEdge,
  SecurityGraphNeighborhood,
  SecurityGraphNode,
  SecurityGraphNodeDetail,
  SecurityGraphSummary,
  SecurityObservation,
} from '@audivra/contracts'
import {
  getEngagementRow,
  getGraphNodeRow,
  getGraphNodeRows,
  getSecurityObservationsByIds,
  graphCounts,
  hypothesisIdsLinkedTo,
  listEdgesTouching,
  listGraphEdgeRows,
  listGraphNodes,
  listKnowledgeGaps,
  listProvenanceFor,
  listSecurityEvidence,
  listSecurityObservations,
  nodeKeysById,
  toGraphEdge,
  toGraphNode,
  type Db,
} from '@audivra/database'
import { SecurityRequestError } from '../service.ts'
import { GraphProjector } from './projector.ts'

/*
 * Read access to the Security Graph for the API. Every query is bounded (entity lists, neighbor lists,
 * neighborhoods of at most two hops); there is no arbitrary graph query. Projection is exposed as a
 * deterministic, idempotent rebuild — it never runs a capability.
 */

const NODE_ID = /^gn_[0-9a-z]{14}$/
const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/
const MAX_NEIGHBORS = 150
const MAX_NEIGHBORHOOD_NODES = 200

export class GraphService {
  readonly #db: Db
  readonly #projector: GraphProjector

  constructor(options: { db: Db; projector?: GraphProjector }) {
    this.#db = options.db
    this.#projector = options.projector ?? new GraphProjector({ db: options.db })
  }

  async project(engagementId: string): Promise<GraphProjectionResult> {
    await this.#engagement(engagementId)
    return this.#projector.project(engagementId)
  }

  async summary(engagementId: string): Promise<SecurityGraphSummary> {
    await this.#engagement(engagementId)
    const counts = await graphCounts(this.#db, engagementId)
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
    const byStatus: Record<string, number> = {}
    for (const [k, v] of [...Object.entries(counts.byStatus), ...Object.entries(counts.edgeByStatus)]) byStatus[k] = (byStatus[k] ?? 0) + v
    const byBasis: Record<string, number> = {}
    for (const [k, v] of [...Object.entries(counts.byBasis), ...Object.entries(counts.edgeByBasis)]) byBasis[k] = (byBasis[k] ?? 0) + v
    const gaps = { open: 0, resolved: 0, byKind: {} as Record<string, { open: number; resolved: number }> }
    for (const g of counts.gaps) {
      const entry = (gaps.byKind[g.kind] ??= { open: 0, resolved: 0 })
      if (g.status === 'open') {
        gaps.open += g.n
        entry.open += g.n
      } else if (g.status === 'resolved') {
        gaps.resolved += g.n
        entry.resolved += g.n
      }
    }
    return {
      entities: sum(counts.byKind),
      relationships: sum(counts.byRelation),
      byKind: counts.byKind,
      byRelation: counts.byRelation,
      byBasis,
      byStatus,
      gaps,
      lastChangedAt: counts.lastChangedAt?.toISOString() ?? null,
    }
  }

  async nodes(engagementId: string, filters: { kind?: GraphEntityKind; status?: FactStatus; basis?: KnowledgeBasis; q?: string; limit?: number } = {}): Promise<SecurityGraphNode[]> {
    await this.#engagement(engagementId)
    return listGraphNodes(this.#db, engagementId, { ...filters, limit: Math.min(filters.limit ?? 500, 1000) })
  }

  async edges(engagementId: string, filters: { type?: GraphRelationType; status?: FactStatus; basis?: KnowledgeBasis; limit?: number } = {}): Promise<SecurityGraphEdge[]> {
    await this.#engagement(engagementId)
    const rows = await listGraphEdgeRows(this.#db, engagementId, filters)
    const keys = await nodeKeysById(this.#db, rows.flatMap((r) => [r.fromNodeId, r.toNodeId]))
    return rows.map((r) => toGraphEdge(r, keys))
  }

  /** One entity: its relationships (bounded), why Audivra believes it, its open/resolved unknowns and hypotheses. */
  async node(nodeId: string): Promise<SecurityGraphNodeDetail> {
    const row = await this.#node(nodeId)
    const edges = await listEdgesTouching(this.#db, [row.id], MAX_NEIGHBORS + 1)
    const truncated = edges.length > MAX_NEIGHBORS
    const kept = edges.slice(0, MAX_NEIGHBORS)
    const otherIds = kept.map((e) => (e.fromNodeId === row.id ? e.toNodeId : e.fromNodeId))
    const others = new Map((await getGraphNodeRows(this.#db, [...new Set(otherIds)])).map((n) => [n.id, n]))
    const keys = new Map([[row.id, row.key], ...[...others.values()].map((n) => [n.id, n.key] as const)])
    const neighbors: GraphNeighbor[] = []
    for (const e of kept) {
      const otherId = e.fromNodeId === row.id ? e.toNodeId : e.fromNodeId
      const other = others.get(otherId)
      if (other) neighbors.push({ edge: toGraphEdge(e, keys), direction: e.fromNodeId === row.id ? 'out' : 'in', node: toGraphNode(other) })
    }
    const [provenance, gaps, hypothesisIds] = await Promise.all([
      listProvenanceFor(this.#db, [row.id], 200),
      listKnowledgeGaps(this.#db, row.engagementId, { subjectIds: [row.id] }),
      hypothesisIdsLinkedTo(this.#db, row.engagementId, 'node', [row.id]),
    ])
    const observations = (await getSecurityObservationsByIds(this.#db, [...new Set(provenance.map((p) => p.observationId).filter((id): id is string => !!id))])).map((o) => ({ id: o.id, type: o.type, title: o.title, asset: o.asset }))
    return { node: toGraphNode(row), neighbors, provenance, observations, gaps, hypothesisIds, truncated }
  }

  /** Entities within one or two hops of an entity (bounded). */
  async neighborhood(nodeId: string, depth = 1): Promise<SecurityGraphNeighborhood> {
    const root = await this.#node(nodeId)
    const hops = Math.min(Math.max(1, Math.trunc(depth) || 1), 2)
    const nodeIds = new Set([root.id])
    const edgeRows = new Map<string, Awaited<ReturnType<typeof listEdgesTouching>>[number]>()
    let frontier = [root.id]
    let truncated = false
    for (let hop = 0; hop < hops && frontier.length; hop++) {
      const edges = await listEdgesTouching(this.#db, frontier, 400)
      const next: string[] = []
      for (const e of edges) {
        edgeRows.set(e.id, e)
        for (const id of [e.fromNodeId, e.toNodeId]) {
          if (nodeIds.has(id)) continue
          if (nodeIds.size >= MAX_NEIGHBORHOOD_NODES) {
            truncated = true
            continue
          }
          nodeIds.add(id)
          next.push(id)
        }
      }
      frontier = next
    }
    const nodes = await getGraphNodeRows(this.#db, [...nodeIds])
    const keys = new Map(nodes.map((n) => [n.id, n.key]))
    const edges = [...edgeRows.values()].filter((e) => keys.has(e.fromNodeId) && keys.has(e.toNodeId)).map((e) => toGraphEdge(e, keys))
    return { focus: root.id, depth: hops, nodes: nodes.map(toGraphNode).sort((a, b) => a.key.localeCompare(b.key)), edges, truncated }
  }

  /** Observations that support an entity (through its provenance). */
  async nodeObservations(nodeId: string): Promise<SecurityObservation[]> {
    const row = await this.#node(nodeId)
    const ids = new Set((await listProvenanceFor(this.#db, [row.id], 500)).map((p) => p.observationId).filter((id): id is string => !!id))
    if (ids.size === 0) return []
    return (await listSecurityObservations(this.#db, row.engagementId, { limit: 20_000 })).filter((o) => ids.has(o.id))
  }

  /** Evidence behind an entity (the raw tool outputs its observations point to). */
  async nodeEvidence(nodeId: string): Promise<SecurityEvidenceItem[]> {
    const row = await this.#node(nodeId)
    const refs = new Set((await listProvenanceFor(this.#db, [row.id], 500)).flatMap((p) => p.evidenceRefs))
    if (refs.size === 0) return []
    return (await listSecurityEvidence(this.#db, row.engagementId)).filter((e) => refs.has(e.ref))
  }

  async gaps(engagementId: string, status?: GapStatus): Promise<KnowledgeGap[]> {
    await this.#engagement(engagementId)
    return listKnowledgeGaps(this.#db, engagementId, { status })
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }

  async #node(id: string) {
    const row = NODE_ID.test(id) ? await getGraphNodeRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Graph entity not found')
    return row
  }
}
