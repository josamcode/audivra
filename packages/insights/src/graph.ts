import type {
  EvidenceGraph,
  EvidenceItem,
  FindingItem,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  JourneyItem,
} from '@audivra/contracts'
import {
  listAgentRunRows,
  listArtifacts,
  listEvidenceProvenance,
  listFindings,
  listJourneys,
  listPages,
  listToolRuns,
  type Db,
} from '@audivra/database'
import { pagePath } from './catalog.ts'

/**
 * Evidence graph: a bounded neighbourhood of one finding, evidence item, journey, page or artifact.
 * Every edge comes from a stored relationship — finding↔evidence links, evidence page URLs and the
 * run that produced it, finding↔journey links, journey step evidence and artifact references.
 */

export interface GraphInput {
  findings: Pick<FindingItem, 'ref' | 'title' | 'severity' | 'category' | 'type' | 'verificationStatus' | 'evidenceRefs' | 'journeyRefs' | 'affectedUrls'>[]
  evidence: (Pick<EvidenceItem, 'ref' | 'type' | 'title' | 'url' | 'source'> & { toolRunId: string | null; agentRunId: string | null })[]
  journeys: Pick<JourneyItem, 'ref' | 'name' | 'type' | 'isPrimary' | 'steps' | 'health'>[]
  artifacts: { ref: string; title: string; type: string; evidenceRefs: string[]; findingRefs: string[] }[]
  toolRuns: { id: string; tool: string; purpose: string; status: string }[]
  agentRuns: { id: string; role: string; status: string }[]
  pages: { url: string; title: string | null; pageType: string | null }[]
}

export const GRAPH_MAX_DEPTH = 3
export const GRAPH_MAX_NODES = 36

const KIND_ORDER: Record<GraphNodeKind, number> = { finding: 0, journey: 1, evidence: 2, page: 3, tool: 4, artifact: 5 }
/**
 * Pages, runs, visuals and journeys connect to much of an audit (every capture on the home page,
 * everything the auditor recorded, an impact/effort matrix of all findings, every step of a journey),
 * so walking through them pulls in unrelated items. They are shown as context and only expanded when
 * they are the focus; the walk itself goes finding ↔ evidence.
 */
const HUB_KINDS: ReadonlySet<GraphNodeKind> = new Set(['page', 'tool', 'artifact', 'journey'])
const ROLE_NAMES: Record<string, string> = {
  auditor: 'AI auditor',
  revision: 'AI auditor (verification)',
  reviewer: 'AI reviewer',
  planner: 'Artifact planner',
  journeys: 'Journey analysis',
}

/** Page identity: URL without fragment, trailing slash or default noise. */
export function pageKey(url: string): string {
  return url.split('#')[0]!.replace(/\/+$/, '')
}

