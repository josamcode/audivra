import { createHash } from 'node:crypto'
import type {
  CandidateOrigin,
  CandidateSource,
  ComparisonDimension,
  DomainDeclarationKind,
  FindingCategory,
  HypothesisCategory,
  SecurityObservation,
  VerificationCheck,
} from '@audivra/contracts'
import { isComparisonHypothesisCategory } from '@audivra/contracts'
import { identityKey } from '../graph/identity.ts'
import type { KnowledgeView } from '../reasoning/knowledge.ts'
import { requirementsFor } from './requirements.ts'

/*
 * Phase 6A candidate generation — the ONLY door from signals to verification. A candidate is not a finding;
 * it is a strong signal that has earned independent verification. Five origins, each deterministic:
 *   - a hypothesis the evidence independently confirmed (confirmed-signal),
 *   - a differential comparison that came back inconsistent,
 *   - a declared invariant a comparison contradicted,
 *   - an observation two independent sensors corroborate,
 *   - a source signal a runtime observation corroborates (source/runtime inconsistency).
 * A lone scanner hit or a lone AI opinion generates nothing. Each candidate carries a stable issueKey so the
 * same issue is advanced, never duplicated, and the machine-checkable requirements its origin/category demand.
 */

/** A resolver from a declared domain ref to its graph node key (the service builds it from declarations). */
export type DomainRefResolver = (kind: DomainDeclarationKind, ref: string) => string | null

export interface GeneratedCandidate {
  issueKey: string
  claim: string
  category: FindingCategory
  affectedEntityKeys: string[]
  supportingEvidenceRefs: string[]
  contradictingEvidenceRefs: string[]
  source: CandidateSource
  requiredChecks: VerificationCheck[]
}

/** Stable, engagement-unique, key-safe issue key: category + the affected entities + the security property. */
export function findingIssueKey(category: FindingCategory, affectedEntityKeys: readonly string[], property: string): string {
  const basis = `${[...new Set(affectedEntityKeys)].sort().join(',')}|${property.trim().replace(/\s+/g, ' ').toLowerCase()}`
  return `${category}:${createHash('sha256').update(basis).digest('hex').slice(0, 20)}`
}

const HYPOTHESIS_TO_FINDING: Record<HypothesisCategory, FindingCategory> = {
  'attack-surface': 'exposure',
  technology: 'configuration',
  'endpoint-behavior': 'api-behavior',
  'api-surface': 'api-behavior',
  configuration: 'configuration',
  'evidence-gap': 'configuration',
  'signal-confirmation': 'exposure',
  'object-boundary': 'authorization',
  'role-boundary': 'authorization',
  'tenant-boundary': 'tenant-isolation',
  'function-level': 'authorization',
  'field-boundary': 'authorization',
  'session-boundary': 'session-management',
  'business-rule': 'business-logic',
}

const DIMENSION_TO_FINDING: Record<ComparisonDimension, FindingCategory> = {
  'object-boundary': 'authorization',
  'role-boundary': 'authorization',
  'tenant-boundary': 'tenant-isolation',
  'function-level': 'authorization',
  'field-boundary': 'authorization',
  'session-boundary': 'session-management',
  'state-transition': 'business-logic',
  ownership: 'authorization',
}

const RUNTIME_OBSERVATION_TYPES = new Set(['http-response', 'http-header', 'web-signal', 'api-validation', 'api-workflow', 'traffic-flow'])

const nodeKeysOf = (view: KnowledgeView, ids: readonly string[]): string[] =>
  [...new Set(ids.map((id) => view.nodes.get(id)?.key).filter((k): k is string => !!k))]

const evidenceOf = (view: KnowledgeView, observationIds: readonly string[]): string[] =>
  [...new Set(observationIds.flatMap((id) => view.observations.get(id)?.evidenceRefs ?? []))]

const distinctTools = (o: SecurityObservation): string[] => [...new Set(o.contributions.map((c) => c.tool))]

// ── Confirmed-signal hypotheses (sensor-driven; comparison categories are handled via comparisons) ───────

