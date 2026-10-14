import type { GraphChangeEntry, SecurityGraphEdge, SecurityGraphNode } from '@audivra/contracts'

/*
 * Phase 6C — compare the important security entities/relations of two assessments by their stable graph keys.
 * This is deliberately NOT a generic JSON diff: only a bounded set of security-relevant node kinds and edge
 * types is compared (endpoints, identities, roles, tenants, resources, invariants, findings, and the
 * authorization/finding relations), and a change is reported by key with a short, explainable detail.
 */

const IMPORTANT_NODE_KINDS = new Set(['endpoint', 'identity', 'role', 'tenant', 'resource', 'invariant', 'finding', 'host'])
const IMPORTANT_EDGE_TYPES = new Set(['CAN_ACCESS', 'FINDING_AFFECTS', 'PERMITS', 'OWNS', 'BELONGS_TO_TENANT', 'HAS_ROLE', 'GOVERNED_BY', 'CONTRADICTS'])

export interface GraphSnapshot {
  nodes: SecurityGraphNode[]
  edges: SecurityGraphEdge[]
}

export function diffGraph(previous: GraphSnapshot, current: GraphSnapshot, limit = 200): GraphChangeEntry[] {
  const changes: GraphChangeEntry[] = []
  const prevNodes = new Map(previous.nodes.filter((n) => IMPORTANT_NODE_KINDS.has(n.kind)).map((n) => [n.key, n]))
  const curNodes = new Map(current.nodes.filter((n) => IMPORTANT_NODE_KINDS.has(n.kind)).map((n) => [n.key, n]))
  for (const [key, node] of curNodes) {
    const prev = prevNodes.get(key)
    if (!prev) changes.push({ kind: 'added', element: 'node', entityKind: node.kind, key, label: node.label, detail: `New ${node.kind}` })
    else if (prev.status !== node.status || prev.basis !== node.basis) changes.push({ kind: 'changed', element: 'node', entityKind: node.kind, key, label: node.label, detail: `status ${prev.status}→${node.status}, basis ${prev.basis}→${node.basis}` })
  }
  for (const [key, node] of prevNodes) if (!curNodes.has(key)) changes.push({ kind: 'removed', element: 'node', entityKind: node.kind, key, label: node.label, detail: `${node.kind} no longer present` })

  const prevEdges = new Map(previous.edges.filter((e) => IMPORTANT_EDGE_TYPES.has(e.type)).map((e) => [e.key, e]))
  const curEdges = new Map(current.edges.filter((e) => IMPORTANT_EDGE_TYPES.has(e.type)).map((e) => [e.key, e]))
  for (const [key, edge] of curEdges) {
    const prev = prevEdges.get(key)
    const label = `${edge.fromKey} →${edge.type}→ ${edge.toKey}`
    if (!prev) changes.push({ kind: 'added', element: 'edge', entityKind: edge.type, key, label, detail: `New ${edge.type} relationship` })
    else if (prev.status !== edge.status || prev.basis !== edge.basis) changes.push({ kind: 'changed', element: 'edge', entityKind: edge.type, key, label, detail: `status ${prev.status}→${edge.status}, basis ${prev.basis}→${edge.basis}` })
  }
  for (const [key, edge] of prevEdges) if (!curEdges.has(key)) changes.push({ kind: 'removed', element: 'edge', entityKind: edge.type, key, label: `${edge.fromKey} →${edge.type}→ ${edge.toKey}`, detail: `${edge.type} relationship no longer present` })

  return changes.slice(0, limit)
}
