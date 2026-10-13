import type {
  KnowledgeGap,
  ObservationType,
  ReasoningAction,
  RiskClass,
  ScopeManifest,
  SecurityComparison,
  SecurityEnvironment,
  SecurityGraphEdge,
  SecurityGraphNode,
  SecurityHypothesis,
  SecurityObservation,
} from '@audivra/contracts'
import {
  getEngagementRow,
  listComparisonsForEngagement,
  listHypothesisLinks,
  listHypothesisRows,
  listObservationsForGraph,
  listReasoningActionRows,
  loadGraphRows,
  toGraphEdge,
  toGraphNode,
  toHypothesis,
  toKnowledgeGap,
  toReasoningAction,
  type Db,
} from '@audivra/database'
import { z } from 'zod'
import type { CapabilityRegistry } from '../capabilities/registry.ts'

/*
 * A consistent, in-memory view of what Audivra knows about an engagement, loaded once per reasoning stage:
 * the graph, why each entity is believed (observation ids per entity), the open unknowns, the observations,
 * the hypotheses and the actions so far, and the capabilities a planner could use here. Validation,
 * evidence checks, ranking and context selection all read this view — never the model's memory.
 */

export const COST_UNITS: Record<'low' | 'medium' | 'high', number> = { low: 1, medium: 2, high: 4 }

/** A capability as the planner sees it: what it observes, what it needs, what it costs, whether it may run here. */
export interface PlanningCapability {
  id: string
  name: string
  description: string
  tool: string
  riskClass: RiskClass
  sideEffect: string
  costClass: 'low' | 'medium' | 'high'
  costUnits: number
  typicalDurationSeconds: number
  observationTypes: ObservationType[]
  requiredInputs: string[]
  supportedEnvironments: SecurityEnvironment[]
  /** Permitted in this engagement's environment by the capability's own declaration. */
  eligibleHere: boolean
  /** A planner can build its input from graph knowledge alone (it needs only a URL). */
  plannable: boolean
  /** Why it is not eligible/plannable here (null when it is). */
  reason: string | null
  inputSchema: unknown
}

export interface KnowledgeView {
  engagement: { id: string; environment: SecurityEnvironment | null; targetUrl: string; scope: ScopeManifest; configVersion: number }
  nodes: Map<string, SecurityGraphNode>
  nodesByKey: Map<string, SecurityGraphNode>
  edges: SecurityGraphEdge[]
  /** node id → edges touching it. */
  adjacency: Map<string, SecurityGraphEdge[]>
  /** node id → ids of observations that support it (from provenance). */
  observationsByNode: Map<string, Set<string>>
  observations: Map<string, SecurityObservation>
  gaps: Map<string, KnowledgeGap>
  hypotheses: SecurityHypothesis[]
  actions: ReasoningAction[]
  capabilities: PlanningCapability[]
  /** Phase 5 Step 4: stored differential comparisons (evidence for authorization/business hypotheses). */
  comparisons: SecurityComparison[]
}

/** Inputs a planner can satisfy from graph knowledge (a URL); schema/source content is never invented. */
const PLANNABLE_INPUTS = new Set(['url', 'templates'])

