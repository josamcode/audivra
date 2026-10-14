import type { Logger } from '@audivra/config'
import type { CapabilityVersionRef, RetestAdaptation, RetestCase, SecurityActor, SecurityComparison } from '@audivra/contracts'
import {
  getEngagementRow,
  listDomainDeclarationRows,
  listSessionsForGraph,
  loadGraphRows,
  type Db,
} from '@audivra/database'
import type { ComparisonEngine } from '../comparison/engine.ts'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import { createDbSecurityStore, type SecurityStore } from '../store.ts'
import { LOCAL_USER } from '../service.ts'
import type { ReasoningAi } from '../reasoning/ai.ts'
import { applyAdaptation, proposeAdaptation, type AdaptationContext } from './adapt.ts'
import { blockerState, blockerToReason, evaluateRetestEligibility, type EligibilityContext } from './eligibility.ts'
import { classifyRetest, reevaluateChecks, type RetestClassification } from './classify.ts'

/*
 * Phase 6C — the retest executor. It replays a retest case against a target assessment by REUSING the normal
 * Audivra runtime: the frozen reproduction is run through the Phase 5 comparison engine (policy/readiness
 * validation → capability broker → durable execution → evidence → classification → cleanup), and the fresh
 * result is interpreted into a historical retest state. There is no bypass runtime and no new offensive
 * capability. A retest that cannot run is blocked/cannot-reproduce — never a fix.
 */

export interface RetestExecutorDeps {
  db: Db
  comparisonEngine: ComparisonEngine
  registry: CapabilityRegistry
  ai?: ReasoningAi
  store?: SecurityStore
  log?: Logger
}

export interface RetestExecution {
  state: RetestClassification['state']
  reason: string
  controlValid: boolean
  severityNow: RetestClassification['severityNow']
  fresh: SecurityComparison | null
  checkResults: ReturnType<typeof reevaluateChecks>
  executionIds: string[]
  identityRefs: string[]
  evidenceRefs: string[]
  capabilityVersions: CapabilityVersionRef[]
  adaptation: RetestAdaptation | null
}

export class RetestExecutor {
  readonly #db: Db
  readonly #engine: ComparisonEngine
  readonly #registry: CapabilityRegistry
  readonly #ai: ReasoningAi | undefined
  readonly #store: SecurityStore
  readonly #log: Logger | undefined

  constructor(deps: RetestExecutorDeps) {
    this.#db = deps.db
    this.#engine = deps.comparisonEngine
    this.#registry = deps.registry
    this.#ai = deps.ai
    this.#store = deps.store ?? createDbSecurityStore(deps.db)
    this.#log = deps.log
  }

