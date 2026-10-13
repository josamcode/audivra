import { createHash } from 'node:crypto'
import {
  isResolvedHypothesis,
  type CheckResult,
  type EvidenceCheck,
  type HypothesisStatus,
  type ObservationType,
  type ProposedHypothesis,
  type SecurityGraphNode,
  type SecurityHypothesis,
  type SecurityObservation,
} from '@audivra/contracts'
import { SIGNAL_CONFIRMATIONS } from '../graph/project.ts'
import { urlParts } from '../graph/identity.ts'
import { neighbourhood, observationsAbout, type KnowledgeView } from './knowledge.ts'
import { capabilityFits } from './ranking.ts'

/*
 * Hypotheses: deterministic quality rules, structural deduplication and evidence checks.
 *
 * A model proposes; this module decides whether a proposal may exist. It rejects proposals that reference
 * entities, evidence or gaps that do not exist, cite evidence unrelated to what they are about, assert
 * things outside the graph's knowledge, concern out-of-scope assets, need capabilities this environment
 * cannot run, or are already established/contradicted. Duplicates are merged on deterministic references
 * (the affected entities) — a model's "this is the same as X" is only a suggestion that must agree with
 * them. Status changes come only from evidence checks evaluated against the graph.
 */

export const REJECTION_REASONS = [
  'unknown-entity',
  'unknown-evidence',
  'unknown-gap',
  'invalid-check',
  'unrelated-evidence',
  'unsupported',
  'claim-outside-graph',
  'out-of-scope',
  'capability-unavailable',
  'already-established',
  'already-contradicted',
  'restated-in-batch',
  'verifier-unsupported',
  'verifier-contradicted',
] as const
export type RejectionReason = (typeof REJECTION_REASONS)[number]

export type ProposalVerdict =
  | { kind: 'accept'; proposal: ProposedHypothesis; dedupeKey: string; candidateCapabilities: string[]; confidence: number; notes: string[] }
  | { kind: 'duplicate'; proposal: ProposedHypothesis; existing: SecurityHypothesis; notes: string[] }
  | { kind: 'reject'; proposal: ProposedHypothesis; reason: RejectionReason; detail: string }

/** The structural key: the set of affected entities. Rewordings of one concern about one entity set merge. */
export function hypothesisDedupeKey(subjectEntityIds: readonly string[]): string {
  const subjects = [...new Set(subjectEntityIds)].sort()
  return `subjects:${createHash('sha256').update(subjects.join(',')).digest('hex').slice(0, 24)}`
}

/** Observation types that would satisfy a check (planning: which capability can reduce this uncertainty). */
export function checkNeeds(check: EvidenceCheck, view: KnowledgeView): ObservationType[] {
  switch (check.check) {
    case 'response-status':
      return ['http-response', 'endpoint']
    case 'observation-present':
      return [check.observationType]
    case 'entity-contradicted':
      return ['technology', 'http-header', 'web-signal']
    case 'gap-resolved':
      return view.gaps.get(check.gapId)?.answeredBy ?? []
    case 'independent-corroboration': {
      const node = view.nodes.get(check.entityId)
      if (!node) return []
      if (node.kind === 'technology') return ['technology', 'http-header', 'web-signal']
      if (node.kind === 'signal') {
        const rule = SIGNAL_CONFIRMATIONS[String(node.attributes.templateId ?? '')]
        return rule ? [rule.observationType] : []
      }
      return ['http-response', 'endpoint']
    }
  }
}

