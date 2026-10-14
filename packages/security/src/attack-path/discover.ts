import type {
  AttackStepReference,
  EdgeVerificationState,
  EndImpact,
  ImpactClass,
  SecurityFinding,
  SecurityGraphEdge,
  SecurityGraphNode,
  StartCondition,
  TrustBoundaryKind,
} from '@audivra/contracts'
import { findingEnablement, IMPACT_RANK, type FindingEnablement } from './conditions.ts'
import { findingEdgeVerification, graphEdgeVerification } from './edges.ts'

/*
 * Phase 6B — deterministic attack-path discovery over stored state. Every path is built from findings and
 * verified graph relationships: a single verified finding that demonstrates meaningful impact is a path on
 * its own, and findings are chained only through a real connector — the SAME principal escalating to a
 * greater impact, or a verified/declared graph edge that connects one finding's reach to the next finding's
 * entity. Search is strictly bounded (depth, candidates, expansions) and cycle-safe (a finding is never
 * revisited within a path), so traversal can never explode combinatorially. Nothing is invented: a chain is
 * emitted only when its connector exists in the graph.
 */

export interface AttackPathView {
  engagementId: string
  environment: string | null
  /** Finding-worthy findings only (supported / verified). */
  findings: SecurityFinding[]
  nodesByKey: Map<string, SecurityGraphNode>
  edges: SecurityGraphEdge[]
  /** fromKey → edges out of it. */
  edgesByFrom: Map<string, SecurityGraphEdge[]>
}

export interface SearchBudget {
  maxDepth: number
  maxCandidatePaths: number
  maxExpansions: number
}

export const DEFAULT_BUDGET: SearchBudget = { maxDepth: 4, maxCandidatePaths: 200, maxExpansions: 2000 }

export interface CandidateStep {
  fromCondition: string
  relationship: string
  toCondition: string
  edgeVerification: EdgeVerificationState
  findingId: string | null
  boundaryCrossed: TrustBoundaryKind | null
  references: AttackStepReference[]
  evidenceRefs: string[]
  rationale: string
}

export interface CandidatePath {
  start: StartCondition
  end: EndImpact
  steps: CandidateStep[]
  findingIds: string[]
  comparisonIds: string[]
  invariantRefs: string[]
  affectedEntityKeys: string[]
  boundariesCrossed: TrustBoundaryKind[]
  impactClass: ImpactClass
  /** Ordered impact-class transitions (for the stable path key). */
  transitions: string[]
  origin: 'deterministic' | 'ai-proposed'
}

export interface DiscoveryStats {
  findings: number
  expansions: number
  candidatePaths: number
  truncated: boolean
  terminationReason: 'complete' | 'max-candidates' | 'max-expansions'
}

type Connector =
  | { kind: 'principal'; edgeVerification: EdgeVerificationState; reference: AttackStepReference; relationship: string; rationale: string }
  | { kind: 'edge'; edge: SecurityGraphEdge; edgeVerification: EdgeVerificationState; reference: AttackStepReference; relationship: string; rationale: string }

export function findingStep(finding: SecurityFinding, enablement: FindingEnablement, fromCondition: string): CandidateStep {
  const references: AttackStepReference[] = [{ kind: 'finding', ref: finding.id, label: finding.title }]
  for (const e of finding.affectedEntities) references.push({ kind: e.kind === 'identity' ? 'identity' : e.kind === 'resource' ? 'resource' : 'graph-node', ref: e.key, label: e.label })
  for (const c of finding.comparisonIds) references.push({ kind: 'comparison', ref: c, label: `comparison ${c}` })
  for (const inv of finding.invariantRefs) references.push({ kind: 'invariant', ref: inv, label: inv })
  return {
    fromCondition,
    relationship: `exploit "${finding.title}"`,
    toCondition: enablement.impactLabel,
    edgeVerification: findingEdgeVerification(finding.verificationState),
    findingId: finding.id,
    boundaryCrossed: enablement.boundary,
    references,
    evidenceRefs: finding.evidenceRefs,
    rationale: finding.severityReason,
  }
}

/** A connector from finding A (its enablement) to finding B — or null when nothing real connects them. */
export function connectFindings(a: SecurityFinding, ea: FindingEnablement, b: SecurityFinding, eb: FindingEnablement, view: AttackPathView): Connector | null {
  return connects(a, ea, b, eb, view)
}

