import type { AiOutcome, ProviderCapabilities, ProviderHealth, ProviderHealthState } from '@audivra/contracts'
import type { AgentProvider, AgentRunRequest, AgentRunResult, ProviderAvailability } from '../provider.ts'

/*
 * A deterministic, rule-based stand-in for a model on the Phase 4 reasoning tasks. It is a real
 * `AgentProvider` (selected and routed by the ProviderRouter like any other), reads the JSON sections of the
 * context Audivra rendered, and answers with schema-shaped output — so tests, the E2E and the reasoning
 * benchmark exercise the full loop (router → provider → validation → persistence → broker) with no network,
 * no process and no Claude specifics. It is eligible only for security reasoning tasks.
 *
 * Behaviours let a test or benchmark apply false-positive pressure: an `adversarial` researcher mixes
 * grounded hypotheses with invented ids, invented evidence, restatements, claims beyond the graph, borrowed
 * evidence and out-of-scope subjects; an `expensive`/`invalid`/`redundant` planner proposes actions Audivra
 * must refuse. Failures (unavailable, refusal, malformed output) can be scripted per task.
 */

export interface ScriptedReasonerOptions {
  id?: string
  health?: ProviderHealthState | (() => ProviderHealthState)
  researcher?: 'grounded' | 'adversarial' | 'silent'
  verifier?: 'approve' | 'strict'
  planner?: 'cheapest' | 'expensive' | 'invalid' | 'redundant'
  /** Normalized outcome to fail a task with (e.g. `provider-unavailable`, `provider-refused`), or `malformed`. */
  fail?: Partial<Record<'researcher' | 'verifier' | 'planner', AiOutcome | 'malformed'>>
  /** Called for every request (to inspect prompts in tests). */
  onRequest?: (request: AgentRunRequest) => void
}

interface TaskInput {
  maxHypotheses?: number
  openGaps?: { id: string; kind: string; question: string; entityId: string; answeredBy: string[] }[]
  existingHypotheses?: { id: string; claim: string; subjectEntityIds: string[]; status: string }[]
  proposals?: { proposal: number; supportingObservationIds: string[] }[]
  hypotheses?: { id: string; eligibleCapabilities: { id: string; costClass: string; targets: string[]; alreadyTried: boolean }[] }[]
}
interface GraphData {
  entities?: { id: string; kind: string; label: string; scopeClass: string | null; tools: string[]; attributes: Record<string, unknown> }[]
  relationships?: { type: string; fromId: string; toId: string }[]
  observations?: { id: string; type: string; title: string; asset: string; subject: string }[]
}

function readJson<T>(prompt: string, label: string): T | null {
  const marker = `### ${label} (JSON)\n\`\`\`json\n`
  const start = prompt.indexOf(marker)
  if (start < 0) return null
  const end = prompt.indexOf('\n```', start + marker.length)
  try {
    return JSON.parse(prompt.slice(start + marker.length, end)) as T
  } catch {
    return null
  }
}

const ROLE_TASK: Record<string, 'researcher' | 'verifier' | 'planner'> = { 'security-researcher': 'researcher', 'security-verifier': 'verifier', 'security-planner': 'planner' }

export class ScriptedReasoningProvider implements AgentProvider {
  readonly id: string
  readonly adapterVersion = 'scripted-reasoner-1'
  readonly requests: AgentRunRequest[] = []
  readonly #options: ScriptedReasonerOptions
  readonly #health: () => ProviderHealthState
  #session = 0

  constructor(options: ScriptedReasonerOptions = {}) {
    this.id = options.id ?? 'scripted-reasoner'
    this.#options = options
    const h = options.health ?? 'ready'
    this.#health = typeof h === 'function' ? h : () => h
  }

  async isAvailable(): Promise<ProviderAvailability> {
    const state = this.#health()
    return { available: state === 'ready', version: this.adapterVersion, reason: state === 'ready' ? null : state }
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, state: this.#health(), version: this.adapterVersion, detail: 'Deterministic rule-based reasoning (tests, E2E, benchmarks)', checkedAt: new Date().toISOString() }
  }

  capabilities(): ProviderCapabilities {
    return {
      providerId: this.id,
      structuredOutput: true,
      toolUse: false,
      sessionResume: false,
      browserTools: false,
      maxContextTokens: 200_000,
      effortLevels: ['low', 'standard', 'high'],
      taskTypes: ['security-understand', 'security-plan', 'security-analyze-observations', 'security-verify-claim', 'security-summarize'],
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request)
    this.#options.onRequest?.(request)
    const task = ROLE_TASK[request.role] ?? null
    const base = { sessionId: `${this.id}-session-${++this.#session}`, model: `${this.id}-rules`, numTurns: 1, costUsd: null, durationMs: 1, permissionDenials: [], usage: null, toolCalls: {} }
    const failure = task ? this.#options.fail?.[task] : undefined
    if (failure === 'malformed') return { ...base, status: 'completed', output: { unexpected: true }, error: null, terminationReason: 'completed' }
    if (failure) return { ...base, status: failure === 'cancelled' ? 'cancelled' : 'failed', output: null, error: failure, terminationReason: failure }
    const input = readJson<TaskInput>(request.prompt, 'Task input') ?? {}
    const graph = readJson<GraphData>(request.prompt, 'Graph data') ?? {}
    const output = task === 'researcher' ? this.#research(input, graph) : task === 'verifier' ? this.#verify(input) : task === 'planner' ? this.#plan(input) : {}
    return { ...base, status: 'completed', output, error: null, terminationReason: 'completed' }
  }