/** The entity a check is about (null for a gap check whose gap is unknown). */
export function checkEntity(check: EvidenceCheck, view: KnowledgeView): string | null {
  if (check.check === 'gap-resolved') return view.gaps.get(check.gapId)?.subjectId ?? null
  return check.entityId
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Endpoints whose responses speak for an entity: itself (endpoint) or its instances (API operation). */
function responseEntities(view: KnowledgeView, node: SecurityGraphNode): SecurityGraphNode[] {
  if (node.kind === 'endpoint') return [node]
  if (node.kind === 'api-operation') {
    return (view.adjacency.get(node.id) ?? [])
      .filter((e) => e.type === 'BELONGS_TO' && e.toId === node.id && e.status !== 'stale' && e.status !== 'superseded')
      .map((e) => view.nodes.get(e.fromId))
      .filter((n): n is SecurityGraphNode => !!n)
  }
  if (node.kind === 'host') return [...view.nodes.values()].filter((n) => n.kind === 'endpoint' && n.key === `endpoint:${node.label}/`)
  return []
}

const toolsOf = (observations: SecurityObservation[]) => [...new Set(observations.flatMap((o) => o.contributions.map((c) => c.tool)))].sort()

/** Evaluates one evidence check against the current graph (pure, deterministic). */
export function evaluateCheck(check: EvidenceCheck, index: number, view: KnowledgeView): CheckResult {
  const base = { index, effect: check.effect }
  if (check.check === 'gap-resolved') {
    const gap = view.gaps.get(check.gapId)
    if (!gap) return { ...base, met: false, detail: 'The knowledge gap no longer exists', observationIds: [], tools: [] }
    const obs = gap.resolvedBy?.observationId ? view.observations.get(gap.resolvedBy.observationId) : undefined
    return gap.status === 'resolved'
      ? { ...base, met: true, detail: `Answered: ${gap.resolution ?? 'resolved'}`, observationIds: obs ? [obs.id] : [], tools: obs ? toolsOf([obs]) : [] }
      : { ...base, met: false, detail: `Still unknown: ${gap.question}`, observationIds: [], tools: [] }
  }
  const node = view.nodes.get(check.entityId)
  if (!node) return { ...base, met: false, detail: 'The entity is not in the graph', observationIds: [], tools: [] }
  switch (check.check) {
    case 'response-status': {
      const matching = responseEntities(view, node)
        .flatMap((e) => [...(view.observationsByNode.get(e.id) ?? [])])
        .map((id) => view.observations.get(id))
        .filter((o): o is SecurityObservation => !!o && (o.type === 'http-response' || (o.type === 'endpoint' && o.value.contacted !== false)))
        .filter((o) => check.statuses.includes(num(o.value.status) ?? -1))
      return matching.length
        ? { ...base, met: true, detail: `Observed HTTP ${[...new Set(matching.map((o) => num(o.value.status)))].join('/')} on ${node.label}`, observationIds: matching.map((o) => o.id), tools: toolsOf(matching) }
        : { ...base, met: false, detail: `No observed response with status ${check.statuses.join('/')} for ${node.label}`, observationIds: [], tools: [] }
    }
    case 'independent-corroboration': {
      const observations = [...(view.observationsByNode.get(node.id) ?? [])].map((id) => view.observations.get(id)).filter((o): o is SecurityObservation => !!o)
      let tools = node.tools
      let supporting = observations
      if (node.kind === 'signal') {
        // A heuristic signal is corroborated by its confirming observation from another tool (e.g. a Server header).
        const rule = SIGNAL_CONFIRMATIONS[String(node.attributes.templateId ?? '')]
        const affected = [...neighbourhood(view, [node.id])].flatMap((id) => [...neighbourhood(view, [id])])
        const confirming = rule
          ? [...new Set(affected)]
              .flatMap((id) => [...(view.observationsByNode.get(id) ?? [])])
              .map((id) => view.observations.get(id))
              .filter((o): o is SecurityObservation => !!o && o.type === rule.observationType && (!rule.subject || o.subject === rule.subject) && o.contributions.some((c) => !node.tools.includes(c.tool)))
          : []
        tools = [...new Set([...node.tools, ...toolsOf(confirming)])].sort()
        supporting = [...observations, ...confirming]
      }
      return tools.length >= 2
        ? { ...base, met: true, detail: `Reported independently by ${tools.join(' and ')}`, observationIds: supporting.map((o) => o.id).slice(0, 10), tools }
        : { ...base, met: false, detail: `Only ${tools.join(', ') || 'one sensor'} reported ${node.label}`, observationIds: [], tools }
    }
    case 'observation-present': {
      const matching = [...(view.observationsByNode.get(node.id) ?? [])].map((id) => view.observations.get(id)).filter((o): o is SecurityObservation => !!o && o.type === check.observationType)
      return matching.length
        ? { ...base, met: true, detail: `${check.observationType} observed for ${node.label}`, observationIds: matching.map((o) => o.id).slice(0, 10), tools: toolsOf(matching) }
        : { ...base, met: false, detail: `No ${check.observationType} observation for ${node.label} yet`, observationIds: [], tools: [] }
    }
    case 'entity-contradicted': {
      const contradicted = node.status === 'contradicted' || node.conflicts.length > 0
      return contradicted
        ? { ...base, met: true, detail: node.conflicts[0]?.reason ?? `${node.label} is contradicted`, observationIds: [], tools: node.tools }
        : { ...base, met: false, detail: `No conflicting fact about ${node.label}`, observationIds: [], tools: [] }
    }
  }
}

export interface CheckOutcome {
  results: CheckResult[]
  /** The status the evidence implies (null: the evidence does not change the status). */
  status: Extract<HypothesisStatus, 'disproved' | 'confirmed-signal' | 'supported'> | null
  confidence: number | null
  reason: string
}

/**
 * Evidence decides, never the model: a met contradicting check disproves; all supporting checks met with
 * evidence from two independent sensors (or a met corroboration check) is a confirmed signal; any met
 * supporting check is support. A confirmed signal is still not a verified vulnerability.
 */
export function assessChecks(checks: readonly EvidenceCheck[], view: KnowledgeView): CheckOutcome {
  const results = checks.map((c, i) => evaluateCheck(c, i, view))
  const contradicting = results.filter((r) => r.effect === 'contradicts' && r.met)
  if (contradicting.length) return { results, status: 'disproved', confidence: 0.05, reason: `Contradicted by evidence: ${contradicting[0]!.detail}` }
  const supports = results.filter((r) => r.effect === 'supports')
  const met = supports.filter((r) => r.met)
  if (supports.length && met.length === supports.length) {
    const tools = new Set(met.flatMap((r) => r.tools))
    const corroborated = met.some((r) => checks[r.index]?.check === 'independent-corroboration') || tools.size >= 2
    return corroborated
      ? { results, status: 'confirmed-signal', confidence: 0.9, reason: `Independently confirmed: ${met.map((r) => r.detail).join('; ')}` }
      : { results, status: 'supported', confidence: 0.75, reason: `Supported: ${met.map((r) => r.detail).join('; ')}` }
  }
  if (met.length) return { results, status: 'supported', confidence: 0.6, reason: `Partly supported: ${met.map((r) => r.detail).join('; ')}` }
  return { results, status: null, confidence: null, reason: 'Awaiting evidence' }
}

/** Paths and URLs mentioned in a claim must exist in the graph (a claim may not assert beyond what is known). */
export function claimOutsideGraph(claim: string, view: KnowledgeView): string | null {
  const origins = new Set([...view.nodes.values()].filter((n) => n.kind === 'host').map((n) => n.label))
  const known = [...view.nodes.values()].flatMap((n) => {
    if (n.kind === 'endpoint') return [n.label]
    if (n.kind === 'api-operation') return [String(n.attributes.template ?? '')]
    return []
  })
  for (const url of claim.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []) {
    const parts = urlParts(url.replace(/[.,;:]+$/, ''))
    if (!parts || !origins.has(parts.origin)) return `mentions ${url}, which is not in the graph`
    if (parts.path !== '/' && !known.some((k) => k === parts.path || k.startsWith(`${parts.path}/`))) return `mentions ${url}, which is not in the graph`
  }
  const withoutUrls = claim.replace(/https?:\/\/[^\s"'<>)\]]+/g, ' ')
  for (const raw of withoutUrls.match(/(?<![\w.])\/[A-Za-z0-9_\-{}.~%/]+/g) ?? []) {
    const path = raw.replace(/[.,;:]+$/, '').replace(/\/+$/, '') || '/'
    if (path === '/' || path.length < 2) continue
    if (!known.some((k) => k === path || k.startsWith(`${path}/`))) return `mentions ${path}, which is not in the graph`
  }
  return null
}

/** A support-based ceiling on a proposal's confidence: more cited evidence, more room — never certainty. */
export function confidenceCeiling(supporting: number): number {
  return Math.min(0.75, 0.25 + 0.15 * Math.min(3, supporting))
}

export function validateProposal(proposal: ProposedHypothesis, view: KnowledgeView, accepted: readonly { dedupeKey: string }[] = []): ProposalVerdict {
  const reject = (reason: RejectionReason, detail: string): ProposalVerdict => ({ kind: 'reject', proposal, reason, detail })
  const notes: string[] = []

  const missingEntity = proposal.subjectEntityIds.find((id) => !view.nodes.has(id))
  if (missingEntity) return reject('unknown-entity', `${missingEntity} is not an entity in the graph`)
  const cited = [...proposal.supportingObservationIds, ...proposal.contradictingObservationIds]
  const missingEvidence = cited.find((id) => !view.observations.has(id))
  if (missingEvidence) return reject('unknown-evidence', `${missingEvidence} is not a recorded observation`)
  const missingGap = proposal.gapIds.find((id) => !view.gaps.has(id))
  if (missingGap) return reject('unknown-gap', `${missingGap} is not a recorded knowledge gap`)
  if (!proposal.evidenceChecks.some((c) => c.effect === 'supports')) return reject('invalid-check', 'A hypothesis needs at least one check that would support it')
  for (const check of proposal.evidenceChecks) {
    if (check.check === 'gap-resolved') {
      if (!view.gaps.has(check.gapId)) return reject('invalid-check', `check references unknown gap ${check.gapId}`)
      continue
    }
    const node = view.nodes.get(check.entityId)
    if (!node) return reject('invalid-check', `check references unknown entity ${check.entityId}`)
    if (check.check === 'response-status' && !['endpoint', 'api-operation', 'host'].includes(node.kind)) return reject('invalid-check', `a response-status check needs an endpoint or API operation, not a ${node.kind}`)
  }

  // Cited evidence must be about the hypothesis' entities (or their neighbours) — no borrowed evidence.
  const related = observationsAbout(view, [...proposal.subjectEntityIds, ...proposal.gapIds.map((g) => view.gaps.get(g)!.subjectId)])
  const unrelated = cited.find((id) => !related.has(id))
  if (unrelated) return reject('unrelated-evidence', `${unrelated} is not evidence about the hypothesis' entities`)
  if (proposal.supportingObservationIds.length === 0 && proposal.gapIds.length === 0) {
    return reject('unsupported', 'A hypothesis must cite supporting observations or the knowledge gap it is about')
  }
  const outside = claimOutsideGraph(proposal.claim, view)
  if (outside) return reject('claim-outside-graph', `The claim ${outside}`)

  const outOfScope = proposal.subjectEntityIds.map((id) => view.nodes.get(id)!).find((n) => n.scopeClass === 'out-of-scope' || n.scopeClass === 'third-party')
  if (outOfScope) return reject('out-of-scope', `${outOfScope.label} is ${outOfScope.scopeClass}; Audivra investigates in-scope assets only`)

  // Capabilities: those named must exist and be usable here; otherwise derive them from the evidence needs.
  // A capability counts only if it can bring *new* evidence (not merely re-observe what it already reported).
  const outcome = assessChecks(proposal.evidenceChecks, view)
  const usable = capabilityFits({ id: 'proposal', evidenceChecks: proposal.evidenceChecks, candidateCapabilities: [] }, outcome.results, view)
    .filter((f) => f.fullCoverage > 0)
    .map((f) => f.capability)
    .sort((a, b) => a.id.localeCompare(b.id))
  const named = proposal.candidateCapabilities.filter((id) => usable.some((c) => c.id === id))
  if (proposal.candidateCapabilities.length && named.length < proposal.candidateCapabilities.length) {
    notes.push(`Dropped candidate capabilities that cannot produce the needed evidence here: ${proposal.candidateCapabilities.filter((id) => !named.includes(id)).join(', ')}`)
  }
  const candidateCapabilities = named.length ? named : usable.map((c) => c.id)
  if (candidateCapabilities.length === 0) {
    const needs = [...new Set(proposal.evidenceChecks.flatMap((c) => checkNeeds(c, view)))]
    return reject('capability-unavailable', needs.length ? `No capability that may run in this environment produces ${needs.join(', ')}` : 'No shipped capability can produce the evidence this needs')
  }

  // A hypothesis whose outcome is already decided is not worth investigating.
  if (outcome.status === 'disproved') return reject('already-contradicted', outcome.reason)
  if (outcome.status === 'confirmed-signal' || (outcome.status === 'supported' && outcome.results.filter((r) => r.effect === 'supports').every((r) => r.met))) {
    return reject('already-established', outcome.reason)
  }

  // Duplicates: the same entity set as an existing (or just-accepted) hypothesis, or a model-suggested
  // duplicate whose entities agree.
  const dedupeKey = hypothesisDedupeKey(proposal.subjectEntityIds)
  const existing = view.hypotheses.find((h) => h.dedupeKey === dedupeKey)
  if (existing) return { kind: 'duplicate', proposal, existing, notes: ['Same affected entities as an existing hypothesis'] }
  if (proposal.duplicateOf) {
    const suggested = view.hypotheses.find((h) => h.id === proposal.duplicateOf)
    if (suggested && proposal.subjectEntityIds.every((id) => suggested.subjectEntityIds.includes(id))) {
      return { kind: 'duplicate', proposal, existing: suggested, notes: ['The model marked it as a restatement and the affected entities agree'] }
    }
    notes.push('A suggested duplicate was ignored: its affected entities do not agree')
  }
  if (accepted.some((a) => a.dedupeKey === dedupeKey)) return reject('restated-in-batch', 'Restates another proposal in the same batch (same affected entities)')

  const ceiling = confidenceCeiling(proposal.supportingObservationIds.length)
  const confidence = Math.min(proposal.confidence, ceiling)
  if (confidence < proposal.confidence) notes.push(`Confidence clamped from ${proposal.confidence.toFixed(2)} to ${confidence.toFixed(2)} (support-based ceiling)`)
  return { kind: 'accept', proposal, dedupeKey, candidateCapabilities, confidence, notes }
}

/** Open = still worth investigating (not disproved, confirmed or exhausted). */
export const isOpenHypothesis = (h: Pick<SecurityHypothesis, 'status'>) => !isResolvedHypothesis(h.status)

/** Entities a hypothesis is about plus those its checks touch. */
export function hypothesisEntities(h: Pick<SecurityHypothesis, 'subjectEntityIds' | 'evidenceChecks'>, view: KnowledgeView): string[] {
  return [...new Set([...h.subjectEntityIds, ...h.evidenceChecks.map((c) => checkEntity(c, view)).filter((id): id is string => !!id)])]
}
