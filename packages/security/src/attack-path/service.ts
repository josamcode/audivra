import { randomUUID } from 'node:crypto'
import type { Logger } from '@audivra/config'
import {
  AttackPathExplanationOutput,
  AttackPathProposalOutput,
  FINDING_WORTHY_STATES,
  type AttackPathTransition,
  type SecurityActor,
  type SecurityEventType,
  type SecurityFinding,
  type SecurityGraphEdge,
  type SecurityGraphNode,
} from '@audivra/contracts'
import {
  findAttackPathByKey,
  getAttackPathRow,
  getEngagementRow,
  insertAttackPath,
  listFindingsForEngagement,
  loadGraphRows,
  newAttackPathId,
  recordSecurityEvent,
  toAttackPath,
  toGraphEdge,
  toGraphNode,
  updateAttackPath,
  type Db,
} from '@audivra/database'
import { jsonSection, type ReasoningAi } from '../reasoning/ai.ts'
import { LOCAL_USER } from '../service.ts'
import { ATTACK_PATH_TASKS, attackPathJsonSchema } from './ai.ts'
import { buildAiChain, buildCandidatePath, discoverPaths, DEFAULT_BUDGET, type AttackPathView, type CandidatePath, type SearchBudget } from './discover.ts'
import { dedupeAndDominate, type KeyedPath } from './dedupe.ts'
import { synthesizePath } from './synthesize.ts'
import { validatePath } from './validate.ts'

/*
 * Phase 6B — the attack-path analysis as a service. It loads the finding-worthy findings and the Security
 * Graph, discovers evidence-backed paths deterministically (single-finding impacts and real connector
 * chains), optionally asks an AI to propose further correlations (validated the same way, never trusted),
 * deduplicates and relates dominated subpaths, and persists each path by its stable key. The deterministic
 * path analysis runs fully with no AI; a provider failure leaves existing paths visible and marks AI
 * enrichment partial — no path is falsely rejected or verified because the provider failed. No capability is
 * ever executed here.
 */

export interface AttackPathServiceOptions {
  db: Db
  ai?: ReasoningAi
  budget?: SearchBudget
  now?: () => Date
  log?: Logger
}

export interface AttackPathResult {
  findings: number
  deterministicCandidates: number
  aiProposed: number
  aiRejected: number
  aiOutcome: 'succeeded' | 'provider-unavailable' | 'provider-refused' | 'ai-output-invalid' | 'not-required'
  pathsCreated: number
  pathsUpdated: number
  verified: number
  partiallyVerified: number
  supported: number
  speculative: number
  rejected: number
  expansions: number
  terminationReason: string
}

export class AttackPathService {
  readonly #db: Db
  readonly #ai: ReasoningAi | undefined
  readonly #budget: SearchBudget
  readonly #now: () => Date
  readonly #log: Logger | undefined

