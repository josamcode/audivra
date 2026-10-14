import type { Server } from 'node:http'
import type { Logger } from '@audivra/config'
import type { PolicyDecision, SpecialistVulnerability } from '@audivra/contracts'
import { listFindingsForEngagement, listSecurityObservations, recordSecurityObservation, type Db } from '@audivra/database'
import {
  createDbSecurityStore,
  createRuntimeRegistry,
  DomainService,
  FakeSpecialistEngine,
  fakeVuln,
  GraphProjector,
  observationDedupeKey,
  SecurityService,
  SpecialistRunService,
  strixPlannerMetadata,
  VerificationService,
  type Resolver,
} from '@audivra/security'

/*
 * Phase 6D — the specialist (Strix) benchmark. A controlled fixture with KNOWN ground truth over which the
 * deterministic fake engine drives the whole lifecycle. It measures ingestion accuracy, entity linking,
 * candidate dedupe/corroboration, specialist-signal → verification conversion, honest provider-unavailable /
 * partial handling, and containment (out-of-scope results dropped). The single most important invariant:
 *
 *   a Strix result ALONE never produces an Audivra VERIFIED/supported finding without the 6A boundary.
 */

interface BenchmarkMetric { value: number; target: string; pass: boolean; detail: string }
interface ScenarioResult { name: string; description: string; pass: boolean; metrics: Record<string, BenchmarkMetric>; durationMs: number }
export interface SpecialistBenchmarkResult { startedAt: string; durationMs: number; scenarios: ScenarioResult[]; summary: Record<string, BenchmarkMetric>; pass: boolean }

