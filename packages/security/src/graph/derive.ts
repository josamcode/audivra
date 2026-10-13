import {
  INFERRED_CONFIDENCE_CAP,
  strongestBasis,
  type FactStatus,
  type GapKind,
  type GraphConflict,
  type GraphEntityKind,
  type GraphRelationType,
  type KnowledgeBasis,
  type ObservationScopeClass,
  type ObservationType,
  type ProvenanceSource,
  type SecurityObservation,
} from '@audivra/contracts'
import { exclusiveGroupOf } from './identity.ts'
import { SIGNAL_CONFIRMATIONS, type DesiredGraph } from './project.ts'

/*
 * Derivation over the projected facts, still pure: aggregate each fact's provenance into its knowledge basis,
 * confidence and corroboration; decide its temporal status (stale / superseded / contradicted / active);
 * detect conflicts; and evaluate knowledge gaps. AI-inferred facts (stored, never produced by the projector)
 * are aggregated too, but an inference never raises a fact above `inferred` nor overrides deterministic
 * support.
 */

/** The provenance fields aggregation needs (desired rows and stored rows share them). */
export interface ProvenanceLike {
  source: ProvenanceSource
  confidence: number
  tools: string[]
  executionIds: string[]
  observationId: string | null
  firstAt: string
  lastAt: string
}

/** What the projector knows about one execution, for staleness. */
export interface ExecutionFact {
  id: string
  capabilityId: string
  /** The URL the execution targeted (its input `url`); null when it has none (static analysis). */
  target: string | null
  status: string
  /** The sensor's own result state (`success`, `partial`, …); null for non-sensors. */
  sensorState: string | null
  finishedAt: string | null
}

export interface FactInput {
  subjectType: 'node' | 'edge'
  key: string
  kind?: GraphEntityKind
  type?: GraphRelationType
  label?: string
  fromKey?: string
  toKey?: string
  scopeClass: ObservationScopeClass | null
  attributes: Record<string, unknown>
  provenance: ProvenanceLike[]
}

export interface FinalFact extends FactInput {
  basis: KnowledgeBasis
  confidence: number
  corroboration: number
  tools: string[]
  status: FactStatus
  statusReason: string | null
  conflicts: GraphConflict[]
  firstObservedAt: string
  lastObservedAt: string
  firstExecutionId: string | null
  lastExecutionId: string | null
}

export interface GapState {
  kind: GapKind
  subjectType: 'node' | 'edge'
  subjectKey: string
  /** The entity the gap is about (its key); equals subjectKey except for conflict groups. */
  entityKey: string
  state: 'open' | 'resolved' | 'not-applicable'
  question: string
  resolution: string | null
  resolvedBy: { observationId: string | null; executionId: string | null } | null
  answeredBy: ObservationType[]
}

export interface DerivedGraph {
  nodes: Map<string, FinalFact>
  edges: Map<string, FinalFact>
  gaps: GapState[]
  conflictGroups: string[]
}

const BASIS_OF: Record<ProvenanceSource, KnowledgeBasis> = { observation: 'observed', 'user-declaration': 'declared', derivation: 'derived', 'ai-inference': 'inferred' }
export const roundConfidence = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000

/** Aggregates a fact's provenance. Deterministic support always outranks inference. */
export function aggregateProvenance(rows: readonly ProvenanceLike[]): Pick<FinalFact, 'basis' | 'confidence' | 'corroboration' | 'tools' | 'firstObservedAt' | 'lastObservedAt' | 'firstExecutionId' | 'lastExecutionId'> {
  const deterministic = rows.filter((r) => r.source !== 'ai-inference')
  const basis = strongestBasis(rows.map((r) => BASIS_OF[r.source]))
  const confidence = deterministic.length
    ? Math.max(...deterministic.map((r) => r.confidence))
    : Math.min(INFERRED_CONFIDENCE_CAP, Math.max(0, ...rows.map((r) => r.confidence)))
  const tools = [...new Set(deterministic.flatMap((r) => r.tools))].sort()
  const timed = (deterministic.length ? deterministic : rows).slice().sort((a, b) => a.firstAt.localeCompare(b.firstAt))
  const byLast = timed.slice().sort((a, b) => a.lastAt.localeCompare(b.lastAt))
  const first = timed[0]
  const last = byLast[byLast.length - 1]
  return {
    basis,
    confidence: roundConfidence(confidence),
    corroboration: tools.length,
    tools,
    firstObservedAt: first?.firstAt ?? new Date(0).toISOString(),
    lastObservedAt: last?.lastAt ?? new Date(0).toISOString(),
    firstExecutionId: first?.executionIds[0] ?? null,
    lastExecutionId: last?.executionIds[last.executionIds.length - 1] ?? null,
  }
}