  constructor(options: AttackPathServiceOptions) {
    this.#db = options.db
    this.#ai = options.ai
    this.#budget = options.budget ?? DEFAULT_BUDGET
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  async drive(engagementId: string, options: { actor?: SecurityActor; signal?: AbortSignal } = {}): Promise<AttackPathResult> {
    const actor = options.actor ?? LOCAL_USER
    const engagement = await getEngagementRow(this.#db, engagementId)
    if (!engagement) throw new Error(`No security engagement ${engagementId}`)
    const configVersion = engagement.configVersion
    const view = await this.#loadView(engagementId, engagement.environment)

    const { paths: deterministic, stats } = discoverPaths(view, this.#budget)
    const result: AttackPathResult = {
      findings: view.findings.length,
      deterministicCandidates: deterministic.length,
      aiProposed: 0,
      aiRejected: 0,
      aiOutcome: this.#ai ? 'succeeded' : 'not-required',
      pathsCreated: 0,
      pathsUpdated: 0,
      verified: 0,
      partiallyVerified: 0,
      supported: 0,
      speculative: 0,
      rejected: 0,
      expansions: stats.expansions,
      terminationReason: stats.terminationReason,
    }

    // AI proposals (optional), each turned into a candidate and validated the same way as a discovered path.
    const candidates: CandidatePath[] = [...deterministic]
    if (this.#ai && view.findings.length) {
      const proposal = await this.#propose(engagementId, view, options.signal)
      result.aiOutcome = proposal.outcome
      for (const p of proposal.proposals) {
        result.aiProposed++
        const ordered = p.findingIds.map((id) => view.findings.find((f) => f.id === id)).filter((f): f is SecurityFinding => !!f)
        if (ordered.length !== p.findingIds.length) {
          result.aiRejected++ // referenced an unknown or non-worthy finding
          continue
        }
        const chain = buildAiChain(ordered, p.connectingEntityKeys, view)
        if (!chain.ok) {
          result.aiRejected++ // cited nonexistent graph state
          continue
        }
        candidates.push(buildCandidatePath(ordered, chain.steps, 'ai-proposed'))
      }
    }

    const keyed = dedupeAndDominate(candidates)
    for (const path of keyed) {
      const validation = validatePath(path, view)
      if (!validation.ok) {
        result.rejected++
        await this.#event(engagementId, 'attack-path.rejected', `Attack path rejected: ${validation.rejectionReason}`, configVersion, actor, { pathKey: path.pathKey, reason: validation.rejectionReason }, 'warn')
        continue
      }
      const { created, state } = await this.#persist(engagementId, path, validation, configVersion, actor, options.signal)
      if (created) result.pathsCreated++
      else result.pathsUpdated++
      this.#tally(result, state)
    }

    this.#log?.info({ engagementId, ...result }, 'attack-path analysis complete')
    return result
  }

  // ── Loading ──────────────────────────────────────────────────────────────────────────────────────────

  async #loadView(engagementId: string, environment: string | null): Promise<AttackPathView> {
    const [findings, rows] = await Promise.all([listFindingsForEngagement(this.#db, engagementId), loadGraphRows(this.#db, engagementId)])
    const keyById = new Map(rows.nodes.map((n) => [n.id, n.key]))
    const nodes: SecurityGraphNode[] = rows.nodes.map(toGraphNode)
    const edges: SecurityGraphEdge[] = rows.edges.map((e) => toGraphEdge(e, keyById))
    const edgesByFrom = new Map<string, SecurityGraphEdge[]>()
    for (const e of edges) edgesByFrom.set(e.fromKey, [...(edgesByFrom.get(e.fromKey) ?? []), e])
    return {
      engagementId,
      environment,
      findings: findings.filter((f) => FINDING_WORTHY_STATES.includes(f.verificationState)),
      nodesByKey: new Map(nodes.map((n) => [n.key, n])),
      edges,
      edgesByFrom,
    }
  }

  // ── Persist (upsert by pathKey) ────────────────────────────────────────────────────────────────────────

  async #persist(engagementId: string, path: KeyedPath, validation: ReturnType<typeof validatePath>, configVersion: number, actor: SecurityActor, signal?: AbortSignal): Promise<{ created: boolean; state: string }> {
    const explanation = await this.#explain(engagementId, path, signal)
    const synth = synthesizePath({ path, validation, explanation, providerId: explanation ? 'ai' : null })
    const existing = await findAttackPathByKey(this.#db, engagementId, path.pathKey)
    const at = this.#now().toISOString()

    if (existing) {
      const transition: AttackPathTransition = { at, from: existing.state, to: synth.state, reason: synth.stateReason.slice(0, 400), actor: path.origin === 'ai-proposed' ? 'ai' : 'audivra' }
      const history = [...existing.history, transition].slice(-50)
      await updateAttackPath(this.#db, existing.id, {
        title: synth.title,
        purpose: synth.purpose,
        steps: synth.steps,
        affectedEntityKeys: synth.affectedEntityKeys,
        findingIds: synth.findingIds,
        comparisonIds: synth.comparisonIds,
        invariantRefs: synth.invariantRefs,
        confidence: synth.confidence,
        state: synth.state,
        stateReason: synth.stateReason,
        missingEvidence: synth.missingEvidence,
        impactClass: synth.impactClass,
        impactPriority: synth.impactPriority,
        boundariesCrossed: synth.boundariesCrossed,
        origin: synth.origin,
        providerId: synth.providerId,
        explanation: synth.explanation,
        dominatedBy: synth.dominatedBy,
        history,
      })
      await this.#event(engagementId, 'attack-path.updated', `Attack path updated: ${synth.title.slice(0, 120)} (${synth.state})`, configVersion, actor, { pathKey: path.pathKey, state: synth.state })
      if (synth.missingEvidence.length) await this.#event(engagementId, 'attack-path.evidence-gap', `Attack path has ${synth.missingEvidence.length} evidence gap(s)`, configVersion, actor, { pathKey: path.pathKey, gaps: synth.missingEvidence.length })
      return { created: false, state: synth.state }
    }

    const id = newAttackPathId()
    const history: AttackPathTransition[] = [{ at, from: null, to: synth.state, reason: `Discovered (${path.origin})`, actor: path.origin === 'ai-proposed' ? 'ai' : 'audivra' }]
    await insertAttackPath(this.#db, {
      id,
      engagementId,
      pathKey: synth.pathKey,
      title: synth.title,
      purpose: synth.purpose,
      start: synth.start,
      endImpact: synth.endImpact,
      steps: synth.steps,
      affectedEntityKeys: synth.affectedEntityKeys,
      findingIds: synth.findingIds,
      comparisonIds: synth.comparisonIds,
      invariantRefs: synth.invariantRefs,
      confidence: synth.confidence,
      state: synth.state,
      stateReason: synth.stateReason,
      missingEvidence: synth.missingEvidence,
      impactClass: synth.impactClass,
      impactPriority: synth.impactPriority,
      boundariesCrossed: synth.boundariesCrossed,
      origin: synth.origin,
      providerId: synth.providerId,
      explanation: synth.explanation,
      dominatedBy: synth.dominatedBy,
      history,
    })
    await this.#event(engagementId, 'attack-path.candidate-created', `Attack path: ${synth.title.slice(0, 120)} (${synth.state})`, configVersion, actor, { pathKey: path.pathKey, state: synth.state, impact: synth.impactClass })
    if (synth.state === 'verified' || synth.state === 'partially-verified') await this.#event(engagementId, 'attack-path.validated', `Attack path ${synth.state}: ${synth.title.slice(0, 120)}`, configVersion, actor, { pathKey: path.pathKey })
    if (synth.missingEvidence.length) await this.#event(engagementId, 'attack-path.evidence-gap', `Attack path has ${synth.missingEvidence.length} evidence gap(s)`, configVersion, actor, { pathKey: path.pathKey, gaps: synth.missingEvidence.length })
    return { created: true, state: synth.state }
  }

  // ── AI (optional; failure never corrupts deterministic analysis) ────────────────────────────────────────

  async #propose(engagementId: string, view: AttackPathView, signal?: AbortSignal): Promise<{ outcome: AttackPathResult['aiOutcome']; proposals: AttackPathProposalOutput['proposals'] }> {
    const task = ATTACK_PATH_TASKS.proposer
    const trusted = [
      jsonSection('findings', view.findings.map((f) => ({ id: f.id, title: f.title, category: f.category, impact: f.verificationState, affectedEntities: f.affectedEntities.map((e) => ({ key: e.key, kind: e.kind, label: e.label })) }))),
      jsonSection('graph entities', [...view.nodesByKey.values()].slice(0, 400).map((n) => ({ key: n.key, kind: n.kind, label: n.label }))),
      jsonSection('graph edges', view.edges.slice(0, 600).map((e) => ({ type: e.type, from: e.fromKey, to: e.toKey, basis: e.basis }))),
    ]
    try {
      const out = await this.#ai!.run({
        spec: task.spec,
        prompt: task.prompt,
        context: { trusted, untrusted: [] },
        instruction: 'Propose attack paths that correlate the listed findings into a greater impact. Reference ONLY the listed finding ids and graph entity keys; never invent any. Order each proposal by escalation. Return an empty list when no meaningful chain exists.',
        jsonSchema: attackPathJsonSchema('proposer'),
        engagementId,
        runId: `ap-${randomUUID().slice(0, 8)}`,
        signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs),
      })
      if (out.outcome !== 'succeeded') return { outcome: out.refused ? 'provider-refused' : out.outcome === 'provider-unavailable' ? 'provider-unavailable' : 'ai-output-invalid', proposals: [] }
      const parsed = AttackPathProposalOutput.safeParse(out.output)
      return parsed.success ? { outcome: 'succeeded', proposals: parsed.data.proposals } : { outcome: 'ai-output-invalid', proposals: [] }
    } catch (error) {
      this.#log?.warn({ engagementId, error: error instanceof Error ? error.message : String(error) }, 'attack-path AI proposal failed; deterministic paths only')
      return { outcome: 'provider-unavailable', proposals: [] }
    }
  }

  async #explain(engagementId: string, path: KeyedPath, signal?: AbortSignal): Promise<{ title: string; explanation: string } | null> {
    if (!this.#ai) return null
    const task = ATTACK_PATH_TASKS.explainer
    const trusted = [
      jsonSection('path', { start: path.start.label, end: path.end.label, impact: path.impactClass }),
      jsonSection('steps', path.steps.map((s) => ({ from: s.fromCondition, relationship: s.relationship, to: s.toCondition, verification: s.edgeVerification, boundary: s.boundaryCrossed }))),
    ]
    try {
      const out = await this.#ai.run({
        spec: task.spec,
        prompt: task.prompt,
        context: { trusted, untrusted: [] },
        instruction: 'Write a concise, accurate explanation of this attack path from its steps. Respect every verification label; never present an inferred or missing step as demonstrated. Add no facts beyond the steps.',
        jsonSchema: attackPathJsonSchema('explainer'),
        engagementId,
        runId: `apx-${randomUUID().slice(0, 8)}`,
        signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs),
      })
      if (out.outcome !== 'succeeded') return null
      const parsed = AttackPathExplanationOutput.safeParse(out.output)
      return parsed.success ? { title: parsed.data.title, explanation: parsed.data.explanation } : null
    } catch {
      return null
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────

  #tally(result: AttackPathResult, state: string): void {
    if (state === 'verified') result.verified++
    else if (state === 'partially-verified') result.partiallyVerified++
    else if (state === 'supported') result.supported++
    else if (state === 'speculative') result.speculative++
    else if (state === 'rejected') result.rejected++
  }

  async #event(engagementId: string, type: SecurityEventType, message: string, configVersion: number, actor: SecurityActor, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    await recordSecurityEvent(this.#db, { engagementId, type, message, level, actor, configVersion, data })
  }
}

// Re-export for callers that only want the read helper.
export { getAttackPathRow, toAttackPath }
