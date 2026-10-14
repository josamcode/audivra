import { randomUUID } from 'node:crypto'
import type { Logger } from '@audivra/config'
import {
  FindingProseOutput,
  FindingReviewOutput,
  FindingVerifierOutput,
  type CandidateTransition,
  type DomainDeclarationKind,
  type FindingTransition,
  type SecurityActor,
  type SecurityEventType,
  type Severity,
  type VerificationCheckResult,
  type VerificationState,
} from '@audivra/contracts'
import {
  findCandidateByIssueKey,
  findFindingByIssueKey,
  getCandidateRow,
  insertCandidate,
  insertFinding,
  listDomainDeclarationsForGraph,
  newCandidateId,
  newFindingId,
  recordSecurityEvent,
  toCandidate,
  updateCandidate,
  updateFinding,
  getEngagementRow,
  type Db,
} from '@audivra/database'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import type { GraphProjector } from '../graph/projector.ts'
import { loadKnowledge, type KnowledgeView } from '../reasoning/knowledge.ts'
import { jsonSection, type ReasoningAi } from '../reasoning/ai.ts'
import { LOCAL_USER } from '../service.ts'
import { generateCandidates, type DomainRefResolver, type GeneratedCandidate } from './candidates.ts'
import { evaluateCandidate } from './evaluate.ts'
import { resolveVerification, type VerifierResolution } from './engine.ts'
import { synthesizeFinding } from './synthesize.ts'
import { VERIFICATION_TASKS, verificationJsonSchema } from './ai.ts'

/*
 * Phase 6A — the verification boundary, as a service. It is the ONLY path from signals to findings:
 *   1. generate candidates from stored knowledge (deterministic),
 *   2. upsert each by its stable issueKey (advance, never duplicate),
 *   3. evaluate the machine-checkable requirements against stored state (AUDIVRA decides, not the AI),
 *   4. ask an INDEPENDENT verifier (optional) — a provider failure is `blocked`, never verified,
 *   5. synthesize a finding only for a settled, finding-worthy candidate, with deterministic severity and
 *      evidence-quality confidence; the AI writes prose and the reviewer may only make it more cautious,
 *   6. re-project the graph so verified/supported findings become finding nodes.
 * The deterministic path runs with no AI at all: complete candidates become `supported` (never `verified`),
 * because a scanner or a model alone can never make a verified finding.
 */

export interface VerificationServiceOptions {
  db: Db
  registry: CapabilityRegistry
  /** Optional independent verifier/prose/reviewer (the Phase 3C router, wired by the worker). */
  ai?: ReasoningAi
  /** Optional graph projector; when present, findings are projected after synthesis. */
  graphProjector?: GraphProjector
  now?: () => Date
  log?: Logger
}

export interface VerificationResult {
  candidatesGenerated: number
  candidatesCreated: number
  verified: number
  supported: number
  rejected: number
  inconclusive: number
  blocked: number
  needsEvidence: number
  findingsCreated: number
  findingsUpdated: number
  aiUsed: boolean
}

const FINDING_WORTHY = new Set<VerificationState>(['supported', 'verified'])

export class VerificationService {
  readonly #db: Db
  readonly #registry: CapabilityRegistry
  readonly #ai: ReasoningAi | undefined
  readonly #projector: GraphProjector | undefined
  readonly #now: () => Date
  readonly #log: Logger | undefined