/** Latest *complete* run per (capability, target): only a successful sensor run can make a fact stale. */
export function latestRunsByTarget(executions: readonly ExecutionFact[]): Map<string, ExecutionFact> {
  const latest = new Map<string, ExecutionFact>()
  for (const e of executions) {
    if (e.status !== 'succeeded' || !e.target || !e.finishedAt) continue
    if (e.sensorState !== null && e.sensorState !== 'success') continue
    const key = `${e.capabilityId}|${e.target}`
    const current = latest.get(key)
    if (!current || current.finishedAt! < e.finishedAt || (current.finishedAt === e.finishedAt && current.id < e.id)) latest.set(key, e)
  }
  return latest
}

/**
 * A fact is stale when every sensor that ever reported it has run again, completely, on the same target
 * after it was last seen — and did not report it. Facts are never deleted for that; they are only marked.
 */
export function staleness(rows: readonly ProvenanceLike[], lastAt: string, executions: Map<string, ExecutionFact>, latest: Map<string, ExecutionFact>): string | null {
  const deterministic = rows.filter((r) => r.source === 'observation' || r.source === 'derivation')
  const ids = new Set(deterministic.flatMap((r) => r.executionIds))
  const sources = new Set<string>()
  for (const id of ids) {
    const e = executions.get(id)
    if (e?.target) sources.add(`${e.capabilityId}|${e.target}`)
  }
  if (sources.size === 0) return null
  let reason: string | null = null
  for (const source of [...sources].sort()) {
    const run = latest.get(source)
    if (!run || ids.has(run.id) || !run.finishedAt || run.finishedAt <= lastAt) return null
    reason ??= `Not reported by the latest ${run.capabilityId} run on ${run.target} (${run.id})`
  }
  return reason
}

const conflictSort = (a: GraphConflict, b: GraphConflict) => a.group.localeCompare(b.group)

