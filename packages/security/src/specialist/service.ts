import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '@audivra/config'
import type { RequestSpecialistRunInput, SecurityActor, SpecialistArtifact, SpecialistAvailability, SpecialistCompletion, SpecialistEngineId, SpecialistMode, SpecialistRun, SpecialistRunState } from '@audivra/contracts'
import { SPECIALIST_LIVE_MODES } from '@audivra/contracts'
import {
  enqueueSecurityVerification,
  getEngagementRow,
  getSpecialistRunRow,
  insertSpecialistRun,
  listNonTerminalSpecialistRuns,
  newId,
  newSpecialistRunId,
  TERMINAL_SPECIALIST_STATES,
  toSpecialistRun,
  updateSpecialistRun,
  type Db,
  type PgBoss,
} from '@audivra/database'
import { dockerVersion, killOwnedForExecution, reapStaleProcessesForExecution } from '@audivra/tool-runtime'
import { engagementWorkspaceDir } from '@audivra/config'
import { ExecutionWorkspace } from '../execution/workspace.ts'
import { GraphProjector } from '../graph/projector.ts'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import { createDbSecurityStore, type SecurityStore } from '../store.ts'
import { SPECIALIST_ADAPTER_VERSION, budgetFor, liveContainmentProven, specialistEnabled, strixProviderProfile, strixVersionPin } from './config.ts'
import type { SpecialistEngine } from './engine.ts'
import { ingestSpecialistArtifact } from './ingest.ts'
import { buildSpecialistTargets, inScopeTargets } from './targets.ts'
import { SPECIALIST_CAPABILITY_ID } from './capability.ts'

/*
 * Phase 6D — orchestrates a durable specialist run. Authority is Audivra's: the target set is built from
 * trusted state and authorized through the broker; environment/mode eligibility fails closed (production is
 * disabled; live modes need a proven containment spike). The engine runs as an Audivra-owned execution
 * (workspace + process ownership + cancellation + timeout); its structured artifact is stored as bounded
 * evidence and normalized into observations. It never writes a verified finding — ingestion only creates
 * observations/signals, and the existing 6A pipeline (re-run afterwards) decides candidates and findings.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export interface SpecialistRunServiceOptions {
  db: Db
  /** A broker (durable) used ONLY for its authority decision (preflight); the engine is not run through it. */
  broker: { preflight(request: unknown): Promise<import('@audivra/contracts').PolicyDecision> }
  engines: Partial<Record<SpecialistEngineId, SpecialistEngine>>
  boss?: PgBoss
  store?: SecurityStore
  graphProjector?: GraphProjector
  workspaceRoot?: (engagementId: string) => string
  now?: () => Date
  log?: Logger
}

export class SpecialistRunService {
  readonly #db: Db
  readonly #broker: SpecialistRunServiceOptions['broker']
  readonly #engines: SpecialistRunServiceOptions['engines']
  readonly #boss: PgBoss | undefined
  readonly #store: SecurityStore
  readonly #projector: GraphProjector
  readonly #workspaceRoot: (engagementId: string) => string
  readonly #now: () => Date
  readonly #log: Logger | undefined