function fromHypotheses(view: KnowledgeView): GeneratedCandidate[] {
  const out: GeneratedCandidate[] = []
  for (const h of view.hypotheses) {
    if (h.status !== 'confirmed-signal') continue
    if (isComparisonHypothesisCategory(h.category)) continue // these are represented by their comparison
    const category = HYPOTHESIS_TO_FINDING[h.category]
    const affectedEntityKeys = nodeKeysOf(view, h.subjectEntityIds)
    if (!affectedEntityKeys.length) continue
    out.push({
      issueKey: findingIssueKey(category, affectedEntityKeys, `${h.category}:${h.claim}`),
      claim: h.claim,
      category,
      affectedEntityKeys,
      supportingEvidenceRefs: evidenceOf(view, h.supportingObservationIds),
      contradictingEvidenceRefs: evidenceOf(view, h.contradictingObservationIds),
      source: { origin: 'confirmed-signal-hypothesis', hypothesisId: h.id, comparisonId: null, invariantRef: null, observationIds: [...h.supportingObservationIds] },
      requiredChecks: requirementsFor('confirmed-signal-hypothesis', category),
    })
  }
  return out
}

// ── Differential comparisons (inconsistent) and contradicted invariants ──────────────────────────────────

function fromComparisons(view: KnowledgeView, resolve: DomainRefResolver): GeneratedCandidate[] {
  const out: GeneratedCandidate[] = []
  for (const c of view.comparisons) {
    if (c.status !== 'completed') continue
    const contradictedInvariant = c.invariantEvaluation === 'contradicted'
    if (c.result !== 'inconsistent' && !contradictedInvariant) continue
    const origin: CandidateOrigin = contradictedInvariant ? 'contradicted-invariant' : 'differential-comparison'
    const category = DIMENSION_TO_FINDING[c.dimension]
    const subjectArms = c.arms.filter((a) => a.role === 'subject')
    const identityNodes = subjectArms.map((a) => (a.identityRef ? identityKey(a.identityRef) : null)).filter((k): k is string => !!k && view.nodesByKey.has(k))
    const resourceNode = resolve('resource', c.resourceRef)
    const affectedEntityKeys = [...new Set([...(resourceNode && view.nodesByKey.has(resourceNode) ? [resourceNode] : []), ...identityNodes])]
    if (!affectedEntityKeys.length) continue
    const armEvidence = c.arms.flatMap((a) => a.observation?.evidenceRefs ?? [])
    out.push({
      issueKey: findingIssueKey(category, affectedEntityKeys, `${c.dimension}:${c.resourceRef}:${c.action}`),
      claim: `${c.title} — ${c.resultReason}`,
      category,
      affectedEntityKeys,
      supportingEvidenceRefs: [...new Set([...c.evidenceRefs, ...armEvidence])],
      contradictingEvidenceRefs: [],
      source: { origin, hypothesisId: c.hypothesisId, comparisonId: c.id, invariantRef: c.invariantRef, observationIds: [] },
      requiredChecks: requirementsFor(origin, category),
    })
  }
  return out
}

// ── Independently corroborated observations (config / dependency / transport) ────────────────────────────

const CORROBORATED_TYPES: Record<string, FindingCategory> = {
  'dependency-vulnerability': 'dependency',
  'tls-config': 'transport-tls',
  'web-signal': 'exposure',
}

function fromCorroboratedObservations(view: KnowledgeView): GeneratedCandidate[] {
  const out: GeneratedCandidate[] = []
  // node id → observation ids, to attach the observation to a graph entity for affected-entity-known.
  const nodeByObservation = new Map<string, string>()
  for (const [nodeId, obsIds] of view.observationsByNode) for (const oid of obsIds) nodeByObservation.set(oid, nodeId)
  for (const o of view.observations.values()) {
    const category = CORROBORATED_TYPES[o.type]
    if (!category) continue
    if (distinctTools(o).length < 2) continue // a lone scanner hit is never a candidate
    const nodeId = nodeByObservation.get(o.id)
    const nodeKey = nodeId ? view.nodes.get(nodeId)?.key : undefined
    if (!nodeKey) continue
    const affectedEntityKeys = [nodeKey]
    out.push({
      issueKey: findingIssueKey(category, affectedEntityKeys, `${o.type}:${o.subject}`),
      claim: `${o.title} (${o.asset})`,
      category,
      affectedEntityKeys,
      supportingEvidenceRefs: [...o.evidenceRefs],
      contradictingEvidenceRefs: [],
      source: { origin: 'corroborated-observation', hypothesisId: null, comparisonId: null, invariantRef: null, observationIds: [o.id] },
      requiredChecks: requirementsFor('corroborated-observation', category),
    })
  }
  return out
}