/** Applies aggregation, staleness, supersession and conflicts; then evaluates the knowledge gaps. */
export function deriveGraph(input: {
  facts: FactInput[]
  desired: DesiredGraph
  executions: readonly ExecutionFact[]
  observations: Map<string, SecurityObservation>
  /** Conflicts already stored (to keep their original detection time). */
  storedConflicts: Map<string, GraphConflict[]>
  now: string
}): DerivedGraph {
  const executions = new Map(input.executions.map((e) => [e.id, e]))
  const latest = latestRunsByTarget(input.executions)
  const nodes = new Map<string, FinalFact>()
  const edges = new Map<string, FinalFact>()

  for (const fact of input.facts) {
    const agg = aggregateProvenance(fact.provenance)
    const stale = fact.provenance.some((r) => r.source !== 'ai-inference') ? staleness(fact.provenance, agg.lastObservedAt, executions, latest) : null
    const final: FinalFact = { ...fact, ...agg, status: stale ? 'stale' : 'active', statusReason: stale, conflicts: [] }
    ;(fact.subjectType === 'node' ? nodes : edges).set(fact.key, final)
  }

  // Supersession: a redirect source points to one destination at a time; older destinations are superseded.
  const redirectsBySource = new Map<string, FinalFact[]>()
  for (const edge of edges.values()) if (edge.type === 'REDIRECTS_TO' && edge.status !== 'stale') redirectsBySource.set(edge.fromKey!, [...(redirectsBySource.get(edge.fromKey!) ?? []), edge])
  for (const group of redirectsBySource.values()) {
    if (group.length < 2) continue
    const newest = group.reduce((a, b) => (b.lastObservedAt > a.lastObservedAt || (b.lastObservedAt === a.lastObservedAt && b.key > a.key) ? b : a))
    for (const edge of group) {
      if (edge === newest) continue
      edge.status = 'superseded'
      edge.statusReason = `Superseded: the redirect now goes to ${nodes.get(newest.toKey!)?.attributes.url ?? newest.toKey} (observed ${newest.lastObservedAt})`
    }
  }

  // Conflicts between active facts: two exclusive technologies (e.g. two web servers) on one host, or
  // two sensors currently reporting different versions of the same technology on one host.
  const conflictGroups: string[] = []
  const markConflict = (group: string, reason: string, members: FinalFact[]) => {
    conflictGroups.push(group)
    for (const member of members) {
      const detectedAt = input.storedConflicts.get(member.key)?.find((c) => c.group === group)?.detectedAt ?? input.now
      // `with`: the other facts of the same kind in the conflict (edge ↔ edges, entity ↔ entities).
      const conflict: GraphConflict = { group, reason, with: members.filter((m) => m !== member && m.subjectType === member.subjectType).map((m) => m.key).sort(), detectedAt }
      member.conflicts = [...member.conflicts.filter((c) => c.group !== group), conflict].sort(conflictSort)
      if (member.status === 'active') {
        member.status = 'contradicted'
        member.statusReason = reason
      }
    }
  }
  const dependsByHost = new Map<string, FinalFact[]>()
  for (const edge of edges.values()) if (edge.type === 'DEPENDS_ON' && edge.status === 'active') dependsByHost.set(edge.fromKey!, [...(dependsByHost.get(edge.fromKey!) ?? []), edge])
  for (const [host, deps] of [...dependsByHost].sort(([a], [b]) => a.localeCompare(b))) {
    const byGroup = new Map<string, FinalFact[]>()
    for (const dep of deps) {
      const name = String(nodes.get(dep.toKey!)?.attributes.name ?? '')
      const group = exclusiveGroupOf(name)
      if (group) byGroup.set(group, [...(byGroup.get(group) ?? []), dep])
      const versions = Object.entries((dep.attributes.versionByTool as Record<string, string> | undefined) ?? {})
      if (new Set(versions.map(([, v]) => v)).size > 1) {
        const tech = nodes.get(dep.toKey!)
        markConflict(`version:${name}@${host}`, `Sensors disagree on the ${tech?.label ?? name} version on ${nodes.get(host)?.label ?? host}: ${versions.map(([t, v]) => `${t} ${v}`).join(', ')}`, [dep, ...(tech ? [tech] : [])])
      }
    }
    for (const [group, members] of byGroup) {
      const names = [...new Set(members.map((m) => nodes.get(m.toKey!)?.label ?? m.toKey!))].sort()
      if (names.length < 2) continue
      const techNodes = members.map((m) => nodes.get(m.toKey!)).filter((n): n is FinalFact => !!n)
      markConflict(`${group}@${host}`, `${names.join(' and ')} are both reported as the ${group} of ${nodes.get(host)?.label ?? host}`, [...members, ...techNodes])
    }
  }

  return { nodes, edges, gaps: evaluateGaps(nodes, edges, input.desired, input.observations), conflictGroups: [...new Set(conflictGroups)].sort() }
}

// ── Knowledge gaps ───────────────────────────────────────────────────────────────────────────────────

function latestExecution(o: SecurityObservation | undefined): string | null {
  if (!o) return null
  return [...o.contributions].sort((a, b) => b.at.localeCompare(a.at))[0]?.executionId ?? null
}

