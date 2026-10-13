import type { Logger } from '@audivra/config'
import type { GraphConflict, GraphProjectionResult, SecurityActor, SecurityObservation } from '@audivra/contracts'
import {
  getEngagementRow,
  insertGraphEdges,
  insertGraphGaps,
  insertGraphNodes,
  insertGraphProvenance,
  listComparisonsForEngagement,
  listExecutionFactsForGraph,
  listDomainDeclarationsForGraph,
  listFindingsForEngagement,
  listObservationsForGraph,
  listSessionsForGraph,
  loadGraphRows,
  newGraphEdgeId,
  newGraphGapId,
  newGraphNodeId,
  newGraphProvenanceId,
  recordSecurityEvent,
  updateGraphEdge,
  updateGraphGap,
  updateGraphNode,
  updateGraphProvenance,
  withGraphLock,
  type Db,
  type DbOrTx,
  type GraphEdgeInsert,
  type GraphGapRow,
  type GraphNodeInsert,
  type GraphProvenanceRow,
  type GraphRows,
} from '@audivra/database'
import { grantedAccess } from '../comparison/normalize.ts'
import { deriveGraph, roundConfidence, type FactInput, type FinalFact, type ProvenanceLike } from './derive.ts'
import type { DesiredGraph, DesiredProvenance } from './project.ts'
import { projectGraph, type ComparisonProjection } from './project-domain.ts'
import type { FindingProjection } from './project-findings.ts'
import { FINDING_WORTHY_STATES, type SecurityFinding } from '@audivra/contracts'

/*
 * The graph projector: stored observations → Security Graph, deterministically and idempotently.
 *
 *   lock(engagement) → load observations, executions, stored graph → project (pure) → derive (pure)
 *   → diff against storage → insert new facts / update changed facts / leave unchanged rows untouched
 *
 * Running it twice over the same observations changes nothing the second time (no row is rewritten, no
 * event is emitted). AI-inferred and user-declared provenance is never modified by the projector. Facts are
 * never deleted.
 */

const SYSTEM: SecurityActor = { kind: 'system', id: null, agentRunId: null }

/** Canonical JSON (sorted keys) for change detection. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  return JSON.stringify(value ?? null)
}

const ms = (iso: string) => new Date(iso)

function storedAsProvenance(row: GraphProvenanceRow): ProvenanceLike {
  return {
    source: row.source,
    confidence: row.confidence,
    tools: row.tools,
    executionIds: row.executionIds,
    observationId: row.observationId,
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString(),
  }
}

/** Comparable projection of a fact as stored / as derived. */
function factSignature(f: { label?: string; scopeClass?: unknown; attributes: unknown; basis: string; confidence: number; corroboration: number; tools: string[]; status: string; statusReason: string | null; conflicts: GraphConflict[]; firstObservedAt: string | Date; lastObservedAt: string | Date; firstExecutionId: string | null; lastExecutionId: string | null }) {
  return stableJson({
    label: f.label ?? null,
    scopeClass: f.scopeClass ?? null,
    attributes: f.attributes,
    basis: f.basis,
    confidence: roundConfidence(f.confidence),
    corroboration: f.corroboration,
    tools: f.tools,
    status: f.status,
    statusReason: f.statusReason,
    conflicts: f.conflicts,
    first: new Date(f.firstObservedAt).toISOString(),
    last: new Date(f.lastObservedAt).toISOString(),
    firstExecutionId: f.firstExecutionId,
    lastExecutionId: f.lastExecutionId,
  })
}

function provenanceSignature(p: { evidenceRefs: string[]; executionIds: string[]; capabilityIds: string[]; tools: string[]; confidence: number; rationale: string | null; trust: string; observationId: string | null; firstAt: string | Date; lastAt: string | Date }) {
  return stableJson({
    evidenceRefs: p.evidenceRefs,
    executionIds: p.executionIds,
    capabilityIds: p.capabilityIds,
    tools: p.tools,
    confidence: roundConfidence(p.confidence),
    rationale: p.rationale,
    trust: p.trust,
    observationId: p.observationId,
    firstAt: new Date(p.firstAt).toISOString(),
    lastAt: new Date(p.lastAt).toISOString(),
  })
}

