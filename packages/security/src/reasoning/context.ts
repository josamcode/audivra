import { GRAPH_ENTITY_KINDS, HYPOTHESIS_CATEGORIES, type ProposedHypothesis, type SecurityGraphNode, type SecurityHypothesis, type SecurityObservation } from '@audivra/contracts'
import { jsonSection, type ReasoningContextSection } from './ai.ts'
import { evaluateCheck, isOpenHypothesis } from './hypotheses.ts'
import type { KnowledgeView } from './knowledge.ts'
import { capabilityFits } from './ranking.ts'

/*
 * Bounded, relevant context for each reasoning task — never the whole engagement database. Entities are
 * selected by relevance (open unknowns, open hypotheses, contradictions, connectivity), then their direct
 * neighbourhood and the observations that support them, each within a fixed budget. Audivra-owned material
 * (scope, rules, capabilities, gaps, hypotheses) is TRUSTED; anything that came from the target or a tool
 * (labels, titles, URLs, observation content) is UNTRUSTED data, never instructions.
 */

export const CONTEXT_LIMITS = { entities: 80, relationships: 160, observations: 100, gaps: 40, hypotheses: 40, plannerHypotheses: 4 } as const

const GAP_PRIORITY: Record<string, number> = {
  'contradiction-unresolved': 0,
  'signal-unconfirmed': 1,
  'api-operation-unobserved': 2,
  'endpoint-behavior-unknown': 3,
  'technology-uncorroborated': 4,
  'authentication-requirement-unknown': 5,
}

function entityAttributes(n: SecurityGraphNode): Record<string, unknown> {
  const pick = (...names: string[]) => Object.fromEntries(names.filter((k) => n.attributes[k] !== undefined).map((k) => [k, n.attributes[k]]))
  switch (n.kind) {
    case 'endpoint':
      return pick('url', 'status', 'title', 'methods', 'contentType')
    case 'technology':
      return pick('name', 'versions')
    case 'api-operation':
      return pick('method', 'template', 'concreteUrl')
    case 'signal':
      return pick('observationType', 'templateId', 'subject', 'toolSeverity', 'type', 'operation')
    case 'parameter':
      return pick('location', 'name')
    case 'identity':
      return pick('identityType', 'authMethod', 'lifecycle', 'credentialConfigured')
    case 'tenant':
      return pick('tenantType', 'externalId')
    case 'resource':
      return pick('resourceType', 'testData', 'externalId', 'endpoint')
    case 'business-action':
      return pick('verb', 'effectClass', 'actsOnResourceType')
    case 'business-state':
      return pick('resourceType', 'terminal')
    case 'invariant':
      return pick('category', 'rule', 'status', 'expectation')
    default:
      return {}
  }
}

function describeEntity(n: SecurityGraphNode) {
  return { id: n.id, kind: n.kind, label: n.label, basis: n.basis, confidence: n.confidence, status: n.status, scopeClass: n.scopeClass, tools: n.tools, attributes: entityAttributes(n), conflicts: n.conflicts.map((c) => c.reason) }
}

function describeObservation(o: SecurityObservation) {
  return { id: o.id, type: o.type, title: o.title, asset: o.asset, subject: o.subject, sourceType: o.sourceType, confidence: o.confidence, tools: [...new Set(o.contributions.map((c) => c.tool))] }
}

const OBS_PRIORITY = ['technology', 'web-signal', 'http-response', 'http-header', 'api-operation', 'api-validation', 'redirect', 'form', 'endpoint', 'source-finding']

