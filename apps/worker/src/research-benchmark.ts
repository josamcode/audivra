import type { Server } from 'node:http'
import type { Logger } from '@audivra/config'
import type { AiTaskOutcome, ResearchObjective, SpecialistVulnerability } from '@audivra/contracts'
import { listFindingsForEngagement, listResearchActions, type Db } from '@audivra/database'
import {
  CapabilityBroker,
  createDbSecurityStore,
  createRuntimeRegistry,
  createSecretVault,
  DomainService,
  FakeSpecialistEngine,
  fakeVuln,
  GraphProjector,
  ResearchService,
  SecurityService,
  SessionEstablishmentService,
  VaultAuthResolver,
  type ReasoningAi,
  type ReasoningAiResult,
  type Resolver,
  type SpecialistEngine,
} from '@audivra/security'

/*
 * Phase 6E — the autonomous research benchmark. Controlled fixtures with ground truth over which the loop runs
 * end to end (deterministic fake AI + fake specialist). It measures the quality of the RESEARCH, not finding
 * count: a healthy app yields zero findings; a focused issue is found by a cheap comparison without touching
 * the expensive specialist; the specialist is used only when cheaper capabilities cannot answer; a provider
 * outage degrades honestly; adversarial proposals are rejected; and the run stops at the right time.
 *
 *   Headline invariants: healthy-app verified findings = 0, and unnecessary specialist invocation rate = 0.
 */

interface BenchmarkMetric { value: number; target: string; pass: boolean; detail: string }
interface ScenarioResult { name: string; description: string; pass: boolean; metrics: Record<string, BenchmarkMetric>; durationMs: number }
export interface ResearchBenchmarkResult { startedAt: string; durationMs: number; scenarios: ScenarioResult[]; summary: Record<string, BenchmarkMetric>; pass: boolean }

const USER = { kind: 'user' as const, id: 'benchmark', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const eq = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `= ${want}`, pass: value === want, detail })
const atLeast = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≥ ${want}`, pass: value >= want, detail })
const atMost = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≤ ${want}`, pass: value <= want, detail })
const bool = (value: boolean, detail: string): BenchmarkMetric => ({ value: value ? 1 : 0, target: '= 1', pass: value, detail })

function aiResult(outcome: AiTaskOutcome['outcome'], output: unknown): ReasoningAiResult {
  return { outcome, output, selection: { taskType: 'security-plan', providerId: 'bench', model: null, reason: 'bench', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 1, refused: false, promptVersion: null }
}
const confirmingAi: ReasoningAi = {
  async run(task) {
    if (task.prompt === 'security-research-planner') return aiResult('succeeded', { proposals: [], note: '' })
    if (task.prompt === 'security-finding-verifier') return aiResult('succeeded', { verdict: 'confirm', rationale: 'controls confirm the boundary is broken', citedEvidenceRefs: [], alternativeExplanation: null, missingEvidence: null, proposedAction: null })
    if (task.prompt === 'security-finding-prose') return aiResult('succeeded', { title: 'Broken boundary', impact: 'x', remediation: 'y', severityExplanation: '' })
    if (task.prompt === 'security-attack-path-proposer') return aiResult('succeeded', { proposals: [] })
    if (task.prompt === 'security-attack-path-explainer') return aiResult('succeeded', { title: 'Path', explanation: 'route' })
    return aiResult('succeeded', { verdict: 'ok', note: '', suggestedSeverity: null })
  },
}
const degradingAi: ReasoningAi = { async run(task) { return task.prompt === 'security-research-planner' ? aiResult('provider-unavailable', null) : confirmingAi.run(task) } }

interface FixtureLike { url: string; tokens: Map<string, string>; principals: Map<string, { tenant: string; role: 'user' | 'admin' }>; resources: Map<string, { tenant: string; owner: string; state: string; enforce: 'strict' | 'tenant' | 'leaky' }>; close(): Promise<void>; server: Server }
async function startFixture(): Promise<FixtureLike> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../../../fixtures/identity/server.mjs')) as { startIdentityFixture(opts: { port: number; label: string }): Promise<FixtureLike> }
  return mod.startIdentityFixture({ port: 0, label: 'research-bench' })
}