  constructor(options: SpecialistRunServiceOptions) {
    this.#db = options.db
    this.#broker = options.broker
    this.#engines = options.engines
    this.#boss = options.boss
    this.#store = options.store ?? createDbSecurityStore(options.db)
    this.#projector = options.graphProjector ?? new GraphProjector({ db: options.db, log: options.log })
    this.#workspaceRoot = options.workspaceRoot ?? engagementWorkspaceDir
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  /** Current availability + the modes Audivra will permit (source-only safe; live needs a proven spike). */
  async availability(engine: SpecialistEngineId = 'strix'): Promise<SpecialistAvailability> {
    const impl = this.#engines[engine]
    const pin = strixVersionPin()
    const provider = strixProviderProfile()
    if (!specialistEnabled() && !impl?.id) {
      return { engine, state: 'disabled', installedVersion: null, pin, dockerAvailable: false, providerConfigured: provider.configured, enabledModes: [], reason: 'The specialist engine is disabled (set STRIX_ENABLED to enable).', checkedAt: this.#now().toISOString() }
    }
    if (!impl) return { engine, state: 'missing', installedVersion: null, pin, dockerAvailable: false, providerConfigured: false, enabledModes: [], reason: 'No engine adapter is registered.', checkedAt: this.#now().toISOString() }
    const dockerAvailable = await dockerVersion().then((v) => !!v).catch(() => false)
    const availability = await impl.availability({ pin, providerConfigured: provider.configured, dockerAvailable })
    // Audivra gates modes: source-only is the safe default; live modes require a proven containment spike.
    const enabledModes = availability.state === 'ready' ? (liveContainmentProven() ? availability.enabledModes.length ? availability.enabledModes : (['source-only'] as SpecialistMode[]) : (['source-only'] as SpecialistMode[])) : []
    const live = liveContainmentProven() ? ([...enabledModes, 'local-controlled-web', 'authorized-staging'] as SpecialistMode[]) : enabledModes
    return { ...availability, enabledModes: availability.state === 'ready' ? [...new Set(live)] : [] }
  }

  /** Create a durable specialist run and (when a queue is wired) enqueue it to the worker. */
  async request(engagementId: string, input: RequestSpecialistRunInput, actor: SecurityActor = LOCAL_USER): Promise<SpecialistRun> {
    const engagement = ENGAGEMENT_ID.test(engagementId) ? await getEngagementRow(this.#db, engagementId) : undefined
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    const mode = input.mode
    const targets = await buildSpecialistTargets(this.#db, engagementId, engagement.scope, input, mode)
    const provider = strixProviderProfile()
    const run = await insertSpecialistRun(this.#db, {
      id: newSpecialistRunId(),
      engagementId,
      engine: input.engine,
      adapterVersion: SPECIALIST_ADAPTER_VERSION,
      mode,
      executionId: newId('sx'),
      targets,
      providerProfileId: provider.id,
      providerModel: provider.model,
      state: 'requested',
      stateReason: 'Specialist run requested; awaiting the worker.',
    })
    await this.#event(engagementId, engagement.configVersion, 'specialist.requested', `Specialist run requested (${input.engine}, ${mode}, ${inScopeTargets(targets).length} in-scope target(s))`, actor, { runId: run.id, mode })
    if (this.#boss) {
      const { enqueueSecuritySpecialist } = await import('@audivra/database')
      await enqueueSecuritySpecialist(this.#boss, run.id)
    }
    return toSpecialistRun(run)
  }

  /** Drive one specialist run end to end. Idempotent: a terminal run returns unchanged. */
  async drive(runId: string, options: { actor?: SecurityActor; signal?: AbortSignal } = {}): Promise<SpecialistRun> {
    const actor = options.actor ?? LOCAL_USER
    const row = await getSpecialistRunRow(this.#db, runId)
    if (!row) throw new SecurityRequestError(404, `No specialist run ${runId}`)
    let run = toSpecialistRun(row)
    if (TERMINAL_SPECIALIST_STATES.includes(run.state)) return run
    const engagement = await getEngagementRow(this.#db, run.engagementId)
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    const configVersion = engagement.configVersion

    // 1. Availability + environment/mode eligibility — a missing/unconfigured engine degrades gracefully.
    const availability = await this.availability(run.engine)
    const engine = this.#engines[run.engine]
    const environment = engagement.environment
    const eligibility = this.#modeEligible(run.mode, environment, availability)
    if (!engine || !eligibility.ok) {
      return this.#finalizeUnavailable(run, configVersion, actor, eligibility.reason || availability.reason)
    }

    // 2. Authority — the target set is authorized through Audivra's broker (scope + authorization + policy).
    const targets = inScopeTargets(run.targets)
    const decision = await this.#broker.preflight({ engagementId: run.engagementId, capabilityId: SPECIALIST_CAPABILITY_ID, input: { targets: targets.filter((t) => t.kind === 'url').map((t) => t.value), mode: run.mode }, actor })
    if (decision.decision === 'deny') {
      return this.#finalizeUnavailable(run, configVersion, actor, `Authorization denied: ${decision.reason}`)
    }
    if (run.mode === 'source-only' && !run.targets.some((t) => t.kind === 'staged-source') && targets.length === 0) {
      return this.#finalizeUnavailable(run, configVersion, actor, 'No in-scope target or staged source to research.')
    }

    // 3. Prepare the execution-owned workspace and run the engine (owned subprocess, cancellable, bounded).
    const executionId = run.executionId!
    const workspace = new ExecutionWorkspace(this.#workspaceRoot(run.engagementId), executionId)
    await workspace.init()
    run = toSpecialistRun((await updateSpecialistRun(this.#db, run.id, { state: 'running', stateReason: 'Running the specialist engine.', startedAt: this.#now() }))!)
    await this.#event(run.engagementId, configVersion, 'specialist.started', `Specialist run started (${run.engine}, ${run.mode})`, actor, { runId: run.id })

    const budget = budgetFor(run.mode, environment)
    const timeout = AbortSignal.timeout(budget.wallClockMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let artifact: SpecialistArtifact
    try {
      artifact = await engine.run({ engagementId: run.engagementId, executionId, config: { engine: run.engine, mode: run.mode, targets: run.targets, budget, providerProfileId: run.providerProfileId, executionNetwork: null, stagedSourceRef: run.targets.find((t) => t.kind === 'staged-source')?.value ?? null }, workspaceDir: workspace.area('artifacts'), signal, log: this.#log })
    } catch (error) {
      await killOwnedForExecution(executionId).catch(() => undefined)
      await engine.cleanup({ engagementId: run.engagementId, executionId, workspaceDir: workspace.area('artifacts'), config: { engine: run.engine, mode: run.mode, targets: run.targets, budget, providerProfileId: run.providerProfileId, executionNetwork: null, stagedSourceRef: null }, log: this.#log }).catch(() => undefined)
      const cancelled = signal.aborted && (options.signal?.aborted ?? false)
      return this.#finalizeTerminal(run, cancelled ? 'cancelled' : 'failed', cancelled ? 'cancelled' : 'failed', configVersion, actor, error instanceof Error ? error.message : 'engine error')
    }

    // 4. Store the structured artifact as bounded evidence (raw external-tool output).
    run = toSpecialistRun((await updateSpecialistRun(this.#db, run.id, { state: 'collecting', stateReason: 'Collecting and ingesting artifacts.', engineVersion: artifact.engineVersion }))!)
    const evidenceRef = await this.#storeArtifact(run, engagement, workspace, artifact).catch(() => null)

    // 5. Normalize into observations (never findings). Out-of-scope results dropped; corroboration via 6A.
    const ingest = await ingestSpecialistArtifact(this.#db, run.engagementId, executionId, engagement.scope, artifact, evidenceRef)
    for (const imp of ingest.imports) {
      if (imp.action === 'observation-created' || imp.action === 'merged-existing') await this.#event(run.engagementId, configVersion, imp.action === 'merged-existing' ? 'specialist.merged-existing' : 'specialist.signal-created', `Specialist signal: ${imp.title.slice(0, 120)}`, actor, { runId: run.id, nativeId: imp.nativeId })
      else if (imp.action === 'out-of-scope-dropped') await this.#event(run.engagementId, configVersion, 'specialist.out-of-scope-dropped', `Dropped out-of-scope specialist result: ${imp.title.slice(0, 120)}`, actor, { runId: run.id }, 'warn')
    }
    await this.#event(run.engagementId, configVersion, 'specialist.artifact-imported', `Imported ${ingest.counts.vulnerabilities} specialist result(s): ${ingest.counts.observations} new, ${ingest.counts.merged} corroborating, ${ingest.counts.gaps} gap(s), ${ingest.counts.outOfScope} out-of-scope`, actor, { runId: run.id, ...ingest.counts })

    // 6. Re-project the graph and run the verification boundary (6A) — Strix signals never bypass it.
    await this.#projector.project(run.engagementId).catch((error) => this.#log?.warn({ error: error instanceof Error ? error.message : String(error) }, 'graph projection after specialist run failed'))
    if (this.#boss) await enqueueSecurityVerification(this.#boss, run.engagementId)

    await engine.cleanup({ engagementId: run.engagementId, executionId, workspaceDir: workspace.area('artifacts'), config: { engine: run.engine, mode: run.mode, targets: run.targets, budget, providerProfileId: run.providerProfileId, executionNetwork: null, stagedSourceRef: null }, log: this.#log }).catch(() => undefined)
    await workspace.cleanup().catch(() => undefined)

    const state = this.#completionToState(artifact.completion)
    const patched = await updateSpecialistRun(this.#db, run.id, {
      state,
      completion: artifact.completion,
      stateReason: artifact.coverageNote,
      finishedAt: this.#now(),
      terminationReason: artifact.completion === 'completed' ? null : artifact.completion,
      artifactRefs: evidenceRef ? [evidenceRef] : [],
      costUsd: artifact.providerMeta.costUsd,
      turns: artifact.providerMeta.turns,
      imported: ingest.counts,
      imports: ingest.imports,
    })
    await this.#event(run.engagementId, configVersion, artifact.completion === 'completed' ? 'specialist.completed' : 'specialist.partial', `Specialist run ${artifact.completion}: ${ingest.counts.observations + ingest.counts.merged} signal(s)`, actor, { runId: run.id, completion: artifact.completion }, artifact.completion === 'completed' ? 'info' : 'warn')
    this.#log?.info({ runId: run.id, state, completion: artifact.completion, ...ingest.counts }, 'specialist run driven')
    return toSpecialistRun(patched!)
  }

  /** Cancel a run: stop its owned subprocess/sandbox and mark it cancelled. */
  async cancel(runId: string, actor: SecurityActor = LOCAL_USER): Promise<SpecialistRun> {
    const row = await getSpecialistRunRow(this.#db, runId)
    if (!row) throw new SecurityRequestError(404, `No specialist run ${runId}`)
    const run = toSpecialistRun(row)
    if (TERMINAL_SPECIALIST_STATES.includes(run.state)) return run
    if (run.executionId) {
      await killOwnedForExecution(run.executionId).catch(() => undefined)
      await this.#engines[run.engine]?.cleanup({ engagementId: run.engagementId, executionId: run.executionId, workspaceDir: new ExecutionWorkspace(this.#workspaceRoot(run.engagementId), run.executionId).area('artifacts'), config: { engine: run.engine, mode: run.mode, targets: run.targets, budget: budgetFor(run.mode, null), providerProfileId: run.providerProfileId, executionNetwork: null, stagedSourceRef: null } }).catch(() => undefined)
    }
    const engagement = await getEngagementRow(this.#db, run.engagementId)
    return this.#finalizeTerminal(run, 'cancelled', 'cancelled', engagement?.configVersion ?? 0, actor, 'Cancelled by request')
  }

  /** Reconcile non-terminal runs after a worker restart: never re-run finished work; ingest at most once. */
  async recover(): Promise<{ reconciled: number }> {
    const runs = await listNonTerminalSpecialistRuns(this.#db)
    let reconciled = 0
    for (const run of runs) {
      if (run.executionId) await reapStaleProcessesForExecution(run.executionId).catch(() => undefined)
      // A run left mid-flight is marked failed (interrupted); a completed-but-uningested artifact is rare
      // because ingestion and completion are written together — we never re-run the external engine here.
      await updateSpecialistRun(this.#db, run.id, { state: 'failed', completion: 'failed', stateReason: 'Interrupted by a worker restart; not re-run.', finishedAt: this.#now(), terminationReason: 'interrupted' })
      reconciled++
    }
    return { reconciled }
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  #modeEligible(mode: SpecialistMode, environment: string | null, availability: SpecialistAvailability): { ok: boolean; reason: string } {
    if (availability.state !== 'ready') return { ok: false, reason: availability.reason }
    if (environment === 'production') return { ok: false, reason: 'Specialist runs are disabled in production (Phase 6D).' }
    if (SPECIALIST_LIVE_MODES.includes(mode) && !liveContainmentProven()) return { ok: false, reason: 'Live-target specialist modes require a proven containment spike (fail-closed); only source-only is enabled.' }
    if (!availability.enabledModes.includes(mode)) return { ok: false, reason: `Mode ${mode} is not enabled.` }
    return { ok: true, reason: '' }
  }

  #completionToState(completion: SpecialistCompletion): SpecialistRunState {
    switch (completion) {
      case 'completed':
        return 'completed'
      case 'partial':
        return 'partial'
      case 'budget-stopped':
        return 'budget-stopped'
      case 'cancelled':
        return 'cancelled'
      case 'provider-unavailable':
        return 'unavailable'
      default:
        return 'failed'
    }
  }

  async #storeArtifact(run: SpecialistRun, engagement: NonNullable<Awaited<ReturnType<typeof getEngagementRow>>>, workspace: ExecutionWorkspace, artifact: SpecialistArtifact): Promise<string | null> {
    const MAX = 32 * 1_048_576
    const body = JSON.stringify(artifact, null, 2).slice(0, MAX)
    const file = path.join(workspace.area('artifacts'), 'specialist-artifact.json')
    await writeFile(file, body, 'utf8')
    const artifactPath = workspace.relative(file)
    if (!artifactPath) return null
    const evidence = await this.#store.recordEvidence({
      engagementId: run.engagementId,
      source: 'system',
      type: 'tool-result',
      title: `Strix specialist artifact (${artifact.completion})`.slice(0, 200),
      summary: `Structured ${run.engine} artifact: ${artifact.vulnerabilities.length} native result(s), completion ${artifact.completion}. Untrusted external-tool output.`,
      artifactPath,
      metadata: { engine: run.engine, engineVersion: artifact.engineVersion, completion: artifact.completion, results: artifact.vulnerabilities.length },
      provenance: {
        engagementId: run.engagementId,
        executionId: run.executionId!,
        correlationId: run.id,
        capabilityId: SPECIALIST_CAPABILITY_ID,
        capabilityVersion: 1,
        implementation: 'builtin/specialist-strix@1',
        decisionEventId: null,
        environment: engagement.environment ?? 'production',
        scopeVersion: engagement.scopeVersion,
        scopeHash: engagement.scopeHash,
        configVersion: engagement.configVersion,
        policyProfile: { key: engagement.policyProfileKey, version: engagement.policyProfileVersion },
        authorizationIds: [],
        sensitivity: 'normal',
        identityRef: null,
        sessionRef: null,
      },
    })
    return evidence.ref
  }

  async #finalizeUnavailable(run: SpecialistRun, configVersion: number, actor: SecurityActor, reason: string): Promise<SpecialistRun> {
    const patched = await updateSpecialistRun(this.#db, run.id, { state: 'unavailable', completion: 'provider-unavailable', stateReason: reason, finishedAt: this.#now(), terminationReason: 'unavailable' })
    await this.#event(run.engagementId, configVersion, 'specialist.unavailable', `Specialist run unavailable: ${reason}`, actor, { runId: run.id }, 'warn')
    return toSpecialistRun(patched!)
  }

  async #finalizeTerminal(run: SpecialistRun, state: SpecialistRunState, completion: SpecialistCompletion, configVersion: number, actor: SecurityActor, reason: string): Promise<SpecialistRun> {
    const patched = await updateSpecialistRun(this.#db, run.id, { state, completion, stateReason: reason, finishedAt: this.#now(), terminationReason: completion })
    await this.#event(run.engagementId, configVersion, state === 'cancelled' ? 'specialist.cancelled' : 'specialist.failed', `Specialist run ${state}: ${reason}`, actor, { runId: run.id }, 'warn')
    return toSpecialistRun(patched!)
  }

  async #event(engagementId: string, configVersion: number, type: import('@audivra/contracts').SecurityEventType, message: string, actor: SecurityActor, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    await this.#store.recordEvent({ engagementId, type, level, message, actor, configVersion, data })
  }
}