/** Relevance-ranked graph slice (bounded). */
export function selectGraphSlice(view: KnowledgeView, focus: Iterable<string> = []) {
  const openGaps = [...view.gaps.values()].filter((g) => g.status === 'open')
  const gapSubjects = new Set(openGaps.map((g) => g.subjectId))
  const hypothesisSubjects = new Set(view.hypotheses.filter(isOpenHypothesis).flatMap((h) => h.subjectEntityIds))
  const focusSet = new Set(focus)
  const score = (n: SecurityGraphNode) => {
    let s = 0
    if (focusSet.has(n.id)) s += 10
    if (gapSubjects.has(n.id)) s += 6
    if (hypothesisSubjects.has(n.id)) s += 4
    if (n.status === 'contradicted') s += 3
    if (n.kind === 'endpoint' || n.kind === 'api-operation' || n.kind === 'technology' || n.kind === 'signal') s += 2
    if (n.kind === 'parameter') s -= 1
    if (n.status === 'stale' || n.status === 'superseded') s -= 4
    if (n.scopeClass === 'out-of-scope' || n.scopeClass === 'third-party') s -= 3
    s += Math.min(3, (view.adjacency.get(n.id)?.length ?? 0) / 3)
    return s
  }
  const ranked = [...view.nodes.values()].map((n) => ({ n, s: score(n) })).sort((a, b) => b.s - a.s || GRAPH_ENTITY_KINDS.indexOf(a.n.kind) - GRAPH_ENTITY_KINDS.indexOf(b.n.kind) || a.n.key.localeCompare(b.n.key))
  const selected = new Map<string, SecurityGraphNode>()
  for (const { n } of ranked) {
    if (selected.size >= CONTEXT_LIMITS.entities) break
    selected.set(n.id, n)
  }
  const relationships = view.edges
    .filter((e) => selected.has(e.fromId) && selected.has(e.toId))
    .slice(0, CONTEXT_LIMITS.relationships)
    .map((e) => ({ type: e.type, fromId: e.fromId, toId: e.toId, basis: e.basis, status: e.status }))
  const observationIds = new Set<string>()
  for (const id of selected.keys()) for (const o of view.observationsByNode.get(id) ?? []) observationIds.add(o)
  const observations = [...observationIds]
    .map((id) => view.observations.get(id))
    .filter((o): o is SecurityObservation => !!o)
    .sort((a, b) => (OBS_PRIORITY.indexOf(a.type) + 1 || 99) - (OBS_PRIORITY.indexOf(b.type) + 1 || 99) || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id))
    .slice(0, CONTEXT_LIMITS.observations)
  const gaps = openGaps
    .sort((a, b) => (GAP_PRIORITY[a.kind] ?? 9) - (GAP_PRIORITY[b.kind] ?? 9) || a.subjectKey.localeCompare(b.subjectKey))
    .slice(0, CONTEXT_LIMITS.gaps)
  return { entities: [...selected.values()], relationships, observations, gaps }
}

function engagementSection(view: KnowledgeView): ReasoningContextSection {
  const scope = view.engagement.scope
  return {
    label: 'Engagement',
    content: [
      `Target: ${view.engagement.targetUrl}`,
      `Environment: ${view.engagement.environment ?? 'not set (treated as production)'}`,
      `In-scope hosts: ${scope.hosts.map((t) => `${t.host}${t.includeSubdomains ? ' (+subdomains)' : ''}${t.ports ? ` ports ${t.ports.join('/')}` : ''}`).join(', ') || '(none)'}`,
      'Phase 4 reasoning domains only: attack-surface understanding, technology correlation, endpoint/API understanding, configuration inconsistencies, evidence gaps, sensor follow-up. No exploitation, no authorization or business-logic testing, no claims of verified vulnerabilities.',
    ].join('\n'),
  }
}

function capabilitySummary(view: KnowledgeView) {
  return view.capabilities.map((c) => ({ id: c.id, name: c.name, tool: c.tool, observes: c.observationTypes, costClass: c.costClass, riskClass: c.riskClass, eligibleHere: c.eligibleHere, plannable: c.plannable, reason: c.reason }))
}

function hypothesisSummary(h: SecurityHypothesis) {
  return { id: h.id, claim: h.claim, category: h.category, status: h.status, confidence: h.confidence, subjectEntityIds: h.subjectEntityIds }
}

/** Researcher: current knowledge + unknowns → hypotheses (and optional relationship enrichment). */
export function researcherContext(view: KnowledgeView) {
  const slice = selectGraphSlice(view)
  const hypotheses = [...view.hypotheses].sort((a, b) => Number(isOpenHypothesis(b)) - Number(isOpenHypothesis(a)) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, CONTEXT_LIMITS.hypotheses)
  return {
    slice,
    context: {
      trusted: [
        engagementSection(view),
        jsonSection('Task input', {
          maxHypotheses: 8,
          categories: HYPOTHESIS_CATEGORIES,
          checkKinds: ['response-status', 'independent-corroboration', 'observation-present', 'entity-contradicted', 'gap-resolved'],
          capabilities: capabilitySummary(view),
          openGaps: slice.gaps.map((g) => ({ id: g.id, kind: g.kind, question: g.question, entityId: g.subjectId, answeredBy: g.answeredBy })),
          existingHypotheses: hypotheses.map(hypothesisSummary),
        }),
      ],
      untrusted: [
        jsonSection('Graph data', {
          entities: slice.entities.map(describeEntity),
          relationships: slice.relationships,
          observations: slice.observations.map(describeObservation),
        }),
      ],
    },
    instruction: [
      'Propose security hypotheses worth investigating next, grounded ONLY in the entities, observations and knowledge gaps above.',
      'Rules: reference only ids that appear above (entities gn_…, observations obs_…, gaps gg_…, hypotheses hy_…); cite the observations that support each claim or the gap it is about;',
      'define 1–4 machine-checkable evidence checks (at least one that would support the claim, ideally one that would contradict it), all currently unmet;',
      'do not restate an existing hypothesis (set duplicateOf if yours is the same concern); prefer questions one cheap, eligible capability can answer;',
      'say "unknown" rather than inventing certainty. Return at most 8 hypotheses. Relationships are optional and only between listed entities with supporting observations.',
    ].join(' '),
  }
}