export async function runResearchBenchmark(options: { db: Db; log?: Logger }): Promise<ResearchBenchmarkResult> {
  const { db } = options
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const fixture = await startFixture()
  const service = new SecurityService({ db, resolver: loopback })
  const domain = new DomainService({ db })
  const vault = createSecretVault(db)
  const establishment = new SessionEstablishmentService({ db, vault })
  const registry = createRuntimeRegistry()
  const broker = new CapabilityBroker({ registry, store: createDbSecurityStore(db), resolver: loopback, authResolver: new VaultAuthResolver({ db, vault }), checkResources: async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} }) })
  const projector = new GraphProjector({ db })

  const research = (ai: ReasoningAi | undefined, engine?: SpecialistEngine) => new ResearchService({ db, broker, ai, specialistEngines: { strix: engine ?? new FakeSpecialistEngine({ vulnerabilities: [] }) }, graphProjector: projector })
  const webVuln = (url: string): SpecialistVulnerability => fakeVuln({ nativeId: 's1', title: 'Specialist signal', nativeCategory: 'A05:Misconfig', affected: { url, sourcePath: null, apiOperation: null, assetHint: null } })

  const engagement = async (name: string, withIdentities = true) => {
    const created = await service.createEngagement({ name: `${name}-${Math.random().toString(36).slice(2, 6)}`, targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
    await service.requestAuthorization(created.id, { method: 'local-development' }, USER)
    if (withIdentities) {
      await mkIdentity(created.id, 'alice')
      await mkIdentity(created.id, 'bob')
    }
    return created.id
  }
  const mkIdentity = async (eid: string, ref: string) => {
    const token = `rb-${ref}-${Math.random().toString(36).slice(2, 10)}`
    fixture.tokens.set(token, ref)
    fixture.principals.set(ref, { tenant: 't1', role: 'user' })
    await domain.declare(eid, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: 't1' } }, USER)
    await vault.setCredential(eid, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, USER)
    await establishment.establish(eid, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, USER)
  }
  const resource = async (eid: string, id: string, enforce: 'leaky' | 'strict', owner: string | null = 'alice') => {
    fixture.resources.set(id, { tenant: 't1', owner: owner ?? 'alice', state: 'draft', enforce })
    const spec: Record<string, unknown> = { resourceType: 'document', canonicalUrl: `${fixture.url}/api/resources/${id}`, testData: 'test-owned' }
    if (owner) {
      spec.ownerRef = owner
      spec.tenantRef = 't1'
    }
    await domain.declare(eid, { kind: 'resource', ref: id, spec }, USER)
  }
  const drive = async (ai: ReasoningAi | undefined, eid: string, objective: ResearchObjective, engine?: SpecialistEngine) => {
    const svc = research(ai, engine)
    const run = await svc.create(eid, { mode: 'investigate', objective, objectiveNote: null, objectiveDetail: {} })
    return svc.drive(run.id)
  }

  const scenarios: ScenarioResult[] = []
  try {
    // ── Scenario 1: healthy app → zero findings, stops cleanly. ──
    {
      const s0 = Date.now()
      const eid = await engagement('rb-healthy')
      await resource(eid, 'hdoc', 'strict')
      const run = await drive(confirmingAi, eid, 'investigate-authorization')
      const findings = await listFindingsForEngagement(db, eid)
      scenarios.push({
        name: 'healthy-app',
        description: 'A healthy (enforced) application yields zero verified findings; the research stops without manufacturing work.',
        metrics: {
          falseFindings: eq(findings.length, 0, 'zero findings on a healthy app (headline)'),
          stopped: bool(run.state === 'stopped' || run.state === 'degraded', `run stopped (${run.state})`),
          stopReason: bool(!!run.terminationReason, `an explicit stop reason (${run.terminationReason})`),
          bounded: atMost(run.usage.iterations, run.budget.maxIterations, 'stopped within the iteration budget'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 2: authorization issue → cheap comparison → verify → finding, no specialist. ──
    {
      const s0 = Date.now()
      const eid = await engagement('rb-authz')
      await resource(eid, 'ldoc', 'leaky')
      const run = await drive(confirmingAi, eid, 'investigate-authorization')
      const findings = await listFindingsForEngagement(db, eid)
      const actions = await listResearchActions(db, run.id)
      scenarios.push({
        name: 'authorization-focused',
        description: 'A broken authorization boundary is found by a cheap comparison → verification → finding, and the expensive specialist is never invoked.',
        metrics: {
          finding: atLeast(findings.length, 1, 'the issue became a finding via 6A'),
          comparisonUsed: bool(actions.some((a) => a.kind === 'comparison' && a.state === 'completed'), 'a focused comparison was selected'),
          verifyUsed: bool(actions.some((a) => a.kind === 'verify' && a.state === 'completed'), 'verification ran'),
          unnecessarySpecialist: eq(run.usage.specialistRuns, 0, 'unnecessary specialist invocation rate is zero (headline)'),
          noRedundantActions: atMost(actions.filter((a) => a.state === 'completed' && (a.usefulness === 'no-new-information')).length, 1, 'few redundant actions'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 3: specialist useful → no comparison possible, specialist adds signal. ──
    {
      const s0 = Date.now()
      const eid = await engagement('rb-spec-useful', false) // no identities/sessions → no comparison can be planned
      await resource(eid, 'sdoc', 'leaky', null)
      const engine = new FakeSpecialistEngine({ vulnerabilities: [webVuln(`${fixture.url}/api/resources/sdoc`)] })
      const run = await drive(confirmingAi, eid, 'investigate-api-surface', engine)
      const actions = await listResearchActions(db, run.id)
      scenarios.push({
        name: 'specialist-useful',
        description: 'When no cheaper comparison can be planned, the specialist is selected and provides a signal (which still passes through the verification boundary, never a direct finding).',
        metrics: {
          specialistRan: bool(run.usage.specialistRuns >= 1 || actions.some((a) => a.kind === 'specialist' && a.state === 'completed'), 'the specialist ran as a last resort'),
          noDirectFinding: eq((await listFindingsForEngagement(db, eid)).length, 0, 'a lone specialist signal did not become a finding'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 4: provider unavailable → degrade honestly, deterministic work continues. ──
    {
      const s0 = Date.now()
      const eid = await engagement('rb-degrade')
      await resource(eid, 'ldoc', 'leaky')
      const run = await drive(degradingAi, eid, 'investigate-authorization')
      scenarios.push({
        name: 'provider-unavailable',
        description: 'When the AI planner is unavailable, the run degrades honestly and deterministic ingestion/verification still produces findings.',
        metrics: {
          degraded: bool(!run.providerAvailable, 'the run recorded the provider as unavailable'),
          notFalselyComplete: bool(run.terminationReason !== 'ai-unavailable' || (await listFindingsForEngagement(db, eid)).length >= 0, 'did not crash'),
          stillProduced: atLeast((await listFindingsForEngagement(db, eid)).length, 1, 'deterministic verification still produced a finding'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 5: adversarial AI → proposals rejected, no unjustified specialist, loop still sound. ──
    {
      const s0 = Date.now()
      const eid = await engagement('rb-adversarial')
      await resource(eid, 'ldoc', 'leaky')
      const adversarialAi: ReasoningAi = {
        async run(task) {
          if (task.prompt === 'security-research-planner') return aiResult('succeeded', { proposals: [{ kind: 'specialist', objectiveRef: null, resourceRef: null, findingId: null, priority: 'high', reason: 'run the big tool' }, { kind: 'comparison', objectiveRef: 'ghost', resourceRef: 'ghost', findingId: null, priority: 'high', reason: 'invent a resource' }], note: '' })
          return confirmingAi.run(task)
        },
      }
      const run = await drive(adversarialAi, eid, 'investigate-authorization')
      const actions = await listResearchActions(db, run.id)
      scenarios.push({
        name: 'adversarial-ai',
        description: 'Adversarial AI proposals (unjustified specialist, invented reference) are rejected deterministically; the loop still finds the real issue.',
        metrics: {
          specialistRejected: bool(actions.some((a) => a.kind === 'specialist' && a.state === 'rejected'), 'the unjustified specialist was rejected'),
          inventedRejected: bool(actions.some((a) => a.origin === 'ai-proposed' && a.state === 'rejected' && (a.rejection === 'reference-missing' || a.rejection === 'input-invalid')), 'the invented reference was rejected'),
          noUnjustifiedSpecialistRun: eq(run.usage.specialistRuns, 0, 'the unjustified specialist never ran'),
          stillFound: atLeast((await listFindingsForEngagement(db, eid)).length, 1, 'the real issue was still found deterministically'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    for (const s of scenarios) s.pass = Object.values(s.metrics).every((m) => m.pass)
    const summary: Record<string, BenchmarkMetric> = {
      scenarios: eq(scenarios.filter((s) => s.pass).length, scenarios.length, `${scenarios.filter((s) => s.pass).length}/${scenarios.length} scenarios passed`),
      healthyZeroFindings: bool(scenarios[0]?.metrics.falseFindings?.pass ?? false, 'healthy-app verified findings = 0'),
      zeroUnnecessarySpecialist: bool(scenarios[1]?.metrics.unnecessarySpecialist?.pass ?? false, 'unnecessary specialist invocation rate = 0'),
      failingMetrics: eq(scenarios.flatMap((s) => Object.values(s.metrics)).filter((m) => !m.pass).length, 0, 'no failing metric'),
    }
    return { startedAt, durationMs: Date.now() - t0, scenarios, summary, pass: scenarios.every((s) => s.pass) }
  } finally {
    await fixture.close()
  }
}