/** "www.example.com/contact": the host stays visible because www and apex are different pages. */
function pageLabel(url: string): string {
  try {
    const parsed = new URL(url)
    // http:// stays visible too: an http page and its https redirect target are both evidence.
    const scheme = parsed.protocol === 'https:' ? '' : `${parsed.protocol}//`
    return `${scheme}${parsed.host}${parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return pagePath(url) || url
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

class GraphIndex {
  readonly nodes = new Map<string, Omit<GraphNode, 'distance'>>()
  readonly adjacency = new Map<string, { to: string; edge: GraphEdge }[]>()

  addNode(node: Omit<GraphNode, 'distance'>) {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node)
  }

  addEdge(from: string, to: string, kind: GraphEdgeKind) {
    if (!this.nodes.has(from) || !this.nodes.has(to) || from === to) return
    const id = `${kind}:${from}->${to}`
    const edge: GraphEdge = { id, from, to, kind }
    for (const [a, b] of [
      [from, to],
      [to, from],
    ] as const) {
      const list = this.adjacency.get(a) ?? []
      if (!list.some((l) => l.edge.id === id)) list.push({ to: b, edge })
      this.adjacency.set(a, list)
    }
  }
}

function buildIndex(input: GraphInput): GraphIndex {
  const g = new GraphIndex()
  const pageInfo = new Map(input.pages.map((p) => [pageKey(p.url), p]))
  const pageNode = (url: string) => {
    const key = pageKey(url)
    const info = pageInfo.get(key)
    const id = `page:${key}`
    g.addNode({ id, kind: 'page', label: pageLabel(url), sublabel: info?.title ?? info?.pageType ?? null, ref: key, severity: null, status: null, url })
    return id
  }

  for (const f of input.findings) {
    g.addNode({
      id: `finding:${f.ref}`,
      kind: 'finding',
      label: clip(f.title, 140),
      sublabel: `${f.ref} · ${f.category}`,
      ref: f.ref,
      severity: f.severity,
      status: f.type,
      url: null,
    })
  }
  for (const j of input.journeys) {
    g.addNode({
      id: `journey:${j.ref}`,
      kind: 'journey',
      label: j.name,
      sublabel: `${j.ref} · ${j.isPrimary ? 'primary · ' : ''}${j.steps.map((s) => s.label).join(' → ')}`,
      ref: j.ref,
      severity: null,
      status: j.type,
      url: null,
    })
  }
  const tools = new Map(input.toolRuns.map((t) => [t.id, t]))
  const agents = new Map(input.agentRuns.map((a) => [a.id, a]))
  for (const e of input.evidence) {
    g.addNode({ id: `evidence:${e.ref}`, kind: 'evidence', label: clip(e.title, 140), sublabel: e.ref, ref: e.ref, severity: null, status: e.type, url: e.url })
    if (e.url && /^https?:\/\//i.test(e.url)) g.addEdge(`evidence:${e.ref}`, pageNode(e.url), 'captured-on')
    const tool = e.toolRunId ? tools.get(e.toolRunId) : undefined
    const agent = !tool && e.agentRunId ? agents.get(e.agentRunId) : undefined
    if (tool) {
      const id = `tool:${tool.id}`
      g.addNode({ id, kind: 'tool', label: tool.tool, sublabel: clip(tool.purpose, 80), ref: tool.id, severity: null, status: tool.status, url: null })
      g.addEdge(`evidence:${e.ref}`, id, 'produced-by')
    } else if (agent) {
      const id = `tool:${agent.id}`
      g.addNode({ id, kind: 'tool', label: ROLE_NAMES[agent.role] ?? agent.role, sublabel: 'Recorded during the AI investigation', ref: agent.id, severity: null, status: agent.status, url: null })
      g.addEdge(`evidence:${e.ref}`, id, 'produced-by')
    }
  }
  for (const f of input.findings) {
    for (const ref of f.evidenceRefs) g.addEdge(`finding:${f.ref}`, `evidence:${ref}`, 'supported-by')
    for (const ref of f.journeyRefs) g.addEdge(`finding:${f.ref}`, `journey:${ref}`, 'affects')
    for (const url of f.affectedUrls) if (/^https?:\/\//i.test(url)) g.addEdge(`finding:${f.ref}`, pageNode(url), 'affects-page')
  }
  for (const j of input.journeys) {
    const refs = new Set([...j.steps.flatMap((s) => s.evidenceIds), ...j.health.flatMap((h) => h.evidenceIds)])
    for (const ref of refs) g.addEdge(`journey:${j.ref}`, `evidence:${ref}`, 'step-evidence')
  }
  for (const a of input.artifacts) {
    g.addNode({ id: `artifact:${a.ref}`, kind: 'artifact', label: clip(a.title, 120), sublabel: `${a.ref} · ${a.type.replaceAll('_', ' ')}`, ref: a.ref, severity: null, status: a.type, url: null })
    for (const ref of a.findingRefs) g.addEdge(`artifact:${a.ref}`, `finding:${ref}`, 'visualizes')
    for (const ref of a.evidenceRefs) g.addEdge(`artifact:${a.ref}`, `evidence:${ref}`, 'derived-from')
  }
  return g
}

/** Parses "finding:F3" style focus strings; page focus takes a URL. */
export function parseFocus(focus: string): { kind: GraphNodeKind; key: string } | null {
  const match = focus.match(/^(finding|evidence|page|journey|tool|artifact):(.+)$/)
  if (!match) return null
  const kind = match[1] as GraphNodeKind
  return { kind, key: kind === 'page' ? pageKey(match[2]!) : match[2]! }
}

/**
 * The neighbourhood of `focus` up to `depth` hops (1–3), at most `maxNodes` nodes. Nearer nodes win;
 * within a hop, findings and journeys come before evidence, pages, tools and artifacts. Null when the
 * focus does not exist.
 */
export function buildEvidenceGraph(input: GraphInput, focus: string, depth = 2, maxNodes = GRAPH_MAX_NODES): EvidenceGraph | null {
  const parsed = parseFocus(focus)
  if (!parsed) return null
  const g = buildIndex(input)
  const focusId = `${parsed.kind}:${parsed.key}`
  if (!g.nodes.has(focusId)) return null
  const limit = Math.max(1, Math.min(GRAPH_MAX_DEPTH, Math.round(depth)))

  const distance = new Map<string, number>([[focusId, 0]])
  const expands = (id: string) => id === focusId || !HUB_KINDS.has(g.nodes.get(id)!.kind)
  let frontier = [focusId]
  let truncated = false
  for (let hop = 1; hop <= limit && frontier.length; hop++) {
    const next: string[] = []
    for (const id of frontier.filter(expands)) {
      for (const { to } of g.adjacency.get(id) ?? []) {
        if (!distance.has(to) && !next.includes(to)) next.push(to)
      }
    }
    next.sort((a, b) => KIND_ORDER[g.nodes.get(a)!.kind] - KIND_ORDER[g.nodes.get(b)!.kind] || a.localeCompare(b))
    const room = maxNodes - distance.size
    if (next.length > room) truncated = true
    for (const id of next.slice(0, Math.max(0, room))) distance.set(id, hop)
    frontier = next.slice(0, Math.max(0, room))
  }
  // A deeper level exists when some expandable node at the last hop has an unseen neighbour.
  const expandable =
    limit < GRAPH_MAX_DEPTH &&
    [...distance.entries()].some(([id, d]) => d === limit && expands(id) && (g.adjacency.get(id) ?? []).some(({ to }) => !distance.has(to)))

  const nodes: GraphNode[] = [...distance.entries()]
    .map(([id, d]) => ({ ...g.nodes.get(id)!, distance: d }))
    .sort((a, b) => a.distance - b.distance || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id))
  const edges = new Map<string, GraphEdge>()
  for (const id of distance.keys()) {
    for (const { to, edge } of g.adjacency.get(id) ?? []) if (distance.has(to)) edges.set(edge.id, edge)
  }
  return { focus: focusId, depth: limit, nodes, edges: [...edges.values()], truncated, expandable }
}

/** Loads the stored relationships of one audit for graph building (no evidence metadata or prose bodies). */
export async function loadGraphInput(db: Db, auditId: string): Promise<GraphInput> {
  const [findings, evidence, journeys, artifacts, toolRuns, agentRuns, pages] = await Promise.all([
    listFindings(db, auditId),
    listEvidenceProvenance(db, auditId),
    listJourneys(db, auditId),
    listArtifacts(db, auditId),
    listToolRuns(db, auditId),
    listAgentRunRows(db, auditId),
    listPages(db, auditId),
  ])
  return {
    findings,
    evidence,
    journeys,
    artifacts: artifacts.map((a) => ({ ref: a.ref, title: a.title, type: a.type, evidenceRefs: a.evidenceIds, findingRefs: a.findingIds })),
    toolRuns: toolRuns.map((t) => ({ id: t.id, tool: t.tool, purpose: t.purpose, status: t.status })),
    agentRuns: agentRuns.map((a) => ({ id: a.id, role: a.role, status: a.status })),
    pages: pages.map((p) => ({ url: p.url, title: p.title, pageType: p.pageType })),
  }
}
