import type { Server } from 'node:http'
import type { Logger } from '@audivra/config'
import type { ComparisonPlanInput, RetestState, SecurityActor } from '@audivra/contracts'
import { listFindingsForEngagement, type Db } from '@audivra/database'
import {
  AttackPathService,
  CapabilityBroker,
  ComparisonEngine,
  createDbSecurityStore,
  createRuntimeRegistry,
  createSecretVault,
  DomainService,
  GraphProjector,
  HistoryService,
  RetestService,
  SecurityService,
  SessionEstablishmentService,
  VaultAuthResolver,
  VerificationService,
  type Resolver,
} from '@audivra/security'

/*
 * Phase 6C — the historical / retest benchmark. Controlled fixture sequences with a KNOWN ground truth, over
 * which Audivra retests findings and compares assessments. It measures the correctness of the HISTORICAL
 * conclusions: a fix is proven (never asserted from absence), cannot-reproduce is distinct, regression is
 * detected, a vanished path is reported not fixed, and a coverage reduction is surfaced.
 *
 *   The single most important metric: the false-FIXED rate is ZERO — nothing is ever called fixed without a
 *   retest that actually ran with a working control.
 */

interface BenchmarkMetric {
  value: number
  target: string
  pass: boolean
  detail: string
}
interface ScenarioResult {
  name: string
  description: string
  pass: boolean
  metrics: Record<string, BenchmarkMetric>
  durationMs: number
}
export interface HistoryBenchmarkResult {
  startedAt: string
  durationMs: number
  scenarios: ScenarioResult[]
  summary: Record<string, BenchmarkMetric>
  pass: boolean
}