  #research(input: TaskInput, graph: GraphData) {
    if (this.#options.researcher === 'silent') return { hypotheses: [], relationships: [], notes: 'Nothing worth investigating.' }
    const entities = new Map((graph.entities ?? []).map((e) => [e.id, e]))
    const covered = new Set((input.existingHypotheses ?? []).flatMap((h) => h.subjectEntityIds))
    const hypotheses: Record<string, unknown>[] = []
    const neighbours = (id: string) => new Set([id, ...(graph.relationships ?? []).flatMap((r) => (r.fromId === id ? [r.toId] : r.toId === id ? [r.fromId] : []))])
    const trim = (u: string) => u.replace(/\/+$/, '')
    const urlOf = (e: { label: string; attributes: Record<string, unknown> }) => trim(String(e.attributes.url ?? e.attributes.concreteUrl ?? e.label))
    for (const gap of input.openGaps ?? []) {
      if (hypotheses.length >= 4) break
      if (!gap.answeredBy.length || covered.has(gap.entityId)) continue
      const entity = entities.get(gap.entityId)
      if (!entity || entity.scopeClass === 'out-of-scope' || entity.scopeClass === 'third-party') continue
      const near = neighbours(entity.id)
      const nearUrls = new Set([...near].map((id) => entities.get(id)).filter(Boolean).map((e) => urlOf(e!)))
      const name = String(entity.attributes.name ?? entity.label).toLowerCase()
      const evidence = (graph.observations ?? [])
        .filter((o) => (entity.kind === 'technology' ? (o.type === 'technology' || o.type === 'http-header') && `${o.title} ${o.subject}`.toLowerCase().includes(name) : nearUrls.has(trim(o.asset)) || trim(o.asset) === urlOf(entity)))
        .map((o) => o.id)
        .slice(0, 3)
      const common = { subjectEntityIds: [entity.id], supportingObservationIds: evidence, contradictingObservationIds: [], gapIds: [gap.id], candidateCapabilities: [], duplicateOf: null }
      if (gap.kind === 'technology-uncorroborated') {
        hypotheses.push({ ...common, claim: `${entity.label} is in use (reported by ${entity.tools.join(', ') || 'one sensor'} only; not yet corroborated)`, category: 'technology', impact: 'medium', confidence: 0.5, evidenceChecks: [{ check: 'independent-corroboration', entityId: entity.id, effect: 'supports' }, { check: 'entity-contradicted', entityId: entity.id, effect: 'contradicts' }], rationale: 'A single fingerprint is a weak basis; an independent sensor reporting the same technology would confirm it cheaply.' })
      } else if (gap.kind === 'endpoint-behavior-unknown') {
        hypotheses.push({ ...common, claim: `The discovered endpoint ${entity.label} answers anonymous requests`, category: 'endpoint-behavior', impact: 'medium', confidence: 0.4, evidenceChecks: [{ check: 'response-status', entityId: entity.id, statuses: [200, 204], effect: 'supports' }, { check: 'response-status', entityId: entity.id, statuses: [401, 403, 404, 410], effect: 'contradicts' }], rationale: 'It was discovered but never inspected; one passive request settles how it behaves.' })
      } else if (gap.kind === 'api-operation-unobserved') {
        hypotheses.push({ ...common, claim: `The API operation ${entity.label} is reachable without authentication`, category: 'api-surface', impact: 'high', confidence: 0.35, evidenceChecks: [{ check: 'response-status', entityId: entity.id, statuses: [200], effect: 'supports' }, { check: 'response-status', entityId: entity.id, statuses: [401, 403], effect: 'contradicts' }], rationale: 'The contract exposes it but the application surface never showed it; a passive request shows whether it is reachable.' })
      } else if (gap.kind === 'signal-unconfirmed') {
        hypotheses.push({ ...common, claim: `The "${entity.label}" signal is genuine`, category: 'signal-confirmation', impact: 'low', confidence: 0.5, evidenceChecks: [{ check: 'independent-corroboration', entityId: entity.id, effect: 'supports' }], rationale: 'A scanner heuristic needs independent confirmation before it means anything.' })
      } else if (gap.kind === 'authentication-requirement-unknown') {
        hypotheses.push({ ...common, claim: `${entity.label} requires authentication`, category: 'endpoint-behavior', impact: 'high', confidence: 0.4, evidenceChecks: [{ check: 'response-status', entityId: entity.id, statuses: [401, 403], effect: 'supports' }, { check: 'response-status', entityId: entity.id, statuses: [200], effect: 'contradicts' }], rationale: 'Whether it is protected is unknown; a passive request answers it.' })
      }
      covered.add(entity.id)
    }

    if (this.#options.researcher === 'adversarial') {
      const first = hypotheses[0]
      const entity = [...entities.values()].find((e) => e.kind === 'endpoint' && e.scopeClass === 'in-scope') ?? [...entities.values()][0]
      const other = (graph.observations ?? []).find((o) => entity && trim(o.asset) !== urlOf(entity))
      const outOfScope = [...entities.values()].find((e) => e.scopeClass === 'out-of-scope' || e.scopeClass === 'third-party')
      const check = (id: string) => [{ check: 'response-status', entityId: id, statuses: [200], effect: 'supports' }]
      const base = { contradictingObservationIds: [], gapIds: [], candidateCapabilities: [], duplicateOf: null, category: 'endpoint-behavior', impact: 'high', confidence: 0.95, rationale: 'Adversarial proposal used to measure validation.' }
      if (first) hypotheses.push({ ...first, claim: `Restated: ${String(first.claim)}`, duplicateOf: null })
      hypotheses.push({ ...base, claim: 'The admin console is exposed without authentication', subjectEntityIds: ['gn_00000000000000'], supportingObservationIds: [], evidenceChecks: check('gn_00000000000000') })
      if (entity) {
        hypotheses.push({ ...base, claim: `${entity.label} leaks credentials`, subjectEntityIds: [entity.id], supportingObservationIds: ['obs_zzzzzzzzzzzzzz'], evidenceChecks: check(entity.id) })
        const own = (graph.observations ?? []).find((o) => trim(o.asset) === urlOf(entity))
        hypotheses.push({ ...base, claim: 'The /secret-admin panel is reachable', subjectEntityIds: [entity.id], supportingObservationIds: own ? [own.id] : [], gapIds: [], evidenceChecks: check(entity.id) })
        if (other) hypotheses.push({ ...base, claim: `${entity.label} is misconfigured`, subjectEntityIds: [entity.id], supportingObservationIds: [other.id], evidenceChecks: check(entity.id) })
      }
      if (outOfScope) hypotheses.push({ ...base, claim: `${outOfScope.label} is vulnerable`, subjectEntityIds: [outOfScope.id], supportingObservationIds: [], evidenceChecks: check(outOfScope.id) })
    }
    return { hypotheses: hypotheses.slice(0, 8), relationships: [], notes: `${hypotheses.length} hypotheses from ${input.openGaps?.length ?? 0} open knowledge gaps.` }
  }