/** Verifier: an independent review of accepted proposals against the cited evidence. */
export function verifierContext(view: KnowledgeView, proposals: readonly ProposedHypothesis[]) {
  const cited = new Set(proposals.flatMap((p) => [...p.supportingObservationIds, ...p.contradictingObservationIds]))
  const entityIds = new Set(proposals.flatMap((p) => p.subjectEntityIds))
  for (const id of entityIds) for (const o of [...(view.observationsByNode.get(id) ?? [])].slice(0, 10)) cited.add(o)
  return {
    context: {
      trusted: [
        jsonSection('Task input', {
          proposals: proposals.map((p, i) => ({ proposal: i, claim: p.claim, category: p.category, impact: p.impact, confidence: p.confidence, subjectEntityIds: p.subjectEntityIds, supportingObservationIds: p.supportingObservationIds, evidenceChecks: p.evidenceChecks })),
          existingHypotheses: view.hypotheses.slice(0, CONTEXT_LIMITS.hypotheses).map(hypothesisSummary),
          verdicts: ['reasonable', 'unsupported', 'duplicate', 'contradicted', 'needs-evidence'],
        }),
      ],
      untrusted: [
        jsonSection('Graph data', {
          entities: [...entityIds].map((id) => view.nodes.get(id)).filter((n): n is SecurityGraphNode => !!n).map(describeEntity),
          observations: [...cited].map((id) => view.observations.get(id)).filter((o): o is SecurityObservation => !!o).slice(0, CONTEXT_LIMITS.observations).map(describeObservation),
        }),
      ],
    },
    instruction:
      'Review each proposal independently against the cited observations. Classify it: reasonable, unsupported (the evidence does not support the claim), duplicate (of an existing hypothesis — give its id), contradicted (cite the contradicting observation ids), or needs-evidence. Be conservative: when the evidence is thin, say so.',
  }
}

/** Planner: the top-ranked open hypotheses → the next useful capability for each (typed, never raw authority). */
export function plannerContext(view: KnowledgeView, ranked: readonly SecurityHypothesis[]) {
  const top = ranked.slice(0, CONTEXT_LIMITS.plannerHypotheses)
  const entities = new Set(top.flatMap((h) => h.subjectEntityIds))
  return {
    top,
    context: {
      trusted: [
        engagementSection(view),
        jsonSection('Task input', {
          maxActions: 4,
          hypotheses: top.map((h) => {
            const results = h.evidenceChecks.map((c, i) => evaluateCheck(c, i, view))
            const fits = capabilityFits(h, results, view)
            return {
              id: h.id,
              claim: h.claim,
              status: h.status,
              confidence: h.confidence,
              impact: h.impact,
              unmetChecks: results.filter((r) => !r.met).map((r) => ({ check: h.evidenceChecks[r.index], detail: r.detail })),
              ranking: h.ranking ? { priority: h.ranking.priority, expectedInformationGain: h.ranking.expectedInformationGain, explanation: h.ranking.explanation } : null,
              eligibleCapabilities: fits.map((f) => ({ id: f.capability.id, costClass: f.capability.costClass, resolvability: Math.round(f.resolvability * 100) / 100, targets: f.targets, alreadyTried: f.previouslyTried })),
            }
          }),
          capabilities: view.capabilities.filter((c) => c.eligibleHere && c.plannable).map((c) => ({ id: c.id, description: c.description, costClass: c.costClass, riskClass: c.riskClass, typicalDurationSeconds: c.typicalDurationSeconds, observes: c.observationTypes, input: c.inputSchema })),
        }),
      ],
      untrusted: [jsonSection('Graph data', { entities: [...entities].map((id) => view.nodes.get(id)).filter((n): n is SecurityGraphNode => !!n).map(describeEntity) })],
    },
    instruction: [
      'For each hypothesis, propose at most one next capability that would reduce its uncertainty: give hypothesisId, capabilityId (one of the eligible capabilities listed for it), the capability input (a target from its listed targets), the evidence you expect and why.',
      'Prefer the cheapest capability that produces the needed evidence; never repeat one already tried unless nothing else fits; skip a hypothesis when no listed capability helps.',
      'You cannot choose images, commands, network access, scope or environment — Audivra and its policy decide whether anything runs.',
    ].join(' '),
  }
}
