import { z } from 'zod'
import { Severity } from './enums.ts'

/**
 * Evidence graph: why Audivra believes something. Derived on demand from stored relationships only
 * (finding ↔ evidence links, evidence page URLs and producing runs, finding ↔ journey links, journey
 * step evidence, artifact references). Nothing in it is inferred.
 */

export const GRAPH_NODE_KINDS = ['finding', 'evidence', 'page', 'journey', 'tool', 'artifact'] as const
export const GraphNodeKind = z.enum(GRAPH_NODE_KINDS)
export type GraphNodeKind = z.infer<typeof GraphNodeKind>

export const GraphNode = z.object({
  /** `${kind}:${key}`, e.g. "finding:F3", "evidence:EV-12", "page:https://example.com/contact". */
  id: z.string(),
  kind: GraphNodeKind,
  label: z.string(),
  sublabel: z.string().nullable(),
  /** Per-audit reference (F3, EV-12, J1, A2) or the tool run ID / page URL for other kinds. */
  ref: z.string(),
  severity: Severity.nullable(),
  /** Finding type / verification, evidence type, journey type, tool status… */
  status: z.string().nullable(),
  url: z.string().nullable(),
  /** Hops from the focus node. */
  distance: z.number().int().min(0),
})
export type GraphNode = z.infer<typeof GraphNode>

export const GRAPH_EDGE_KINDS = ['supported-by', 'captured-on', 'produced-by', 'affects', 'visualizes', 'derived-from', 'step-evidence', 'affects-page'] as const
export const GraphEdgeKind = z.enum(GRAPH_EDGE_KINDS)
export type GraphEdgeKind = z.infer<typeof GraphEdgeKind>

export const GRAPH_EDGE_LABELS: Record<GraphEdgeKind, string> = {
  'supported-by': 'supported by',
  'captured-on': 'captured on',
  'produced-by': 'produced by',
  affects: 'affects',
  visualizes: 'visualizes',
  'derived-from': 'derived from',
  'step-evidence': 'step evidence',
  'affects-page': 'affects page',
}

export const GraphEdge = z.object({ id: z.string(), from: z.string(), to: z.string(), kind: GraphEdgeKind })
export type GraphEdge = z.infer<typeof GraphEdge>

export const EvidenceGraph = z.object({
  focus: z.string(),
  depth: z.number().int(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  /** Nodes were left out to keep the graph readable. */
  truncated: z.boolean(),
  /** A deeper level exists. */
  expandable: z.boolean(),
})
export type EvidenceGraph = z.infer<typeof EvidenceGraph>