export interface GraphProjectorOptions {
  db: Db
  now?: () => Date
  log?: Logger
}

export class GraphProjector {
  readonly #db: Db
  readonly #now: () => Date
  readonly #log: Logger | undefined

  constructor(options: GraphProjectorOptions) {
    this.#db = options.db
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  /** Projects every stored observation of the engagement into its graph. Idempotent; serialized per engagement. */
  async project(engagementId: string): Promise<GraphProjectionResult> {
    const started = performance.now()
    const engagement = await getEngagementRow(this.#db, engagementId)
    if (!engagement) throw new Error(`No security engagement ${engagementId}`)
    const now = this.#now()
    const { result, newConflictGroups } = await withGraphLock(this.#db, engagementId, async (tx) => {
      // One client per transaction: queries run one after another.
      const observations = await listObservationsForGraph(tx, engagementId)
      const declarations = await listDomainDeclarationsForGraph(tx, engagementId)
      const sessions = await listSessionsForGraph(tx, engagementId)
      const comparisons = toComparisonProjections(await listComparisonsForEngagement(tx, engagementId))
      const findings = toFindingProjections(await listFindingsForEngagement(tx, engagementId))
      const executions = await listExecutionFactsForGraph(tx, engagementId)
      const stored = await loadGraphRows(tx, engagementId)
      const desired = projectGraph({ observations, declarations, sessions, comparisons, findings, manifest: engagement.scope })
      const derived = this.#derive(desired, stored, executions, observations, now.toISOString())
      return this.#apply(tx, engagementId, desired.provenance, derived, stored, observations.length, now)
    })
    result.durationMs = Math.round(performance.now() - started)
    await this.#events(engagementId, engagement.configVersion, result)
    await this.#contradictionEvent(engagementId, engagement.configVersion, newConflictGroups)
    if (result.nodes.added || result.edges.added || result.gaps.opened || result.gaps.resolved) {
      this.#log?.info({ engagementId, nodes: result.nodes, edges: result.edges, gaps: result.gaps }, 'security graph projected')
    }
    return result
  }

  #derive(desired: DesiredGraph, stored: GraphRows, executions: Awaited<ReturnType<typeof listExecutionFactsForGraph>>, observations: SecurityObservation[], now: string) {
    const keyById = new Map(stored.nodes.map((n) => [n.id, n.key]))
    const edgeKeyById = new Map(stored.edges.map((e) => [e.id, e.key]))
    const subjectKey = (row: GraphProvenanceRow) => (row.subjectType === 'node' ? keyById.get(row.subjectId) : edgeKeyById.get(row.subjectId))
    // Desired (deterministic) provenance per fact, plus every stored row the projector does not own.
    const desiredIds = new Set(desired.provenance.map((p) => `${p.subjectType}|${p.subjectKey}|${p.source}|${p.sourceRef}`))
    const provenanceByKey = new Map<string, ProvenanceLike[]>()
    const push = (key: string, row: ProvenanceLike) => provenanceByKey.set(key, [...(provenanceByKey.get(key) ?? []), row])
    for (const p of desired.provenance) push(`${p.subjectType}|${p.subjectKey}`, p)
    for (const row of stored.provenance) {
      const key = subjectKey(row)
      if (!key) continue
      if (desiredIds.has(`${row.subjectType}|${key}|${row.source}|${row.sourceRef}`)) continue
      push(`${row.subjectType}|${key}`, storedAsProvenance(row))
    }

    const facts: FactInput[] = []
    const seen = new Set<string>()
    for (const n of desired.nodes.values()) {
      seen.add(`node|${n.key}`)
      facts.push({ subjectType: 'node', key: n.key, kind: n.kind, label: n.label, scopeClass: n.scopeClass, attributes: n.attributes, provenance: provenanceByKey.get(`node|${n.key}`) ?? [] })
    }
    for (const e of desired.edges.values()) {
      seen.add(`edge|${e.key}`)
      facts.push({ subjectType: 'edge', key: e.key, type: e.type, fromKey: e.fromKey, toKey: e.toKey, scopeClass: null, attributes: e.attributes, provenance: provenanceByKey.get(`edge|${e.key}`) ?? [] })
    }
    // Stored facts the projector does not produce (AI-inferred, declared, or historical): kept and re-aggregated.
    for (const n of stored.nodes) {
      if (seen.has(`node|${n.key}`)) continue
      facts.push({ subjectType: 'node', key: n.key, kind: n.kind, label: n.label, scopeClass: n.scopeClass, attributes: n.attributes, provenance: provenanceByKey.get(`node|${n.key}`) ?? [] })
    }
    for (const e of stored.edges) {
      if (seen.has(`edge|${e.key}`)) continue
      facts.push({ subjectType: 'edge', key: e.key, type: e.type, fromKey: keyById.get(e.fromNodeId), toKey: keyById.get(e.toNodeId), scopeClass: null, attributes: e.attributes, provenance: provenanceByKey.get(`edge|${e.key}`) ?? [] })
    }
    const storedConflicts = new Map<string, GraphConflict[]>([...stored.nodes.map((n) => [n.key, n.conflicts] as const), ...stored.edges.map((e) => [e.key, e.conflicts] as const)])
    return deriveGraph({ facts, desired, executions, observations: new Map(observations.map((o) => [o.id, o])), storedConflicts, now })
  }