  #verify(input: TaskInput) {
    return {
      reviews: (input.proposals ?? []).map((p) => ({
        proposal: p.proposal,
        verdict: this.#options.verifier === 'strict' && p.supportingObservationIds.length < 2 ? 'needs-evidence' : 'reasonable',
        duplicateOf: null,
        contradictingObservationIds: [],
        note: this.#options.verifier === 'strict' && p.supportingObservationIds.length < 2 ? 'Thin evidence; investigate before believing it.' : 'Grounded in the cited observations.',
      })),
    }
  }

  #plan(input: TaskInput) {
    const actions: Record<string, unknown>[] = []
    for (const h of input.hypotheses ?? []) {
      const options = h.eligibleCapabilities ?? []
      const mode = this.#options.planner ?? 'cheapest'
      if (mode === 'invalid') {
        actions.push({ hypothesisId: h.id, capabilityId: 'diagnostic.runtime-check', input: { target: 'http://203.0.113.9/' }, expectedEvidence: 'anything', reason: 'Testing validation.' })
        actions.push({ hypothesisId: h.id, capabilityId: options[0]?.id ?? 'discovery.http-inspect', input: { url: 'http://203.0.113.9/', command: 'curl http://evil' }, expectedEvidence: 'anything', reason: 'Testing validation.' })
        continue
      }
      const pick =
        mode === 'expensive'
          ? [...options].sort((a, b) => ({ low: 1, medium: 2, high: 4 })[b.costClass as 'low']! - ({ low: 1, medium: 2, high: 4 })[a.costClass as 'low']!)[0]
          : mode === 'redundant'
            ? (options.find((o) => o.alreadyTried) ?? options[0])
            : (options.find((o) => !o.alreadyTried) ?? null)
      if (!pick || !pick.targets[0]) continue
      actions.push({ hypothesisId: h.id, capabilityId: pick.id, input: { url: pick.targets[0] }, expectedEvidence: `Evidence from ${pick.id} that settles the hypothesis' unmet checks`, reason: `${pick.id} is the cheapest eligible capability that produces the needed evidence.` })
    }
    return { actions: actions.slice(0, 4), notes: '' }
  }
}