function connects(a: SecurityFinding, ea: FindingEnablement, b: SecurityFinding, eb: FindingEnablement, view: AttackPathView): Connector | null {
  // Same principal escalating to a greater (or distinct) impact: the shared identity is the connector.
  if (ea.principalKey && ea.principalKey === eb.principalKey && IMPACT_RANK[eb.impact] >= IMPACT_RANK[ea.impact]) {
    const sameTarget = eb.grantedEntityKeys.length > 0 && eb.grantedEntityKeys.every((k) => ea.grantedEntityKeys.includes(k))
    if (!(eb.impact === ea.impact && sameTarget)) {
      const node = view.nodesByKey.get(ea.principalKey)
      return {
        kind: 'principal',
        edgeVerification: 'verified',
        reference: { kind: 'identity', ref: ea.principalKey, label: node?.label ?? ea.principalKey },
        relationship: `the same principal (${node?.label ?? 'identity'}) retains access`,
        rationale: 'Both findings were demonstrated for the same established identity.',
      }
    }
  }
  // Resource reachability: an entity A reached is connected by a verified/declared graph edge to an entity B concerns.
  const bEntities = new Set([...eb.grantedEntityKeys, eb.precondition.entityKey, ...b.affectedEntities.map((e) => e.key)].filter((k): k is string => !!k))
  for (const from of ea.grantedEntityKeys) {
    for (const edge of view.edgesByFrom.get(from) ?? []) {
      if (!bEntities.has(edge.toKey)) continue
      const verification = graphEdgeVerification(edge)
      if (verification === 'contradicted') continue // a contradicted edge never connects a path
      return {
        kind: 'edge',
        edge,
        edgeVerification: verification,
        reference: { kind: 'graph-edge', ref: edge.key, label: `${edge.type} ${edge.fromKey} → ${edge.toKey}` },
        relationship: `${edge.type} reaches ${view.nodesByKey.get(edge.toKey)?.label ?? edge.toKey}`,
        rationale: `A ${edge.basis} ${edge.type} relationship connects the reached entity to the next finding.`,
      }
    }
  }
  return null
}

/** A graph edge from A's reached entities to one of B's entities that stored evidence CONTRADICTS, if any. */
function contradictedBridge(ea: FindingEnablement, eb: FindingEnablement, view: AttackPathView): SecurityGraphEdge | null {
  const bEntities = new Set([...eb.grantedEntityKeys, eb.precondition.entityKey].filter((k): k is string => !!k))
  for (const from of ea.grantedEntityKeys) for (const edge of view.edgesByFrom.get(from) ?? []) if (bEntities.has(edge.toKey) && graphEdgeVerification(edge) === 'contradicted') return edge
  return null
}

function endOf(finding: SecurityFinding, enablement: FindingEnablement): EndImpact {
  const target = finding.affectedEntities.find((e) => e.kind === 'resource' || e.kind === 'business-action') ?? finding.affectedEntities[0]
  return { impactClass: enablement.impact, entityKey: target?.key ?? null, label: enablement.impactLabel }
}

/** Assembles a CandidatePath from an ordered finding chain and its already-built steps (pure). */
export function buildCandidatePath(chain: SecurityFinding[], steps: CandidateStep[], origin: 'deterministic' | 'ai-proposed' = 'deterministic'): CandidatePath {
  const last = chain[chain.length - 1]!
  const e = findingEnablement(last)
  return {
    start: findingEnablement(chain[0]!).precondition,
    end: endOf(last, e),
    steps,
    findingIds: chain.map((f) => f.id),
    comparisonIds: [...new Set(chain.flatMap((f) => f.comparisonIds))],
    invariantRefs: [...new Set(chain.flatMap((f) => f.invariantRefs))],
    affectedEntityKeys: [...new Set(chain.flatMap((f) => f.affectedEntities.map((a) => a.key)))],
    boundariesCrossed: [...new Set(steps.map((s) => s.boundaryCrossed).filter((b): b is TrustBoundaryKind => !!b))],
    impactClass: e.impact,
    transitions: chain.map((f) => findingEnablement(f).impact),
    origin,
  }
}

/**
 * Builds the steps for an ordered finding chain (used for AI proposals). A real connector between two
 * findings is used where one exists; otherwise the gap is represented as a MISSING edge — never invented. An
 * unknown connecting entity key rejects the proposal outright (an AI cannot cite nonexistent graph state).
 */