  async run(testCase: RetestCase, targetEngagementId: string, options: { allowAdaptation?: boolean; actor?: SecurityActor; signal?: AbortSignal } = {}): Promise<RetestExecution> {
    const actor = options.actor ?? LOCAL_USER
    const blocked = (state: RetestExecution['state'], reason: string, adaptation: RetestAdaptation | null = null): RetestExecution => ({
      state,
      reason,
      controlValid: false,
      severityNow: null,
      fresh: null,
      checkResults: [],
      executionIds: [],
      identityRefs: [],
      evidenceRefs: [],
      capabilityVersions: this.#capabilityVersions(testCase),
      adaptation,
    })

    const ctx = await this.#eligibilityContext(targetEngagementId, testCase.engagementId)
    if (!ctx) return blocked('cannot-reproduce', 'The target assessment no longer exists')

    let repro = testCase.reproduction
    let adaptation: RetestAdaptation | null = null
    let eligibility = evaluateRetestEligibility(testCase, ctx)

    // If the replay cannot run because the app changed, try a single bounded, validated AI adaptation.
    if (!eligibility.eligible && options.allowAdaptation && repro && (eligibility.blocker === 'resource-missing' || eligibility.blocker === 'scope-excludes-target')) {
      const adaptCtx = await this.#adaptationContext(targetEngagementId)
      adaptation = await proposeAdaptation(this.#ai, targetEngagementId, repro, eligibility.reason, adaptCtx, options.signal)
      if (adaptation) {
        const newUrl = adaptation.before.startsWith('url') ? adaptation.after.replace(/^url\s+/, '') : null
        const newResourceRef = adaptation.before.startsWith('resource') ? adaptation.after.replace(/^resource\s+/, '') : null
        repro = applyAdaptation(repro, adaptation, newUrl, newResourceRef)
        // Re-check eligibility with the adapted plan (fresh declared-resource/scope set).
        const adapted = await this.#eligibilityContext(targetEngagementId, testCase.engagementId)
        eligibility = adapted ? evaluateRetestEligibility({ ...testCase, reproduction: repro }, adapted) : eligibility
      }
    }

    if (!eligibility.eligible) {
      const kind = eligibility.blocker!
      return blocked(blockerState(kind), blockerToReason(kind), adaptation)
    }
    if (!repro) return blocked('cannot-reproduce', 'No replayable reproduction', adaptation)

    // Replay through the normal comparison runtime (broker + durable execution + classification + cleanup).
    let fresh: SecurityComparison
    try {
      fresh = await this.#engine.planAndRun(targetEngagementId, repro, actor)
    } catch (error) {
      this.#log?.warn({ error: error instanceof Error ? error.message : String(error), retestCaseId: testCase.id }, 'retest replay failed')
      return blocked('blocked', `The replay could not complete: ${error instanceof Error ? error.message : 'error'}`, adaptation)
    }

    const classification = classifyRetest(fresh, testCase)
    const checkResults = reevaluateChecks(testCase.requiredChecks, fresh)
    return {
      ...classification,
      fresh,
      checkResults,
      executionIds: [...new Set(fresh.arms.map((a) => a.executionId).filter((id): id is string => !!id))],
      identityRefs: [...new Set(fresh.arms.map((a) => a.identityRef).filter((r): r is string => !!r))],
      evidenceRefs: fresh.evidenceRefs,
      capabilityVersions: this.#capabilityVersions(testCase),
      adaptation,
    }
  }

  /** Compute (without running) whether a case is replayable against a target assessment. */
  async eligibility(testCase: RetestCase, targetEngagementId: string): Promise<import('@audivra/contracts').RetestEligibility> {
    const ctx = await this.#eligibilityContext(targetEngagementId, testCase.engagementId)
    if (!ctx) return { eligible: false, blocker: 'resource-missing', reason: 'The target assessment no longer exists', capabilities: [] }
    return evaluateRetestEligibility(testCase, ctx)
  }

  #capabilityVersions(testCase: RetestCase): CapabilityVersionRef[] {
    return testCase.capabilityIds.map((capabilityId) => ({ capabilityId, version: this.#registry.get(capabilityId)?.metadata.version ?? 0 }))
  }

  async #eligibilityContext(targetEngagementId: string, sourceEngagementId: string): Promise<EligibilityContext | null> {
    const engagement = await getEngagementRow(this.#db, targetEngagementId)
    if (!engagement) return null
    const loaded = await this.#store.loadEngagement(targetEngagementId).catch(() => null)
    const authorized = !!loaded && loaded.authorizations.some((a) => a.status === 'verified' && (!a.expiresAt || new Date(a.expiresAt).getTime() > Date.now()))
    const [identities, resources, sessions] = await Promise.all([
      listDomainDeclarationRows(this.#db, targetEngagementId, { kind: 'identity' }),
      listDomainDeclarationRows(this.#db, targetEngagementId, { kind: 'resource' }),
      listSessionsForGraph(this.#db, targetEngagementId),
    ])
    const sourceEngagement = sourceEngagementId !== targetEngagementId ? await getEngagementRow(this.#db, sourceEngagementId).catch(() => null) : engagement
    return {
      environment: engagement.environment,
      scope: engagement.scope,
      declaredIdentityRefs: new Set(identities.map((d) => d.ref)),
      declaredResourceRefs: new Set(resources.map((d) => d.ref)),
      activeSessionIdentityRefs: new Set(sessions.filter((s) => s.status === 'active').map((s) => s.identityRef)),
      authorized,
      sourceEnvironment: sourceEngagement?.environment ?? engagement.environment,
      registry: this.#registry,
    }
  }

  async #adaptationContext(targetEngagementId: string): Promise<AdaptationContext> {
    const [rows, resources] = await Promise.all([loadGraphRows(this.#db, targetEngagementId), listDomainDeclarationRows(this.#db, targetEngagementId, { kind: 'resource' })])
    return { graphEntityKeys: new Set(rows.nodes.map((n) => n.key)), declaredResourceRefs: new Set(resources.map((d) => d.ref)) }
  }
}