const USER = { kind: 'user' as const, id: 'benchmark', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const eq = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `= ${want}`, pass: value === want, detail })
const atLeast = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≥ ${want}`, pass: value >= want, detail })
const bool = (value: boolean, detail: string): BenchmarkMetric => ({ value: value ? 1 : 0, target: '= 1', pass: value, detail })

const allowBroker = { async preflight(): Promise<PolicyDecision> { return { decision: 'allow', reason: 'bench-allow' } as unknown as PolicyDecision } }

interface FixtureLike { url: string; resources: Map<string, unknown>; close(): Promise<void>; server: Server }
async function startFixture(): Promise<FixtureLike> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../../../fixtures/identity/server.mjs')) as { startIdentityFixture(opts: { port: number; label: string }): Promise<FixtureLike> }
  return mod.startIdentityFixture({ port: 0, label: 'specialist-bench' })
}

export async function runSpecialistBenchmark(options: { db: Db; log?: Logger }): Promise<SpecialistBenchmarkResult> {
  const { db } = options
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const fixture = await startFixture()
  const service = new SecurityService({ db, resolver: loopback })
  const domain = new DomainService({ db })
  const registry = createRuntimeRegistry()
  const projector = new GraphProjector({ db })
  void createDbSecurityStore

  const engagement = async (name: string) => {
    const created = await service.createEngagement({ name: `${name}-${Math.random().toString(36).slice(2, 6)}`, targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
    await service.requestAuthorization(created.id, { method: 'local-development' }, USER)
    return created.id
  }
  const resourceUrl = async (eid: string, id: string) => {
    const url = `${fixture.url}/api/resources/${id}`
    await domain.declare(eid, { kind: 'resource', ref: id, spec: { resourceType: 'document', canonicalUrl: url, testData: 'test-owned' } }, USER)
    return url
  }
  const webVuln = (url: string, title = 'Reflected XSS'): SpecialistVulnerability => fakeVuln({ nativeId: `s-${title}`, title, nativeCategory: 'A03:Injection', nativeSeverity: 'high', affected: { url, sourcePath: null, apiOperation: null, assetHint: null } })
  const specialist = (engine: FakeSpecialistEngine) => new SpecialistRunService({ db, broker: allowBroker, engines: { strix: engine }, graphProjector: projector })
  const verify = (eid: string) => new VerificationService({ db, registry, graphProjector: projector }).drive(eid)

  const scenarios: ScenarioResult[] = []
  try {
    // ── Scenario 1: lifecycle, boundary, entity-linking, dedupe, conversion. ──
    {
      const s0 = Date.now()
      // (a) a lone Strix signal → observation, never a finding.
      const lone = await engagement('spb-lone')
      const loneUrl = await resourceUrl(lone, 'doc1')
      const r1 = await specialist(new FakeSpecialistEngine({ vulnerabilities: [webVuln(loneUrl)] })).request(lone, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
      const d1 = await specialist(new FakeSpecialistEngine({ vulnerabilities: [webVuln(loneUrl)] })).drive(r1.id)
      await verify(lone)
      const loneFindings = await listFindingsForEngagement(db, lone)
      const loneObs = await listSecurityObservations(db, lone, {})

      // (b) a corroborated Strix signal → a finding, only via 6A.
      const corr = await engagement('spb-corr')
      const corrUrl = await resourceUrl(corr, 'doc1')
      const vuln = webVuln(corrUrl)
      const subject = `${vuln.nativeCategory}:${vuln.title}`.slice(0, 200)
      await recordSecurityObservation(db, { engagementId: corr, dedupeKey: observationDedupeKey('web-signal', corrUrl, subject), type: 'web-signal', asset: corrUrl, subject, title: vuln.title, scopeClass: 'in-scope', value: { tool: 'nuclei' }, sourceType: 'tool-heuristic', contribution: { executionId: 'sx_seed0000000001', capabilityId: 'web.nuclei', tool: 'nuclei', toolVersion: 'fixture', evidenceRef: 'EV-seed', confidence: 0.5, identityRef: null, sessionRef: null, at: new Date().toISOString() } })
      const rc = await specialist(new FakeSpecialistEngine({ vulnerabilities: [vuln] })).request(corr, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
      const dc = await specialist(new FakeSpecialistEngine({ vulnerabilities: [vuln] })).drive(rc.id)
      await verify(corr)
      const corrFindings = await listFindingsForEngagement(db, corr)

      scenarios.push({
        name: 'lifecycle-boundary-conversion',
        description: 'A lone specialist signal becomes an observation but never a finding; a corroborated one reaches a finding only through the 6A boundary; ingestion and entity-linking are accurate; dedupe merges rather than duplicating.',
        metrics: {
          ingestion: eq(d1.imported.observations, 1, 'one native result → one observation'),
          entityLinking: bool(loneObs.some((o) => o.contributions.some((c) => c.tool === 'strix')), 'the signal was linked as a strix-sourced observation'),
          sourceMetadata: bool(loneObs.some((o) => o.sourceType === 'tool-heuristic' && o.confidence === 0.5), 'recorded as a suspicion (tool-heuristic 0.5), not a verdict'),
          falseFinding: eq(loneFindings.length, 0, 'a lone Strix signal produces ZERO Audivra findings'),
          dedupe: eq(dc.imported.merged, 1, 'the corroborating signal merged into the existing observation (no duplicate)'),
          conversion: atLeast(corrFindings.length, 1, 'a corroborated signal converted to a finding via 6A verification'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 2: containment (out-of-scope) + honest partial/budget-stop. ──
    {
      const s0 = Date.now()
      const eid = await engagement('spb-contain')
      await resourceUrl(eid, 'doc1')
      const r = await specialist(new FakeSpecialistEngine()).request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
      const driven = await specialist(new FakeSpecialistEngine({ completion: 'budget-stopped', vulnerabilities: [webVuln('http://192.0.2.10/evil'), webVuln(`${fixture.url}/api/resources/doc1`, 'InScopeIssue')] })).drive(r.id)
      scenarios.push({
        name: 'containment-and-partial',
        description: 'An out-of-scope result is dropped (a discovered target is never authorized); a budget-stopped run is represented as such and never treated as complete coverage.',
        metrics: {
          outOfScopeDropped: eq(driven.imported.outOfScope, 1, 'the out-of-scope result was dropped'),
          inScopeKept: eq(driven.imported.observations, 1, 'the in-scope result was recorded'),
          partialHonest: bool(driven.state === 'budget-stopped' && driven.completion === 'budget-stopped', 'a budget-stopped run is not reported as complete'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 3: provider-unavailable is honest (never "clean"). ──
    {
      const s0 = Date.now()
      const eid = await engagement('spb-unavail')
      await resourceUrl(eid, 'doc1')
      const r = await specialist(new FakeSpecialistEngine()).request(eid, { engine: 'strix', mode: 'source-only', resourceRefs: ['doc1'], findingIds: [], stagedSourceRef: null, focus: 'broad' })
      const driven = await specialist(new FakeSpecialistEngine({ providerUnavailable: true })).drive(r.id)
      await verify(eid)
      scenarios.push({
        name: 'provider-unavailable',
        description: 'A provider-unavailable run is classified honestly, produces no signals, and is never interpreted as a clean target.',
        metrics: {
          unavailable: bool(driven.state === 'unavailable', 'the run is marked unavailable'),
          noSignals: eq(driven.imported.observations + driven.imported.merged, 0, 'no signals imported'),
          noFinding: eq((await listFindingsForEngagement(db, eid)).length, 0, 'no finding fabricated from an unavailable run'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 4: planner metadata keeps Strix from being the default action. ──
    {
      const s0 = Date.now()
      scenarios.push({
        name: 'planner-cost',
        description: 'The planner metadata marks the specialist as very expensive so cheaper focused capabilities are preferred — it is never the default action.',
        metrics: {
          costClass: bool(strixPlannerMetadata.costClass === 'very-high', 'specialist cost class is very-high'),
          notDefault: bool(/never the default/i.test(strixPlannerMetadata.expectedInformationGain), 'metadata states it is not the default action'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    for (const s of scenarios) s.pass = Object.values(s.metrics).every((m) => m.pass)
    const summary: Record<string, BenchmarkMetric> = {
      scenarios: eq(scenarios.filter((s) => s.pass).length, scenarios.length, `${scenarios.filter((s) => s.pass).length}/${scenarios.length} scenarios passed`),
      zeroDirectBypass: bool(scenarios[0]?.metrics.falseFinding?.pass ?? false, 'zero direct Strix → Audivra verified-finding bypass'),
      failingMetrics: eq(scenarios.flatMap((s) => Object.values(s.metrics)).filter((m) => !m.pass).length, 0, 'no failing metric'),
    }
    return { startedAt, durationMs: Date.now() - t0, scenarios, summary, pass: scenarios.every((s) => s.pass) }
  } finally {
    await fixture.close()
  }
}