  async #apply(
    tx: DbOrTx,
    engagementId: string,
    desiredProvenance: DesiredProvenance[],
    derived: ReturnType<typeof deriveGraph>,
    stored: GraphRows,
    observationCount: number,
    now: Date,
  ): Promise<{ result: GraphProjectionResult; newConflictGroups: string[] }> {
    const result: GraphProjectionResult = {
      observations: observationCount,
      nodes: { added: 0, updated: 0, unchanged: 0 },
      edges: { added: 0, updated: 0, unchanged: 0 },
      provenance: { added: 0, updated: 0 },
      gaps: { opened: 0, resolved: 0 },
      contradictions: derived.conflictGroups.length,
      stale: 0,
      addedByKind: {},
      durationMs: 0,
    }
    const factColumns = (f: FinalFact) => ({
      attributes: f.attributes,
      basis: f.basis,
      confidence: roundConfidence(f.confidence),
      corroboration: f.corroboration,
      tools: f.tools,
      status: f.status,
      statusReason: f.statusReason,
      conflicts: f.conflicts,
      firstObservedAt: ms(f.firstObservedAt),
      lastObservedAt: ms(f.lastObservedAt),
      firstExecutionId: f.firstExecutionId,
      lastExecutionId: f.lastExecutionId,
    })

    // Nodes.
    const nodeIdByKey = new Map(stored.nodes.map((n) => [n.key, n.id]))
    const storedNodes = new Map(stored.nodes.map((n) => [n.key, n]))
    const newNodes: GraphNodeInsert[] = []
    for (const f of derived.nodes.values()) {
      if (f.status === 'stale') result.stale++
      const existing = storedNodes.get(f.key)
      if (!existing) {
        const id = newGraphNodeId()
        nodeIdByKey.set(f.key, id)
        newNodes.push({ id, engagementId, kind: f.kind!, key: f.key, label: f.label ?? f.key, scopeClass: f.scopeClass, ...factColumns(f), createdAt: now, updatedAt: now })
        result.nodes.added++
        result.addedByKind[f.kind!] = (result.addedByKind[f.kind!] ?? 0) + 1
        continue
      }
      if (factSignature({ ...existing, label: existing.label, scopeClass: existing.scopeClass }) === factSignature({ ...f, label: f.label ?? existing.label })) {
        result.nodes.unchanged++
        continue
      }
      await updateGraphNode(tx, existing.id, { label: f.label ?? existing.label, scopeClass: f.scopeClass, ...factColumns(f), updatedAt: now })
      result.nodes.updated++
    }
    await insertGraphNodes(tx, newNodes)

    // Edges.
    const edgeIdByKey = new Map(stored.edges.map((e) => [e.key, e.id]))
    const storedEdges = new Map(stored.edges.map((e) => [e.key, e]))
    const newEdges: GraphEdgeInsert[] = []
    for (const f of derived.edges.values()) {
      if (f.status === 'stale') result.stale++
      const existing = storedEdges.get(f.key)
      if (!existing) {
        const fromId = nodeIdByKey.get(f.fromKey!)
        const toId = nodeIdByKey.get(f.toKey!)
        if (!fromId || !toId) continue
        const id = newGraphEdgeId()
        edgeIdByKey.set(f.key, id)
        newEdges.push({ id, engagementId, type: f.type!, key: f.key, fromNodeId: fromId, toNodeId: toId, ...factColumns(f), createdAt: now, updatedAt: now })
        result.edges.added++
        continue
      }
      if (factSignature(existing) === factSignature(f)) {
        result.edges.unchanged++
        continue
      }
      await updateGraphEdge(tx, existing.id, { ...factColumns(f), updatedAt: now })
      result.edges.updated++
    }
    await insertGraphEdges(tx, newEdges)

    // Deterministic provenance (the projector owns observation/derivation rows only).
    const storedProvenance = new Map(stored.provenance.map((p) => [`${p.subjectType}|${p.subjectId}|${p.source}|${p.sourceRef}`, p]))
    const newProvenance: Parameters<typeof insertGraphProvenance>[1] = []
    for (const p of desiredProvenance) {
      const subjectId = p.subjectType === 'node' ? nodeIdByKey.get(p.subjectKey) : edgeIdByKey.get(p.subjectKey)
      if (!subjectId) continue
      const existing = storedProvenance.get(`${p.subjectType}|${subjectId}|${p.source}|${p.sourceRef}`)
      const columns = {
        trust: p.trust,
        observationId: p.observationId,
        evidenceRefs: p.evidenceRefs,
        executionIds: p.executionIds,
        capabilityIds: p.capabilityIds,
        tools: p.tools,
        confidence: roundConfidence(p.confidence),
        rationale: p.rationale,
        firstAt: ms(p.firstAt),
        lastAt: ms(p.lastAt),
      }
      if (!existing) {
        newProvenance.push({ id: newGraphProvenanceId(), engagementId, subjectType: p.subjectType, subjectId, source: p.source, sourceRef: p.sourceRef, reasoningRunId: null, ...columns, createdAt: now, updatedAt: now })
        result.provenance.added++
      } else if (provenanceSignature(existing) !== provenanceSignature(columns)) {
        await updateGraphProvenance(tx, existing.id, { ...columns, updatedAt: now })
        result.provenance.updated++
      }
    }
    await insertGraphProvenance(tx, newProvenance)

    // Knowledge gaps: open new unknowns, resolve answered ones, never delete history.
    const storedGaps = new Map<string, GraphGapRow>(stored.gaps.map((g) => [`${g.kind}|${g.subjectKey}`, g]))
    const desiredGapKeys = new Set<string>()
    const newGaps: Parameters<typeof insertGraphGaps>[1] = []
    for (const g of derived.gaps) {
      const key = `${g.kind}|${g.subjectKey}`
      desiredGapKeys.add(key)
      const existing = storedGaps.get(key)
      const subjectId = nodeIdByKey.get(g.entityKey)
      if (!subjectId) continue
      if (g.state === 'open') {
        if (!existing) {
          newGaps.push({ id: newGraphGapId(), engagementId, kind: g.kind, subjectType: g.subjectType, subjectId, subjectKey: g.subjectKey, question: g.question, status: 'open', answeredBy: g.answeredBy, firstDetectedAt: now, updatedAt: now })
          result.gaps.opened++
        } else if (existing.status !== 'open' || existing.question !== g.question || stableJson(existing.answeredBy) !== stableJson(g.answeredBy)) {
          if (existing.status !== 'open') result.gaps.opened++
          await updateGraphGap(tx, existing.id, { status: 'open', question: g.question, answeredBy: g.answeredBy, resolution: null, resolvedBy: null, resolvedAt: null, updatedAt: now })
        }
      } else if (existing && existing.status === 'open') {
        await updateGraphGap(tx, existing.id, { status: g.state, resolution: g.resolution, resolvedBy: g.resolvedBy, resolvedAt: now, updatedAt: now })
        if (g.state === 'resolved') result.gaps.resolved++
      }
    }
    // Open gaps whose subject no longer produces one (a conflict that went away): resolved, with the reason.
    for (const [key, existing] of storedGaps) {
      if (desiredGapKeys.has(key) || existing.status !== 'open') continue
      const resolution = existing.kind === 'contradiction-unresolved' ? 'The conflict is no longer present (one of the facts is stale or was superseded)' : 'No longer applicable to the current graph'
      await updateGraphGap(tx, existing.id, { status: existing.kind === 'contradiction-unresolved' ? 'resolved' : 'not-applicable', resolution, resolvedAt: now, updatedAt: now })
      if (existing.kind === 'contradiction-unresolved') result.gaps.resolved++
    }
    await insertGraphGaps(tx, newGaps)
    const storedGroups = new Set([...stored.nodes, ...stored.edges].flatMap((f) => f.conflicts.map((c) => c.group)))
    return { result, newConflictGroups: derived.conflictGroups.filter((g) => !storedGroups.has(g)) }
  }

  /** Concise timeline events — one per projection that changed something, never one per entity. */
  async #events(engagementId: string, configVersion: number, r: GraphProjectionResult): Promise<void> {
    const kinds = Object.entries(r.addedByKind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
      .join(', ')
    if (r.nodes.added) {
      await recordSecurityEvent(this.#db, { engagementId, type: 'graph.entity-discovered', message: `Security graph: ${r.nodes.added} new entit${r.nodes.added === 1 ? 'y' : 'ies'} (${kinds})`, actor: SYSTEM, configVersion, data: { addedByKind: r.addedByKind, observations: r.observations } })
    }
    if (r.edges.added) {
      await recordSecurityEvent(this.#db, { engagementId, type: 'graph.relationship-added', message: `Security graph: ${r.edges.added} new relationship${r.edges.added === 1 ? '' : 's'}`, actor: SYSTEM, configVersion, data: { edges: r.edges } })
    }
    if (r.gaps.opened || r.gaps.resolved) {
      // Gap changes ride on the relationship/entity events' data; a separate event only when nothing else changed.
      if (!r.nodes.added && !r.edges.added) {
        await recordSecurityEvent(this.#db, { engagementId, type: 'graph.relationship-added', message: `Security graph: ${r.gaps.resolved} unknown${r.gaps.resolved === 1 ? '' : 's'} answered, ${r.gaps.opened} new`, actor: SYSTEM, configVersion, data: { gaps: r.gaps } })
      }
    }
  }

  /** A newly detected conflict between active facts (both kept; later reasoning resolves it). */
  async #contradictionEvent(engagementId: string, configVersion: number, groups: string[]): Promise<void> {
    if (groups.length === 0) return
    await recordSecurityEvent(this.#db, { engagementId, type: 'graph.contradiction-detected', level: 'warn', message: `Security graph: conflicting facts detected (${groups.slice(0, 3).join('; ')})`, actor: SYSTEM, configVersion, data: { groups } })
  }
}

/** Maps stored comparisons to the projector's secret-free view (per-arm access computed deterministically). */
function toComparisonProjections(comparisons: Awaited<ReturnType<typeof listComparisonsForEngagement>>): ComparisonProjection[] {
  return comparisons.map((c) => ({
    id: c.id,
    dimension: c.dimension,
    resourceRef: c.resourceRef,
    invariantRef: c.invariantRef,
    result: c.result,
    invariantEvaluation: c.invariantEvaluation,
    confidence: c.confidence,
    controls: c.controls,
    at: c.updatedAt,
    arms: c.arms
      .filter((a) => a.status === 'executed' && a.observation)
      .map((a) => ({ identityRef: a.identityRef, granted: grantedAccess(a.observation!), executionId: a.executionId, evidenceRefs: a.observation!.evidenceRefs })),
  }))
}

/** Maps stored findings to the projector's view; only verified/supported findings become graph nodes. */
function toFindingProjections(findings: SecurityFinding[]): FindingProjection[] {
  return findings
    .filter((f) => FINDING_WORTHY_STATES.includes(f.verificationState))
    .map((f) => ({
      issueKey: f.issueKey,
      title: f.title,
      category: f.category,
      severity: f.severity,
      verificationState: f.verificationState,
      status: f.status,
      confidence: f.confidence,
      fromComparison: f.comparisonIds.length > 0,
      affectedEntityKeys: f.affectedEntities.map((e) => e.key),
      invariantKeys: f.invariantRefs,
      evidenceRefs: f.evidenceRefs,
      executionIds: f.reproduction?.executionIds ?? [],
      at: f.updatedAt,
    }))
}