const USER: SecurityActor = { kind: 'user', id: 'benchmark', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const eq = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `= ${want}`, pass: value === want, detail })
const atLeast = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≥ ${want}`, pass: value >= want, detail })
const bool = (value: boolean, detail: string): BenchmarkMetric => ({ value: value ? 1 : 0, target: '= 1', pass: value, detail })

interface IdentityFixtureLike {
  url: string
  tokens: Map<string, string>
  principals: Map<string, { tenant: string; role: 'user' | 'admin' }>
  resources: Map<string, { tenant: string; owner: string; state: string; enforce: 'strict' | 'tenant' | 'leaky' }>
  close(): Promise<void>
  server: Server
}
async function startFixture(): Promise<IdentityFixtureLike> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../../../fixtures/identity/server.mjs')) as { startIdentityFixture(opts: { port: number; label: string }): Promise<IdentityFixtureLike> }
  return mod.startIdentityFixture({ port: 0, label: 'history-bench' })
}

export async function runHistoryBenchmark(options: { db: Db; log?: Logger }): Promise<HistoryBenchmarkResult> {
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
  const engine = new ComparisonEngine({ db, broker, projector })
  const retests = new RetestService({ db, comparisonEngine: engine, registry })
  const history = new HistoryService({ db })

  const mkIdentity = async (e: string, ref: string, tenant: string) => {
    const token = `hb-${ref}-${Math.random().toString(36).slice(2, 10)}`
    fixture.tokens.set(token, ref)
    fixture.principals.set(ref, { tenant, role: 'user' })
    await domain.declare(e, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, USER)
    await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, USER)
    await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, USER)
  }
  const arm = (role: 'subject' | 'positive-control' | 'negative-control', identityRef: string | null, resourceRef: string, url: string, outcome: 'allow' | 'deny') => ({
    role,
    identityRef,
    resourceRef,
    url,
    method: 'GET' as const,
    expected: { outcome, basis: outcome === 'allow' ? ('observed' as const) : ('declared' as const), invariantRef: null, sourceRef: null, rationale: '' },
  })
  const declareResource = async (e: string, id: string, enforce: 'strict' | 'leaky') => {
    fixture.resources.set(id, { tenant: 't1', owner: 'alice', state: 'draft', enforce })
    const url = `${fixture.url}/api/resources/${id}`
    await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, USER)
    return url
  }
  const brokenComparison = async (e: string, id: string, enforce: 'strict' | 'leaky') => {
    const url = await declareResource(e, id, enforce)
    return engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: id, action: 'read', arms: [arm('subject', 'bob', id, url, 'deny'), arm('positive-control', 'alice', id, url, 'allow'), arm('negative-control', null, id, url, 'deny')] } as ComparisonPlanInput, USER)
  }
  /** An assessment that declares identities, runs an object-boundary comparison per resource, and verifies. */
  const assessment = async (name: string, resources: { id: string; enforce: 'strict' | 'leaky' }[], opts: { verify?: boolean; paths?: boolean } = {}) => {
    const created = await service.createEngagement({ name: `${name}-${Math.random().toString(36).slice(2, 6)}`, targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
    const e = created.id
    await service.requestAuthorization(e, { method: 'local-development' }, USER)
    await mkIdentity(e, 'alice', 't1')
    await mkIdentity(e, 'bob', 't1')
    for (const r of resources) await brokenComparison(e, r.id, r.enforce)
    if (opts.verify !== false) await new VerificationService({ db, registry, graphProjector: projector }).drive(e)
    if (opts.paths) await new AttackPathService({ db }).drive(e)
    return e
  }
  /** A retest target: declare identities + the resource with a given enforcement; no comparison/verification. */
  const target = async (name: string, resources: { id: string; enforce: 'strict' | 'leaky' }[]) => {
    const created = await service.createEngagement({ name: `${name}-${Math.random().toString(36).slice(2, 6)}`, targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
    const e = created.id
    await service.requestAuthorization(e, { method: 'local-development' }, USER)
    await mkIdentity(e, 'alice', 't1')
    await mkIdentity(e, 'bob', 't1')
    for (const r of resources) await declareResource(e, r.id, r.enforce)
    return e
  }
  const findingFor = async (e: string, resource: string) => (await listFindingsForEngagement(db, e)).find((f) => f.issueKey.includes(resource) || f.affectedEntities.some((en) => en.label === resource || en.key.includes(resource)))!

  const scenarios: ScenarioResult[] = []
  const falseFixed = (states: RetestState[], proven: boolean[]) => states.filter((s, i) => s === 'fixed' && !proven[i]).length

  try {
    // ── Scenario 1: a fix is proven; a still-broken boundary is still-present. (Sequence A) ──
    {
      const s0 = Date.now()
      const a1 = await assessment('hb-a1', [{ id: 'r1', enforce: 'leaky' }, { id: 'r2', enforce: 'leaky' }, { id: 'rreg', enforce: 'leaky' }], { paths: true })
      const caseR1 = await retests.ensureCase((await findingFor(a1, 'r1')).id)
      const caseR2 = await retests.ensureCase((await findingFor(a1, 'r2')).id)
      const caseReg = await retests.ensureCase((await findingFor(a1, 'rreg')).id)

      const tFix = await target('hb-fix', [{ id: 'r1', enforce: 'strict' }])
      const fixed = await retests.runRetest(caseR1.id, tFix)
      const tStill = await target('hb-still', [{ id: 'r2', enforce: 'leaky' }])
      const still = await retests.runRetest(caseR2.id, tStill)

      scenarios.push({
        name: 'fix-and-still-present',
        description: 'A retest of an enforced boundary (subject denied, owner still allowed) is FIXED with a valid control; a still-leaky boundary is STILL_PRESENT.',
        metrics: {
          fixed: bool(fixed.state === 'fixed', `enforced boundary → fixed (${fixed.state})`),
          fixedControl: bool(fixed.controlValid, 'the positive control still proved the test meaningful'),
          stillPresent: bool(still.state === 'still-present', `leaky boundary → still-present (${still.state})`),
          falseFixed: eq(falseFixed([fixed.state, still.state], [true, false]), 0, 'no fix asserted without a working control'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })

      // ── Scenario 4 uses the same rreg case: fix then regress. (Sequence D) ──
      const s4 = Date.now()
      const tRegFix = await target('hb-regfix', [{ id: 'rreg', enforce: 'strict' }])
      const regFixed = await retests.runRetest(caseReg.id, tRegFix)
      const tReg = await target('hb-reg', [{ id: 'rreg', enforce: 'leaky' }])
      const regressed = await retests.runRetest(caseReg.id, tReg)
      scenarios.push({
        name: 'regression',
        description: 'An issue proven fixed and then present again is detected as REGRESSED (the full timeline is preserved).',
        metrics: {
          firstFixed: bool(regFixed.state === 'fixed', `first retest fixed (${regFixed.state})`),
          regressed: bool(regressed.state === 'regressed', `present again after a fix → regressed (${regressed.state})`),
          falseFixed: eq(falseFixed([regressed.state], [false]), 0, 'the regression is not mis-labelled fixed'),
        },
        pass: false,
        durationMs: Date.now() - s4,
      })

      // ── Scenario 3: cannot-reproduce when the resource is gone. (Sequence C) ──
      const s3 = Date.now()
      const tGone = await target('hb-gone', [])
      const gone = await retests.runRetest(caseR1.id, tGone)
      scenarios.push({
        name: 'cannot-reproduce',
        description: 'Replaying against an assessment that no longer declares the resource is CANNOT_REPRODUCE — a gap, never a fix.',
        metrics: {
          cannotReproduce: bool(gone.state === 'cannot-reproduce', `missing resource → cannot-reproduce (${gone.state})`),
          notFixed: bool(gone.state !== 'fixed', 'a missing resource is never fixed'),
        },
        pass: false,
        durationMs: Date.now() - s3,
      })

      // ── Scenario 5: attack-path history — a route that is gone is reported, not fixed. (Sequence E) ──
      const s5 = Date.now()
      const p2 = await assessment('hb-p2', [{ id: 'r1', enforce: 'leaky' }], { paths: true })
      const cmpPaths = await history.compareAssessments(a1, p2, { persist: false })
      const disappeared = cmpPaths.pathChanges.filter((p) => p.class === 'disappeared')
      scenarios.push({
        name: 'path-history',
        description: 'Comparing two assessments, a path present before and gone now is "disappeared" (with its removed verified edges) — never claimed fixed.',
        metrics: {
          disappeared: atLeast(disappeared.length, 1, `${disappeared.length} path(s) reported disappeared`),
          removedVerifiedEdge: bool(disappeared.some((p) => p.removedVerifiedEdges.length > 0), 'a removed verified edge is shown'),
          noPathFixed: bool(cmpPaths.pathChanges.every((p) => p.class !== 'still-present' || p.currentPathId !== null), 'a path is not fabricated as still-present'),
        },
        pass: false,
        durationMs: Date.now() - s5,
      })

      // ── Scenario 6: coverage awareness — fewer measurements is surfaced. (Sequence F) ──
      const s6 = Date.now()
      const cov = await history.compareAssessments(a1, p2, { persist: false })
      scenarios.push({
        name: 'coverage-awareness',
        description: 'When the later assessment measured less (fewer resources/comparisons), the coverage regression is surfaced so fewer findings is not read as improvement.',
        metrics: {
          coverageRegressed: bool(cov.coverage.coverageRegressed, 'a reduction in coverage is flagged'),
          fewerResources: bool(cov.coverage.resourcesSampled.delta < 0, `fewer resources sampled (${cov.coverage.resourcesSampled.delta})`),
          note: bool(cov.coverage.notes.some((n) => /caution/i.test(n)), 'the comparison warns to interpret with caution'),
        },
        pass: false,
        durationMs: Date.now() - s6,
      })
    }

    // ── Scenario 2: an absence with no retest is not-tested, never fixed. (Sequence B) ──
    {
      const s0 = Date.now()
      const b1 = await assessment('hb-b1', [{ id: 'bdoc', enforce: 'leaky' }])
      const b2 = await target('hb-b2', [])
      const cmp = await history.compareAssessments(b1, b2, { persist: false })
      scenarios.push({
        name: 'absence-not-fixed',
        description: 'A previous finding absent from a later assessment with NO retest is classified not-tested — absence is never a fix.',
        metrics: {
          notTested: atLeast(cmp.summary.notTested, 1, `${cmp.summary.notTested} not-tested`),
          zeroFixed: eq(cmp.summary.fixed, 0, 'nothing fixed without a retest'),
          fixedAllBacked: bool(cmp.findingChanges.filter((e) => e.class === 'fixed').every((e) => e.retestResultId), 'any fixed entry is backed by a retest result'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    for (const s of scenarios) s.pass = Object.values(s.metrics).every((m) => m.pass)
    const allFixedBacked = scenarios.every((s) => (s.metrics.falseFixed ? s.metrics.falseFixed.pass : true))
    const summary: Record<string, BenchmarkMetric> = {
      scenarios: eq(scenarios.filter((s) => s.pass).length, scenarios.length, `${scenarios.filter((s) => s.pass).length}/${scenarios.length} scenarios passed`),
      falseFixedRate: bool(allFixedBacked, 'the false-FIXED rate is zero across the benchmark'),
      failingMetrics: eq(scenarios.flatMap((s) => Object.values(s.metrics)).filter((m) => !m.pass).length, 0, 'no failing metric'),
    }
    return { startedAt, durationMs: Date.now() - t0, scenarios, summary, pass: scenarios.every((s) => s.pass) }
  } finally {
    await fixture.close()
  }
}