function evaluateGaps(nodes: Map<string, FinalFact>, edges: Map<string, FinalFact>, desired: DesiredGraph, observations: Map<string, SecurityObservation>): GapState[] {
  const gaps: GapState[] = []
  const inactive = (f: FinalFact) => f.status === 'stale' || f.status === 'superseded'
  const statusOf = (endpointKey: string) => desired.statusSources.get(endpointKey) ?? null
  const gap = (g: Omit<GapState, 'subjectType' | 'entityKey'> & { subjectType?: 'node' | 'edge'; entityKey?: string }) =>
    gaps.push({ subjectType: 'node', entityKey: g.subjectKey, ...g })
  const na = (kind: GapKind, key: string, question: string, answeredBy: ObservationType[]) => gap({ kind, subjectKey: key, state: 'not-applicable', question, resolution: 'The entity is no longer active', resolvedBy: null, answeredBy })

  const callTargets = new Set([...edges.values()].filter((e) => e.type === 'CALLS').map((e) => e.toKey!))

  for (const node of [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const label = node.kind === 'endpoint' ? String(node.attributes.url ?? node.label) : node.label
    switch (node.kind) {
      case 'endpoint': {
        if (node.scopeClass !== 'in-scope') break
        const question = `How does ${label} respond? It was discovered but never inspected.`
        const answeredBy: ObservationType[] = ['http-response', 'endpoint']
        if (inactive(node)) {
          na('endpoint-behavior-unknown', node.key, question, answeredBy)
          break
        }
        const status = statusOf(node.key)
        if (!status) gap({ kind: 'endpoint-behavior-unknown', subjectKey: node.key, state: 'open', question, resolution: null, resolvedBy: null, answeredBy })
        else gap({ kind: 'endpoint-behavior-unknown', subjectKey: node.key, state: 'resolved', question, resolution: `Responded HTTP ${status.status}`, resolvedBy: { observationId: status.observationId, executionId: status.executionId }, answeredBy })

        if (callTargets.has(node.key)) {
          const authQuestion = `Does ${label} (a form submission target) require authentication?`
          const methods = (node.attributes.formMethods as string[] | undefined) ?? []
          const authAnsweredBy: ObservationType[] = methods.every((m) => m === 'GET' || m === 'HEAD') ? ['http-response'] : []
          if (status && (status.status === 401 || status.status === 403)) {
            gap({ kind: 'authentication-requirement-unknown', subjectKey: node.key, state: 'resolved', question: authQuestion, resolution: `Requires authentication (HTTP ${status.status} observed)`, resolvedBy: { observationId: status.observationId, executionId: status.executionId }, answeredBy: authAnsweredBy })
          } else if (status && status.status < 300 && authAnsweredBy.length) {
            gap({ kind: 'authentication-requirement-unknown', subjectKey: node.key, state: 'resolved', question: authQuestion, resolution: `Answered an anonymous request with HTTP ${status.status}`, resolvedBy: { observationId: status.observationId, executionId: status.executionId }, answeredBy: authAnsweredBy })
          } else {
            gap({ kind: 'authentication-requirement-unknown', subjectKey: node.key, state: 'open', question: authQuestion, resolution: null, resolvedBy: null, answeredBy: authAnsweredBy })
          }
        }
        break
      }
      case 'technology': {
        const question = `Is ${node.label} really in use? Only ${node.tools.join(', ') || 'one sensor'} reported it.`
        const answeredBy: ObservationType[] = ['technology', 'http-header', 'web-signal']
        if (inactive(node)) {
          na('technology-uncorroborated', node.key, question, answeredBy)
          break
        }
        if (node.corroboration >= 2) {
          const second = [...node.provenance].filter((p) => p.source !== 'ai-inference').sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0]
          gap({ kind: 'technology-uncorroborated', subjectKey: node.key, state: 'resolved', question, resolution: `Corroborated by ${node.tools.join(' and ')}`, resolvedBy: { observationId: second?.observationId ?? null, executionId: second?.executionIds.at(-1) ?? null }, answeredBy })
        } else if (node.provenance.some((p) => p.source !== 'ai-inference')) {
          gap({ kind: 'technology-uncorroborated', subjectKey: node.key, state: 'open', question, resolution: null, resolvedBy: null, answeredBy })
        }
        break
      }
      case 'api-operation': {
        const question = `Is ${node.label} (from the API contract) reachable on the application's discovered surface?`
        const answeredBy: ObservationType[] = ['http-response', 'endpoint']
        if (inactive(node)) {
          na('api-operation-unobserved', node.key, question, answeredBy)
          break
        }
        const method = String(node.attributes.method ?? 'GET')
        const instances = [...edges.values()].filter((e) => e.type === 'BELONGS_TO' && e.toKey === node.key && !inactive(e))
        const seen = instances
          .map((e) => ({ endpoint: nodes.get(e.fromKey!), status: statusOf(e.fromKey!) }))
          .find((i) => i.endpoint && i.status && (method === 'GET' || method === 'HEAD' || ((i.endpoint.attributes.methods as string[] | undefined) ?? []).includes(method)))
        if (seen?.status) {
          gap({ kind: 'api-operation-unobserved', subjectKey: node.key, state: 'resolved', question, resolution: `Observed at ${seen.endpoint!.attributes.url ?? seen.endpoint!.label} (HTTP ${seen.status.status})`, resolvedBy: { observationId: seen.status.observationId, executionId: seen.status.executionId }, answeredBy })
          if (seen.status.status === 401 || seen.status.status === 403) {
            gap({ kind: 'authentication-requirement-unknown', subjectKey: node.key, state: 'resolved', question: `Does ${node.label} require authentication?`, resolution: `Requires authentication (HTTP ${seen.status.status} observed)`, resolvedBy: { observationId: seen.status.observationId, executionId: seen.status.executionId }, answeredBy: ['http-response'] })
          } else if (seen.status.status < 300 && (method === 'GET' || method === 'HEAD')) {
            gap({ kind: 'authentication-requirement-unknown', subjectKey: node.key, state: 'resolved', question: `Does ${node.label} require authentication?`, resolution: `Answered an anonymous request with HTTP ${seen.status.status}`, resolvedBy: { observationId: seen.status.observationId, executionId: seen.status.executionId }, answeredBy: ['http-response'] })
          }
        } else {
          gap({ kind: 'api-operation-unobserved', subjectKey: node.key, state: 'open', question, resolution: null, resolvedBy: null, answeredBy: node.attributes.concreteUrl ? answeredBy : [] })
          gap({ kind: 'authentication-requirement-unknown', subjectKey: node.key, state: 'open', question: `Does ${node.label} require authentication?`, resolution: null, resolvedBy: null, answeredBy: (method === 'GET' || method === 'HEAD') && node.attributes.concreteUrl ? ['http-response'] : [] })
        }
        break
      }
      case 'signal': {
        if (node.confidence >= 0.8 || node.attributes.sourceType === 'tool-reported') break
        const templateId = String(node.attributes.templateId ?? node.attributes.subject ?? '')
        const rule = SIGNAL_CONFIRMATIONS[templateId]
        const affected = [...edges.values()].find((e) => e.type === 'AFFECTS' && e.fromKey === node.key)?.toKey ?? null
        const question = `Is the "${node.label}" signal genuine? It is a ${node.tools.join(', ') || 'sensor'} heuristic awaiting independent confirmation.`
        const answeredBy: ObservationType[] = rule ? [rule.observationType] : []
        if (inactive(node)) {
          na('signal-unconfirmed', node.key, question, answeredBy)
          break
        }
        // Independent confirmation: the affected entity (or its host) carries the confirming observation from another tool.
        const candidates = affected ? [affected, ...[...edges.values()].filter((e) => e.type === 'HOSTS' && e.toKey === affected).map((e) => e.fromKey!)] : []
        const confirming = rule
          ? candidates
              .flatMap((key) => desired.observationsByEntity.get(key) ?? [])
              .map((id) => observations.get(id))
              .find((o) => o && o.type === rule.observationType && (!rule.subject || o.subject === rule.subject) && o.contributions.some((c) => !node.tools.includes(c.tool)))
          : undefined
        if (confirming) gap({ kind: 'signal-unconfirmed', subjectKey: node.key, state: 'resolved', question, resolution: `Confirmed independently by ${rule!.how} (${[...new Set(confirming.contributions.map((c) => c.tool))].join(', ')})`, resolvedBy: { observationId: confirming.id, executionId: latestExecution(confirming) }, answeredBy })
        else gap({ kind: 'signal-unconfirmed', subjectKey: node.key, state: 'open', question, resolution: null, resolvedBy: null, answeredBy })
        break
      }
      default:
        break
    }
  }

  // Unresolved contradictions, one per conflict group (subject: the host the conflict is about).
  const groups = new Map<string, { host: string; reason: string }>()
  for (const fact of [...nodes.values(), ...edges.values()]) {
    for (const c of fact.conflicts) {
      const host = c.group.slice(c.group.indexOf('@') + 1)
      if (!groups.has(c.group)) groups.set(c.group, { host, reason: c.reason })
    }
  }
  for (const [group, { host, reason }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    gaps.push({ kind: 'contradiction-unresolved', subjectType: 'node', subjectKey: group, entityKey: host, state: 'open', question: `Which is true? ${reason}.`, resolution: null, resolvedBy: null, answeredBy: ['technology', 'http-header', 'web-signal'] })
  }
  return gaps
}