export function planningCapabilities(registry: CapabilityRegistry, environment: SecurityEnvironment | null): PlanningCapability[] {
  const env = environment ?? 'production'
  return registry
    .list()
    // Identity-aware capabilities (Step 3/4) are driven by the comparison engine, not the sensor planner
    // (which runs anonymously); keep them out of the Phase 4 candidate set.
    .filter((meta) => meta.sensor && !meta.identity?.supportsIdentity)
    .map((meta) => {
      const sensor = meta.sensor!
      const eligibleHere = meta.supportedEnvironments.includes(env)
      const missing = sensor.requiredInputs.filter((i) => !PLANNABLE_INPUTS.has(i))
      const plannable = missing.length === 0
      const capability = registry.get(meta.id)!
      return {
        id: meta.id,
        name: meta.name,
        description: meta.description,
        tool: sensor.tool,
        riskClass: meta.riskClass,
        sideEffect: meta.sideEffect,
        costClass: sensor.costClass,
        costUnits: COST_UNITS[sensor.costClass],
        typicalDurationSeconds: sensor.typicalDurationSeconds,
        observationTypes: [...sensor.observationTypes],
        requiredInputs: [...sensor.requiredInputs],
        supportedEnvironments: [...meta.supportedEnvironments],
        eligibleHere,
        plannable,
        reason: !eligibleHere ? `Not permitted in the ${env} environment` : !plannable ? `Needs ${missing.join(', ')} input the planner cannot supply from the graph` : null,
        inputSchema: z.toJSONSchema(capability.implementation.input, { io: 'input', unrepresentable: 'any' }),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function loadKnowledge(db: Db, engagementId: string, registry: CapabilityRegistry): Promise<KnowledgeView> {
  const engagement = await getEngagementRow(db, engagementId)
  if (!engagement) throw new Error(`No security engagement ${engagementId}`)
  const [rows, observations, hypothesisRows, actionRows, comparisons] = await Promise.all([
    loadGraphRows(db, engagementId),
    listObservationsForGraph(db, engagementId),
    listHypothesisRows(db, engagementId, { limit: 500 }),
    listReasoningActionRows(db, { engagementId, limit: 1000 }),
    listComparisonsForEngagement(db, engagementId),
  ])
  const links = await listHypothesisLinks(db, hypothesisRows.map((h) => h.id))
  const keys = new Map(rows.nodes.map((n) => [n.id, n.key]))
  const nodes = new Map(rows.nodes.map((n) => [n.id, toGraphNode(n)]))
  const edges = rows.edges.map((e) => toGraphEdge(e, keys))
  const adjacency = new Map<string, SecurityGraphEdge[]>()
  for (const e of edges) {
    adjacency.set(e.fromId, [...(adjacency.get(e.fromId) ?? []), e])
    adjacency.set(e.toId, [...(adjacency.get(e.toId) ?? []), e])
  }
  const observationsByNode = new Map<string, Set<string>>()
  for (const p of rows.provenance) {
    if (p.subjectType !== 'node' || !p.observationId) continue
    const set = observationsByNode.get(p.subjectId) ?? new Set<string>()
    set.add(p.observationId)
    observationsByNode.set(p.subjectId, set)
  }
  return {
    engagement: { id: engagement.id, environment: engagement.environment, targetUrl: engagement.targetUrl, scope: engagement.scope, configVersion: engagement.configVersion },
    nodes,
    nodesByKey: new Map([...nodes.values()].map((n) => [n.key, n])),
    edges,
    adjacency,
    observationsByNode,
    observations: new Map(observations.map((o) => [o.id, o])),
    gaps: new Map(rows.gaps.map((g) => [g.id, toKnowledgeGap(g)])),
    hypotheses: hypothesisRows.map((h) => toHypothesis(h, links)),
    actions: actionRows.map(toReasoningAction),
    capabilities: planningCapabilities(registry, engagement.environment),
    comparisons,
  }
}

/** The URL a capability can target to learn about an entity (endpoint URL, host root, concrete API URL). */
export function entityTargetUrl(node: SecurityGraphNode): string | null {
  if (node.kind === 'endpoint') return typeof node.attributes.url === 'string' ? node.attributes.url : null
  if (node.kind === 'host') return `${node.label}/`
  if (node.kind === 'api-operation') return typeof node.attributes.concreteUrl === 'string' ? node.attributes.concreteUrl : null
  return null
}

/** Ids of an entity and its direct neighbours. */
export function neighbourhood(view: KnowledgeView, ids: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const id of ids) {
    out.add(id)
    for (const e of view.adjacency.get(id) ?? []) out.add(e.fromId === id ? e.toId : e.fromId)
  }
  return out
}

/**
 * Observation ids that support any of the entities (and, when `widen`, their direct neighbours). A host is
 * a hub — every observation on it supports it — so a host is only included when it is itself one of the
 * entities; otherwise any observation on the host would count as "related" to every endpoint on it.
 */
export function observationsAbout(view: KnowledgeView, ids: Iterable<string>, widen = true): Set<string> {
  const own = new Set(ids)
  const out = new Set<string>()
  const scope = widen ? [...neighbourhood(view, own)].filter((id) => own.has(id) || view.nodes.get(id)?.kind !== 'host') : [...own]
  for (const id of scope) for (const o of view.observationsByNode.get(id) ?? []) out.add(o)
  return out
}