export function buildAiChain(orderedFindings: SecurityFinding[], connectingEntityKeys: string[], view: AttackPathView): { ok: boolean; reason: string | null; steps: CandidateStep[] } {
  for (const k of connectingEntityKeys) if (!view.nodesByKey.has(k)) return { ok: false, reason: `unknown connecting entity ${k}`, steps: [] }
  if (!orderedFindings.length) return { ok: false, reason: 'no findings', steps: [] }
  const first = orderedFindings[0]!
  const ef0 = findingEnablement(first)
  const steps: CandidateStep[] = [findingStep(first, ef0, ef0.precondition.label)]
  for (let i = 1; i < orderedFindings.length; i++) {
    const prev = orderedFindings[i - 1]!
    const cur = orderedFindings[i]!
    const ep = findingEnablement(prev)
    const ec = findingEnablement(cur)
    const connector = connects(prev, ep, cur, ec, view)
    let connectorStep: CandidateStep
    if (connector) {
      connectorStep = { fromCondition: ep.impactLabel, relationship: connector.relationship, toCondition: `positioned to exploit "${cur.title}"`, edgeVerification: connector.edgeVerification, findingId: null, boundaryCrossed: null, references: [connector.reference], evidenceRefs: [], rationale: connector.rationale }
    } else {
      // No real connector. If stored evidence actually CONTRADICTS the claimed reachability, say so (the path
      // is then rejected); otherwise the reachability is simply unproven (a missing-edge gap).
      const contradicting = contradictedBridge(ep, ec, view)
      connectorStep = {
        fromCondition: ep.impactLabel,
        relationship: `claimed reachability to "${cur.title}"${connectingEntityKeys.length ? ` via ${connectingEntityKeys.map((k) => view.nodesByKey.get(k)?.label ?? k).join(', ')}` : ''}`,
        toCondition: `positioned to exploit "${cur.title}"`,
        edgeVerification: contradicting ? 'contradicted' : 'missing',
        findingId: null,
        boundaryCrossed: null,
        references: contradicting ? [{ kind: 'graph-edge', ref: contradicting.key, label: `${contradicting.type} ${contradicting.fromKey} → ${contradicting.toKey}` }] : connectingEntityKeys.map((k) => ({ kind: 'graph-node' as const, ref: k, label: view.nodesByKey.get(k)?.label ?? k })),
        evidenceRefs: [],
        rationale: contradicting ? 'Stored evidence contradicts the claimed reachability.' : 'No verified graph relationship connects these findings; reachability is unproven.',
      }
    }
    steps.push(connectorStep, findingStep(cur, ec, connectorStep.toCondition))
  }
  return { ok: true, reason: null, steps }
}

export function discoverPaths(view: AttackPathView, budget: SearchBudget = DEFAULT_BUDGET): { paths: CandidatePath[]; stats: DiscoveryStats } {
  const enablement = new Map<string, FindingEnablement>(view.findings.map((f) => [f.id, findingEnablement(f)]))
  const paths: CandidatePath[] = []
  let expansions = 0
  let terminationReason: DiscoveryStats['terminationReason'] = 'complete'

  const emit = (chain: SecurityFinding[], steps: CandidateStep[]): boolean => {
    if (paths.length >= budget.maxCandidatePaths) {
      terminationReason = 'max-candidates'
      return false
    }
    paths.push(buildCandidatePath(chain, steps, 'deterministic'))
    return true
  }

  // Bounded DFS from each finding; each node also yields its single-finding path.
  const dfs = (chain: SecurityFinding[], steps: CandidateStep[], visited: Set<string>): boolean => {
    if (!emit(chain, steps)) return false
    if (chain.length >= budget.maxDepth) return true
    const current = chain[chain.length - 1]!
    const ec = enablement.get(current.id)!
    for (const next of view.findings) {
      if (visited.has(next.id)) continue // cycle-safe: never revisit a finding within a path
      if (++expansions > budget.maxExpansions) {
        terminationReason = 'max-expansions'
        return false
      }
      const connector = connects(current, ec, next, enablement.get(next.id)!, view)
      if (!connector) continue
      const en = enablement.get(next.id)!
      const connectorStep: CandidateStep = {
        fromCondition: ec.impactLabel,
        relationship: connector.relationship,
        toCondition: `positioned to exploit "${next.title}"`,
        edgeVerification: connector.edgeVerification,
        findingId: null,
        boundaryCrossed: null,
        references: [connector.reference],
        evidenceRefs: [],
        rationale: connector.rationale,
      }
      const nextStep = findingStep(next, en, connectorStep.toCondition)
      const nextVisited = new Set(visited).add(next.id)
      if (!dfs([...chain, next], [...steps, connectorStep, nextStep], nextVisited)) return false
    }
    return true
  }

  for (const finding of view.findings) {
    const e = enablement.get(finding.id)!
    if (!dfs([finding], [findingStep(finding, e, e.precondition.label)], new Set([finding.id]))) break
  }

  return { paths, stats: { findings: view.findings.length, expansions, candidatePaths: paths.length, truncated: terminationReason !== 'complete', terminationReason } }
}