  constructor(options: VerificationServiceOptions) {
    this.#db = options.db
    this.#registry = options.registry
    this.#ai = options.ai
    this.#projector = options.graphProjector
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  /** Runs the whole verification boundary for an engagement, idempotently. */
  async drive(engagementId: string, options: { actor?: SecurityActor; signal?: AbortSignal } = {}): Promise<VerificationResult> {
    const actor = options.actor ?? LOCAL_USER
    const engagement = await getEngagementRow(this.#db, engagementId)
    if (!engagement) throw new Error(`No security engagement ${engagementId}`)
    const configVersion = engagement.configVersion
    const view = await loadKnowledge(this.#db, engagementId, this.#registry)
    const resolve = await this.#resolver(engagementId)

    const generated = generateCandidates(view, resolve)
    const result: VerificationResult = { candidatesGenerated: generated.length, candidatesCreated: 0, verified: 0, supported: 0, rejected: 0, inconclusive: 0, blocked: 0, needsEvidence: 0, findingsCreated: 0, findingsUpdated: 0, aiUsed: false }

    let projectNeeded = false
    for (const gen of generated) {
      const { candidateId, created } = await this.#upsertCandidate(engagementId, gen, configVersion, actor)
      if (created) result.candidatesCreated++

      const outcome = evaluateCandidate(gen, view)
      const verifier = await this.#verify(engagementId, gen, outcome.disposition, options.signal)
      if (verifier.kind === 'ran') result.aiUsed = true
      const decision = resolveVerification(outcome, verifier)
      await this.#settleCandidate(engagementId, candidateId, gen, decision, outcome.results, verifier, configVersion, actor)
      this.#tally(result, decision.status)

      if (FINDING_WORTHY.has(decision.status)) {
        const { created: findingCreated } = await this.#synthesize(engagementId, candidateId, gen, outcome, decision, view, resolve, configVersion, actor, options.signal)
        if (findingCreated) result.findingsCreated++
        else result.findingsUpdated++
        projectNeeded = true
      } else {
        // A previously-worthy finding that regressed: mark it, don't silently keep it verified.
        const existing = await findFindingByIssueKey(this.#db, engagementId, gen.issueKey)
        if (existing && FINDING_WORTHY.has(existing.verificationState)) {
          await this.#demoteFinding(engagementId, existing.id, existing.verificationState, decision.status, decision.statusReason, configVersion, actor)
          result.findingsUpdated++
          projectNeeded = true
        }
      }
    }

    if (projectNeeded && this.#projector) await this.#projector.project(engagementId)
    this.#log?.info({ engagementId, ...result }, 'verification pass complete')
    return result
  }

  // ── Candidate upsert / settle ──────────────────────────────────────────────────────────────────────────

  async #resolver(engagementId: string): Promise<DomainRefResolver> {
    const declarations = await listDomainDeclarationsForGraph(this.#db, engagementId)
    const index = new Map(declarations.map((d) => [`${d.kind}|${d.ref}`, d.key]))
    return (kind: DomainDeclarationKind, ref: string) => index.get(`${kind}|${ref}`) ?? null
  }

  async #upsertCandidate(engagementId: string, gen: GeneratedCandidate, configVersion: number, actor: SecurityActor): Promise<{ candidateId: string; created: boolean }> {
    const existing = await findCandidateByIssueKey(this.#db, engagementId, gen.issueKey)
    const at = this.#now().toISOString()
    if (existing) {
      await updateCandidate(this.#db, existing.id, {
        claim: gen.claim,
        affectedEntityKeys: gen.affectedEntityKeys,
        supportingEvidenceRefs: gen.supportingEvidenceRefs,
        contradictingEvidenceRefs: gen.contradictingEvidenceRefs,
        requiredChecks: gen.requiredChecks,
      })
      if (JSON.stringify(existing.supportingEvidenceRefs) !== JSON.stringify(gen.supportingEvidenceRefs)) {
        await this.#event(engagementId, 'verification.evidence-added', `Candidate ${gen.issueKey} evidence updated`, configVersion, actor, { issueKey: gen.issueKey })
      }
      return { candidateId: existing.id, created: false }
    }
    const id = newCandidateId()
    const history: CandidateTransition[] = [{ at, from: null, to: 'unverified', reason: `Candidate created from ${gen.source.origin}`, actor: 'audivra' }]
    await insertCandidate(this.#db, {
      id,
      engagementId,
      issueKey: gen.issueKey,
      claim: gen.claim,
      category: gen.category,
      affectedEntityKeys: gen.affectedEntityKeys,
      supportingEvidenceRefs: gen.supportingEvidenceRefs,
      contradictingEvidenceRefs: gen.contradictingEvidenceRefs,
      source: gen.source,
      requiredChecks: gen.requiredChecks,
      status: 'unverified',
      statusReason: `Awaiting verification (${gen.source.origin})`,
      history,
    })
    await this.#event(engagementId, 'verification.candidate-created', `Verification candidate: ${gen.claim.slice(0, 140)}`, configVersion, actor, { issueKey: gen.issueKey, origin: gen.source.origin, category: gen.category })
    return { candidateId: id, created: true }
  }

  async #settleCandidate(
    engagementId: string,
    candidateId: string,
    gen: GeneratedCandidate,
    decision: ReturnType<typeof resolveVerification>,
    checkResults: VerificationCheckResult[],
    verifier: VerifierResolution,
    configVersion: number,
    actor: SecurityActor,
  ): Promise<void> {
    const rawRow = await getCandidateRow(this.#db, candidateId)
    const row = rawRow ? toCandidate(rawRow) : undefined
    const prev = row?.status ?? 'unverified'
    const at = this.#now().toISOString()
    const actorKind = verifier.kind === 'ran' ? ('ai' as const) : ('audivra' as const)
    const transition: CandidateTransition = { at, from: prev, to: decision.status, reason: decision.statusReason.slice(0, 600), actor: actorKind }
    const history: CandidateTransition[] = [...(row?.history ?? []), transition].slice(-50)
    await updateCandidate(this.#db, candidateId, {
      status: decision.status,
      statusReason: decision.statusReason,
      checkResults,
      verifier: { verdict: decision.verdict, note: verifier.kind === 'ran' ? verifier.output.rationale.slice(0, 600) : verifier.kind === 'failed' ? verifier.detail.slice(0, 600) : null, providerId: null },
      history,
    })
    const eventType = this.#statusEvent(decision.status)
    if (eventType) await this.#event(engagementId, eventType, `Candidate ${gen.issueKey} → ${decision.status}: ${decision.statusReason.slice(0, 160)}`, configVersion, actor, { issueKey: gen.issueKey, status: decision.status }, decision.status === 'blocked' ? 'warn' : 'info')
  }

  // ── Finding synthesis ────────────────────────────────────────────────────────────────────────────────

  async #synthesize(
    engagementId: string,
    candidateId: string,
    gen: GeneratedCandidate,
    outcome: ReturnType<typeof evaluateCandidate>,
    decision: ReturnType<typeof resolveVerification>,
    view: KnowledgeView,
    resolve: DomainRefResolver,
    configVersion: number,
    actor: SecurityActor,
    signal?: AbortSignal,
  ): Promise<{ created: boolean }> {
    // Synthesize the deterministic core first (so prose/review failures never block a finding).
    const base = synthesizeFinding({ candidate: gen, view, outcome, decision, prose: null })
    const prose = await this.#prose(engagementId, gen, base.severity, signal)
    const reviewer = await this.#review(engagementId, gen, base.severity, signal)
    const final = synthesizeFinding({ candidate: gen, view, outcome, decision, prose, reviewerSeverity: reviewer })

    const invariantKeys = gen.source.invariantRef ? [resolve('invariant', gen.source.invariantRef)].filter((k): k is string => !!k) : []
    const existing = await findFindingByIssueKey(this.#db, engagementId, gen.issueKey)
    const at = this.#now().toISOString()
    const status = final.verificationState === 'verified' ? 'verified' : 'open'

    if (existing) {
      const updateTransition: FindingTransition = { at, field: 'verificationState', from: existing.verificationState, to: final.verificationState, reason: decision.statusReason.slice(0, 400), actor: 'audivra' }
      const history: FindingTransition[] = [...existing.history, updateTransition].slice(-50)
      await updateFinding(this.#db, existing.id, {
        title: final.title,
        severity: final.severity,
        severityReason: final.severityReason,
        confidence: final.confidence,
        verificationState: final.verificationState,
        status,
        affectedEntities: final.affectedEntities,
        evidenceRefs: final.evidenceRefs,
        contradictingEvidenceRefs: final.contradictingEvidenceRefs,
        impact: final.impact,
        remediation: final.remediation,
        reproduction: final.reproduction,
        severityInputs: final.severityInputs,
        confidenceFactors: final.confidenceFactors,
        invariantRefs: invariantKeys,
        reviewed: reviewer !== undefined,
        history,
      })
      await updateCandidate(this.#db, candidateId, { findingId: existing.id })
      await this.#event(engagementId, 'finding.updated', `Finding updated: ${final.title.slice(0, 140)} (${final.severity}/${final.verificationState})`, configVersion, actor, { issueKey: gen.issueKey, severity: final.severity, verificationState: final.verificationState })
      return { created: false }
    }

    const id = newFindingId()
    const history: FindingTransition[] = [{ at, field: 'status', from: '', to: status, reason: `Synthesized from candidate (${final.verificationState})`, actor: 'audivra' }]
    await insertFinding(this.#db, {
      id,
      engagementId,
      issueKey: gen.issueKey,
      title: final.title,
      category: final.category,
      severity: final.severity,
      severityReason: final.severityReason,
      confidence: final.confidence,
      verificationState: final.verificationState,
      status,
      affectedEntities: final.affectedEntities,
      claim: final.claim,
      evidenceRefs: final.evidenceRefs,
      contradictingEvidenceRefs: final.contradictingEvidenceRefs,
      impact: final.impact,
      remediation: final.remediation,
      reproduction: final.reproduction,
      severityInputs: final.severityInputs,
      confidenceFactors: final.confidenceFactors,
      candidateIds: [candidateId],
      hypothesisIds: gen.source.hypothesisId ? [gen.source.hypothesisId] : [],
      comparisonIds: gen.source.comparisonId ? [gen.source.comparisonId] : [],
      invariantRefs: invariantKeys,
      reviewed: reviewer !== undefined,
      reviewNote: null,
      history,
    })
    await updateCandidate(this.#db, candidateId, { findingId: id })
    await this.#event(engagementId, 'finding.created', `Finding: ${final.title.slice(0, 140)} (${final.severity}/${final.verificationState})`, configVersion, actor, { issueKey: gen.issueKey, severity: final.severity, verificationState: final.verificationState })
    return { created: true }
  }

  async #demoteFinding(engagementId: string, findingId: string, from: VerificationState, to: VerificationState, reason: string, configVersion: number, actor: SecurityActor): Promise<void> {
    const at = this.#now().toISOString()
    const status = to === 'rejected' ? 'rejected' : 'open'
    await updateFinding(this.#db, findingId, { verificationState: to, status, history: [{ at, field: 'verificationState', from, to, reason: reason.slice(0, 400), actor: 'audivra' }] })
    await this.#event(engagementId, 'finding.updated', `Finding regressed: ${from} → ${to}`, configVersion, actor, { findingId, from, to })
  }

  // ── AI calls (all optional; a failure is handled, never fatal) ──────────────────────────────────────────

  async #verify(engagementId: string, gen: GeneratedCandidate, disposition: ReturnType<typeof evaluateCandidate>['disposition'], signal?: AbortSignal): Promise<VerifierResolution> {
    if (!this.#ai) return { kind: 'skipped' }
    // A contradicted/insufficient candidate is already settled deterministically; don't spend a verifier call.
    if (disposition === 'contradicted' || disposition === 'insufficient') return { kind: 'skipped' }
    const task = VERIFICATION_TASKS.verifier
    const trusted = [
      jsonSection('candidate', { issueKey: gen.issueKey, category: gen.category, claim: gen.claim, affectedEntities: gen.affectedEntityKeys, origin: gen.source.origin }),
      jsonSection('verification requirements', gen.requiredChecks),
      jsonSection('evidence refs', gen.supportingEvidenceRefs),
      jsonSection('contradicting evidence refs', gen.contradictingEvidenceRefs),
    ]
    try {
      const out = await this.#ai.run({
        spec: task.spec,
        prompt: task.prompt,
        context: { trusted, untrusted: [] },
        instruction:
          'Independently assess whether this is a REAL security finding, given only the evidence AUDIVRA verified. You cannot invent evidence or cite anything not listed. Return confirm ONLY when the evidence genuinely proves it; otherwise return disprove, alternative (a plausible benign explanation) or needs-evidence. When in doubt, do not confirm.',
        jsonSchema: verificationJsonSchema('verifier'),
        engagementId,
        runId: `verify-${randomUUID().slice(0, 8)}`,
        signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs),
      })
      if (out.outcome !== 'succeeded') {
        // No provider was even selected → verification was never attempted; fall back to the deterministic
        // floor (a `supported` finding), rather than blocking. A provider that WAS selected and then failed
        // is a genuine verification failure and blocks the candidate (never verified).
        if (out.selection.providerId === null) return { kind: 'skipped' }
        return { kind: 'failed', detail: out.refused ? 'provider refused' : out.outcome }
      }
      const parsed = FindingVerifierOutput.safeParse(out.output)
      if (!parsed.success) return { kind: 'failed', detail: 'verifier output invalid' }
      // Cited evidence must already exist on the candidate; silently drop anything else (never trust new refs).
      const known = new Set(gen.supportingEvidenceRefs)
      parsed.data.citedEvidenceRefs = parsed.data.citedEvidenceRefs.filter((r) => known.has(r))
      return { kind: 'ran', output: parsed.data }
    } catch (error) {
      this.#log?.warn({ engagementId, error: error instanceof Error ? error.message : String(error) }, 'verifier call failed; candidate blocked')
      return { kind: 'failed', detail: error instanceof Error ? error.message : 'verifier error' }
    }
  }

  async #prose(engagementId: string, gen: GeneratedCandidate, severity: Severity, signal?: AbortSignal): Promise<FindingProseOutput | null> {
    if (!this.#ai) return null
    const task = VERIFICATION_TASKS.prose
    const trusted = [jsonSection('finding', { category: gen.category, severity, claim: gen.claim, affectedEntities: gen.affectedEntityKeys })]
    try {
      const out = await this.#ai.run({
        spec: task.spec,
        prompt: task.prompt,
        context: { trusted, untrusted: [] },
        instruction: 'Write a concise title, impact and remediation for this finding. State ONLY facts present in the provided state. Do not change the severity or invent affected systems.',
        jsonSchema: verificationJsonSchema('prose'),
        engagementId,
        runId: `prose-${randomUUID().slice(0, 8)}`,
        signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs),
      })
      if (out.outcome !== 'succeeded') return null
      const parsed = FindingProseOutput.safeParse(out.output)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** Returns a reviewer-suggested severity (only ever lower; the engine clamps), or undefined when not run. */
  async #review(engagementId: string, gen: GeneratedCandidate, severity: Severity, signal?: AbortSignal): Promise<Severity | null | undefined> {
    if (!this.#ai) return undefined
    const task = VERIFICATION_TASKS.reviewer
    const trusted = [jsonSection('finding', { category: gen.category, severity, claim: gen.claim }), jsonSection('requirements', gen.requiredChecks)]
    try {
      const out = await this.#ai.run({
        spec: task.spec,
        prompt: task.prompt,
        context: { trusted, untrusted: [] },
        instruction: 'Review this finding. You may ONLY make it more cautious: suggest a lower severity if over-stated, or flag duplicate/needs-caution. Never strengthen it.',
        jsonSchema: verificationJsonSchema('reviewer'),
        engagementId,
        runId: `review-${randomUUID().slice(0, 8)}`,
        signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs),
      })
      if (out.outcome !== 'succeeded') return undefined
      const parsed = FindingReviewOutput.safeParse(out.output)
      if (!parsed.success) return undefined
      return parsed.data.suggestedSeverity
    } catch {
      return undefined
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────

  #tally(result: VerificationResult, status: VerificationState): void {
    if (status === 'verified') result.verified++
    else if (status === 'supported') result.supported++
    else if (status === 'rejected') result.rejected++
    else if (status === 'inconclusive') result.inconclusive++
    else if (status === 'blocked') result.blocked++
    else if (status === 'needs-evidence') result.needsEvidence++
  }

  #statusEvent(status: VerificationState): SecurityEventType | null {
    switch (status) {
      case 'supported':
        return 'verification.supported'
      case 'verified':
        return 'verification.verified'
      case 'rejected':
        return 'verification.rejected'
      case 'inconclusive':
        return 'verification.inconclusive'
      case 'blocked':
        return 'verification.blocked'
      default:
        return null
    }
  }

  async #event(engagementId: string, type: SecurityEventType, message: string, configVersion: number, actor: SecurityActor, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    await recordSecurityEvent(this.#db, { engagementId, type, message, level, actor, configVersion, data })
  }
}