// ── Source/runtime correlation (a code signal a runtime observation corroborates) ───────────────────────

function fromSourceRuntime(view: KnowledgeView): GeneratedCandidate[] {
  const out: GeneratedCandidate[] = []
  const sourceFindings = [...view.observations.values()].filter((o) => o.type === 'source-finding')
  if (!sourceFindings.length) return out
  const runtimeByAsset = new Map<string, SecurityObservation[]>()
  for (const o of view.observations.values()) {
    if (!RUNTIME_OBSERVATION_TYPES.has(o.type)) continue
    runtimeByAsset.set(o.asset, [...(runtimeByAsset.get(o.asset) ?? []), o])
  }
  const nodeByObservation = new Map<string, string>()
  for (const [nodeId, obsIds] of view.observationsByNode) for (const oid of obsIds) nodeByObservation.set(oid, nodeId)
  for (const src of sourceFindings) {
    const runtime = runtimeByAsset.get(src.asset) ?? []
    if (!runtime.length) continue
    const nodeId = nodeByObservation.get(src.id) ?? runtime.map((r) => nodeByObservation.get(r.id)).find((n) => n)
    const nodeKey = nodeId ? view.nodes.get(nodeId)?.key : undefined
    if (!nodeKey) continue
    const affectedEntityKeys = [nodeKey]
    const observationIds = [src.id, ...runtime.map((r) => r.id)]
    out.push({
      issueKey: findingIssueKey('source-runtime-inconsistency', affectedEntityKeys, `${src.subject}:${src.asset}`),
      claim: `Source signal "${src.title}" on ${src.asset} corroborated by runtime behaviour`,
      category: 'source-runtime-inconsistency',
      affectedEntityKeys,
      supportingEvidenceRefs: [...new Set([...src.evidenceRefs, ...runtime.flatMap((r) => r.evidenceRefs)])],
      contradictingEvidenceRefs: [],
      source: { origin: 'source-runtime-correlation', hypothesisId: null, comparisonId: null, invariantRef: null, observationIds },
      requiredChecks: requirementsFor('source-runtime-correlation', 'source-runtime-inconsistency'),
    })
  }
  return out
}

/**
 * Generates every verification candidate for an engagement from its stored knowledge. Deterministic and
 * idempotent: the same state yields the same candidates (same issueKeys), so the service advances existing
 * candidates rather than duplicating them. Candidates sharing an issueKey are merged (evidence unioned).
 */
export function generateCandidates(view: KnowledgeView, resolve: DomainRefResolver): GeneratedCandidate[] {
  const all = [...fromHypotheses(view), ...fromComparisons(view, resolve), ...fromCorroboratedObservations(view), ...fromSourceRuntime(view)]
  const merged = new Map<string, GeneratedCandidate>()
  for (const c of all) {
    const existing = merged.get(c.issueKey)
    if (!existing) {
      merged.set(c.issueKey, c)
      continue
    }
    existing.affectedEntityKeys = [...new Set([...existing.affectedEntityKeys, ...c.affectedEntityKeys])]
    existing.supportingEvidenceRefs = [...new Set([...existing.supportingEvidenceRefs, ...c.supportingEvidenceRefs])]
    existing.contradictingEvidenceRefs = [...new Set([...existing.contradictingEvidenceRefs, ...c.contradictingEvidenceRefs])]
    existing.source.observationIds = [...new Set([...existing.source.observationIds, ...c.source.observationIds])]
  }
  return [...merged.values()].sort((a, b) => a.issueKey.localeCompare(b.issueKey))
}

export { HYPOTHESIS_TO_FINDING, DIMENSION_TO_FINDING }
