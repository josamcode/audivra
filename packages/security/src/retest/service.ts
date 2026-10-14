import type { Logger } from '@audivra/config'
import { FINDING_WORTHY_STATES, type RetestCase, type RetestResult, type RetestState, type SecurityActor, type SecurityEventType } from '@audivra/contracts'
import {
  findRetestCaseByFinding,
  getCandidateRow,
  getComparisonRow,
  getEngagementRow,
  getFindingRow,
  getRetestCaseRow,
  insertRetestCase,
  insertRetestResult,
  listFindingRows,
  listRetestResultsByIssueKey,
  newRetestCaseId,
  newRetestResultId,
  recordSecurityEvent,
  toCandidate,
  toComparison,
  toFinding,
  toRetestCase,
  toRetestResult,
  updateRetestCase,
  type Db,
} from '@audivra/database'
import type { ComparisonEngine } from '../comparison/engine.ts'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import type { ReasoningAi } from '../reasoning/ai.ts'
import { buildRetestCase } from './case.ts'
import { RetestExecutor } from './execute.ts'

/*
 * Phase 6C — the retest orchestration surface. It derives a structured retest case from a verified finding
 * (idempotent per finding), plans retests for a previous assessment, and drives one retest replay to a
 * persisted historical result. It reuses the 6A verification requirements and the Phase 5 comparison runtime
 * through the executor; it never asserts a fix without positive evidence, and it only ever relabels a
 * "present again" result as REGRESSED when the issue's own history shows a prior fix.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export interface RetestServiceOptions {
  db: Db
  comparisonEngine: ComparisonEngine
  registry: CapabilityRegistry
  ai?: ReasoningAi
  now?: () => Date
  log?: Logger
}

export class RetestService {
  readonly #db: Db
  readonly #executor: RetestExecutor
  readonly #now: () => Date
  readonly #log: Logger | undefined

  constructor(options: RetestServiceOptions) {
    this.#db = options.db
    this.#executor = new RetestExecutor({ db: options.db, comparisonEngine: options.comparisonEngine, registry: options.registry, ai: options.ai, log: options.log })
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  /** Derive (or refresh) the retest case for a verified/supported finding. Idempotent per (engagement, finding). */
  async ensureCase(findingId: string): Promise<RetestCase> {
    const findingRow = await getFindingRow(this.#db, findingId)
    if (!findingRow) throw new SecurityRequestError(404, `No finding ${findingId}`)
    const finding = toFinding(findingRow)
    if (!FINDING_WORTHY_STATES.includes(finding.verificationState)) throw new SecurityRequestError(409, `Finding ${findingId} is ${finding.verificationState}; only a supported/verified finding yields a retest case`)

    const candidateId = finding.candidateIds[0]
    const candidate = candidateId ? (await getCandidateRow(this.#db, candidateId).then((r) => (r ? toCandidate(r) : null))) : null
    const comparisonId = finding.reproduction?.comparisonId ?? finding.comparisonIds[0] ?? null
    const comparison = comparisonId ? await getComparisonRow(this.#db, comparisonId).then((r) => (r ? toComparison(r) : null)) : null

    const base = buildRetestCase({ id: newRetestCaseId(), finding, candidate, comparison })
    const existing = await findRetestCaseByFinding(this.#db, finding.engagementId, finding.id)
    const now = this.#now().toISOString()
    const probe: RetestCase = { ...base, eligibility: { eligible: true, blocker: null, reason: '', capabilities: [] }, createdAt: now, updatedAt: now }
    const eligibility = await this.#executor.eligibility(probe, finding.engagementId)

    if (existing) {
      await updateRetestCase(this.#db, existing.id, {
        title: base.title,
        reproductionFormat: base.reproductionFormat,
        reproduction: base.reproduction,
        requiredChecks: base.requiredChecks,
        controlsRequired: base.controlsRequired,
        capabilityIds: base.capabilityIds,
        eligibility,
      })
      return toRetestCase((await getRetestCaseRow(this.#db, existing.id))!)
    }
    const row = await insertRetestCase(this.#db, { ...base, eligibility })
    await this.#event(finding.engagementId, 'retest.case-created', `Retest case for "${finding.title.slice(0, 120)}" (${base.reproductionFormat})`, { findingId: finding.id, issueKey: finding.issueKey })
    return toRetestCase(row)
  }

  /** Build retest cases for the finding-worthy findings of a previous assessment (does not run them). */
  async planRetests(previousEngagementId: string, options: { eligibleOnly?: boolean } = {}): Promise<RetestCase[]> {
    const engagement = ENGAGEMENT_ID.test(previousEngagementId) ? await getEngagementRow(this.#db, previousEngagementId) : undefined
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    const findings = (await listFindingRows(this.#db, previousEngagementId)).map(toFinding).filter((f) => FINDING_WORTHY_STATES.includes(f.verificationState))
    const cases: RetestCase[] = []
    for (const finding of findings) {
      const testCase = await this.ensureCase(finding.id)
      if (options.eligibleOnly && !testCase.eligibility.eligible) continue
      if (!testCase.planned) await updateRetestCase(this.#db, testCase.id, { planned: true, plannedReason: `Planned for retest against a later assessment` })
      cases.push({ ...testCase, planned: true })
    }
    return cases
  }

  /** Run one retest replay and persist the historical result. Used by the worker and the E2E. */
  async runRetest(retestCaseId: string, targetEngagementId: string, options: { allowAdaptation?: boolean; actor?: SecurityActor; signal?: AbortSignal } = {}): Promise<RetestResult> {
    const caseRow = await getRetestCaseRow(this.#db, retestCaseId)
    if (!caseRow) throw new SecurityRequestError(404, `No retest case ${retestCaseId}`)
    const testCase = toRetestCase(caseRow)
    const target = ENGAGEMENT_ID.test(targetEngagementId) ? await getEngagementRow(this.#db, targetEngagementId) : undefined
    if (!target) throw new SecurityRequestError(404, 'Target engagement not found')

    const execution = await this.#executor.run(testCase, targetEngagementId, { allowAdaptation: options.allowAdaptation, actor: options.actor ?? LOCAL_USER, signal: options.signal })
    let state: RetestState = execution.state

    // Relabel "present again" as REGRESSED only when the issue's own history shows it was previously fixed.
    if (state === 'still-present') {
      const prior = await listRetestResultsByIssueKey(this.#db, testCase.issueKey)
      if (prior.some((r) => r.state === 'fixed')) state = 'regressed'
    }

    const id = newRetestResultId()
    const row = await insertRetestResult(this.#db, {
      id,
      engagementId: targetEngagementId,
      retestCaseId: testCase.id,
      findingId: testCase.findingId,
      issueKey: testCase.issueKey,
      sourceEngagementId: testCase.engagementId,
      state,
      reason: execution.reason,
      freshComparisonId: execution.fresh?.id ?? null,
      freshResult: execution.fresh?.result ?? null,
      controlValid: execution.controlValid,
      checkResults: execution.checkResults,
      executionIds: execution.executionIds,
      identityRefs: execution.identityRefs,
      evidenceRefs: execution.evidenceRefs,
      capabilityVersions: execution.capabilityVersions,
      adaptation: execution.adaptation,
      severityNow: execution.severityNow,
    })
    const event = this.#stateEvent(state)
    if (event) await this.#event(targetEngagementId, event, `Retest of "${testCase.title.slice(0, 120)}" → ${state}: ${execution.reason.slice(0, 160)}`, { retestCaseId: testCase.id, issueKey: testCase.issueKey, state, sourceEngagementId: testCase.engagementId }, state === 'fixed' || state === 'regressed' ? 'warn' : 'info')
    if (execution.adaptation) await this.#event(targetEngagementId, 'retest.adapted', `Retest adapted (${execution.adaptation.kind}): ${execution.adaptation.before} → ${execution.adaptation.after}`, { retestCaseId: testCase.id }, 'info')
    this.#log?.info({ retestCaseId: testCase.id, targetEngagementId, state }, 'retest replayed')
    return toRetestResult(row)
  }

  #stateEvent(state: RetestState): SecurityEventType | null {
    switch (state) {
      case 'still-present':
        return 'retest.still-present'
      case 'fixed':
        return 'retest.fixed'
      case 'regressed':
        return 'retest.regressed'
      case 'changed':
        return 'retest.changed'
      case 'cannot-reproduce':
        return 'retest.cannot-reproduce'
      case 'inconclusive':
        return 'retest.inconclusive'
      case 'blocked':
        return 'retest.blocked'
      default:
        return null
    }
  }

  async #event(engagementId: string, type: SecurityEventType, message: string, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    const engagement = await getEngagementRow(this.#db, engagementId)
    await recordSecurityEvent(this.#db, { engagementId, type, level, message, actor: LOCAL_USER, configVersion: engagement?.configVersion ?? 0, data })
  }
}
