import type { Server } from 'node:http'
import type { Logger } from '@audivra/config'
import type { ComparisonPlanInput, ComparisonResult, ProposedComparison, SecurityActor } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import {
  CapabilityBroker,
  ComparisonEngine,
  ComparisonReasoner,
  ComparisonService,
  createDbSecurityStore,
  createRuntimeRegistry,
  createSecretVault,
  DomainService,
  GraphService,
  SecurityService,
  SessionEstablishmentService,
  validateProposedComparison,
  VaultAuthResolver,
  type ReasoningAi,
  type Resolver,
} from '@audivra/security'

/** A ReasoningAi that is always unavailable — proves the deterministic planner works when the provider is down. */
const UNAVAILABLE_AI: ReasoningAi = {
  run: async () => ({
    outcome: 'provider-unavailable',
    output: null,
    selection: { taskType: 'security-plan', providerId: null, model: null, reason: 'no provider', considered: [], at: new Date().toISOString() },
    provenance: [],
    attempts: 0,
    refused: false,
    promptVersion: null,
  }),
}

/*
 * Phase 5 Step 4 — the authorization/business-logic benchmark. It builds a multi-tenant fixture with a KNOWN
 * ground truth (which identity/resource/action triples are allowed vs denied, which boundaries are enforced
 * vs intentionally broken), has Audivra plan + run differential comparisons, and measures real precision and
 * recall of the authorization signal, control usage, tenant/business-rule accuracy, false positives,
 * inconclusive correctness, cleanup correctness and planner selection (no duplicate/unnecessary comparisons).
 * No real AI and no Docker: the comparison engine is deterministic and runs the reviewed identity-aware
 * capabilities in-process through the Capability Broker.
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
export interface AuthorizationBenchmarkResult {
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
const atMost = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≤ ${want}`, pass: value <= want, detail })
const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000)

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
  return mod.startIdentityFixture({ port: 0, label: 'authz-bench' })
}

export async function runAuthorizationBenchmark(options: { db: Db; log?: Logger }): Promise<AuthorizationBenchmarkResult> {
  const { db } = options
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const fixture = await startFixture()
  const service = new SecurityService({ db, resolver: loopback })
  const domain = new DomainService({ db })
  const vault = createSecretVault(db)
  const establishment = new SessionEstablishmentService({ db, vault })
  const broker = new CapabilityBroker({ registry: createRuntimeRegistry(), store: createDbSecurityStore(db), resolver: loopback, authResolver: new VaultAuthResolver({ db, vault }), checkResources: async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} }) })
  const engine = new ComparisonEngine({ db, broker })
  const comparisons = new ComparisonService({ db, engine })
  const graph = new GraphService({ db })
  const reasoner = new ComparisonReasoner({ db, engine, service: comparisons })

  try {
    const engagement = await service.createEngagement({ name: 'Authorization benchmark', targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
    const e = engagement.id
    await service.requestAuthorization(e, { method: 'local-development' }, USER)

    // ── Ground truth: identities, tenants, resources (enforced vs broken) and invariants. ──
    const mkIdentity = async (ref: string, tenant: string, role: 'user' | 'admin' = 'user', roleRefs: string[] = []) => {
      const token = `bench-${ref}-${Math.random().toString(36).slice(2, 10)}`
      fixture.tokens.set(token, ref)
      fixture.principals.set(ref, { tenant, role })
      await domain.declare(e, { kind: 'identity', ref, spec: { identityType: role === 'admin' ? 'admin' : 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant, roleRefs } }, USER)
      await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, USER)
      await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, USER)
    }
    const mkResource = async (id: string, tenant: string, owner: string, enforce: 'strict' | 'tenant' | 'leaky', invariantCategory: 'object-boundary' | 'tenant-boundary') => {
      fixture.resources.set(id, { tenant, owner, state: 'draft', enforce })
      const url = `${fixture.url}/api/resources/${id}`
      await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: owner, tenantRef: tenant, canonicalUrl: url, testData: 'test-owned' } }, USER)
      await domain.declare(e, { kind: 'invariant', ref: `inv-${id}`, spec: { category: invariantCategory, rule: `boundary on ${id}`, affects: [{ kind: 'resource', ref: id }] } }, USER)
      return url
    }

    // A role declared before the identities that hold it (no dangling references).
    await domain.declare(e, { kind: 'role', ref: 'editor', spec: { permits: ['approve'] } }, USER)
    await mkIdentity('alice', 't1', 'admin', ['editor'])
    await mkIdentity('bob', 't1')
    await mkIdentity('carol', 't2')
    // Ground truth: enforced object boundary, broken object boundary, enforced tenant boundary, broken tenant boundary.
    const docEnforced = await mkResource('obj-enforced', 't1', 'alice', 'strict', 'object-boundary')
    const docBroken = await mkResource('obj-broken', 't1', 'alice', 'leaky', 'object-boundary')
    const tenEnforced = await mkResource('ten-enforced', 't1', 'alice', 'tenant', 'tenant-boundary')
    const tenBroken = await mkResource('ten-broken', 't1', 'alice', 'leaky', 'tenant-boundary')
    // A business action with an endpoint, so the planner can also plan role/function/business-rule comparisons.
    await domain.declare(e, { kind: 'business-action', ref: 'approve', spec: { verb: 'approve', actsOnRefs: ['obj-enforced'], requiredRoleRefs: ['editor'], requiredStateRef: 'draft', resultingStateRef: 'approved', effectClass: 'reversible-state-change', endpointUrl: `${docEnforced}/approve`, method: 'POST', stateProbeUrl: `${docEnforced}/state` } }, USER)

    const armPlan = (role: 'subject' | 'positive-control' | 'negative-control', identityRef: string | null, resourceRef: string, url: string, outcome: 'allow' | 'deny') => ({
      role,
      identityRef,
      resourceRef,
      url,
      method: 'GET' as const,
      expected: { outcome, basis: outcome === 'allow' ? ('observed' as const) : ('declared' as const), invariantRef: null, sourceRef: null, rationale: '' },
    })
    const objectPlan = (resourceRef: string, url: string): ComparisonPlanInput =>
      ({
        dimension: 'object-boundary',
        resourceRef,
        action: 'read',
        invariantRef: `inv-${resourceRef}`,
        arms: [armPlan('subject', 'bob', resourceRef, url, 'deny'), armPlan('positive-control', 'alice', resourceRef, url, 'allow'), armPlan('negative-control', null, resourceRef, url, 'deny')],
      }) as ComparisonPlanInput
    const tenantPlan = (resourceRef: string, url: string): ComparisonPlanInput =>
      ({
        dimension: 'tenant-boundary',
        resourceRef,
        action: 'read',
        invariantRef: `inv-${resourceRef}`,
        arms: [armPlan('subject', 'carol', resourceRef, url, 'deny'), armPlan('positive-control', 'alice', resourceRef, url, 'allow'), armPlan('negative-control', null, resourceRef, url, 'deny')],
      }) as ComparisonPlanInput

    // Expected results by resource (ground truth).
    const expected: Record<string, ComparisonResult> = { 'obj-enforced': 'consistent', 'obj-broken': 'inconsistent', 'ten-enforced': 'consistent', 'ten-broken': 'inconsistent' }
    const run = async (plan: ComparisonPlanInput) => engine.planAndRun(e, plan, USER)

    const scenarios: ScenarioResult[] = []

    // Scenario 1: object-boundary precision/recall.
    {
      const s0 = Date.now()
      const enforced = await run(objectPlan('obj-enforced', docEnforced))
      const broken = await run(objectPlan('obj-broken', docBroken))
      const correct = [enforced, broken].filter((c) => c.result === expected[c.resourceRef]).length
      const detected = broken.result === 'inconsistent' ? 1 : 0
      const falsePositive = enforced.result === 'inconsistent' ? 1 : 0
      scenarios.push({
        name: 'object-boundary',
        description: 'An enforced object boundary is consistent; a broken one (IDOR) is detected inconsistent, with controls.',
        metrics: {
          precision: eq(rate(correct, 2), 1, `${correct}/2 object comparisons matched ground truth`),
          recall: eq(detected, 1, 'the broken object boundary was detected'),
          falsePositive: eq(falsePositive, 0, 'the enforced boundary was not falsely flagged'),
          controls: eq([enforced, broken].filter((c) => c.controls.positive && c.controls.negative).length, 2, 'both comparisons used positive + negative controls'),
          businessRule: eq([enforced.invariantEvaluation === 'supported', broken.invariantEvaluation === 'contradicted'].filter(Boolean).length, 2, 'invariant evaluations matched ground truth'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // Scenario 2: tenant-boundary accuracy.
    {
      const s0 = Date.now()
      const enforced = await run(tenantPlan('ten-enforced', tenEnforced))
      const broken = await run(tenantPlan('ten-broken', tenBroken))
      const correct = [enforced, broken].filter((c) => c.result === expected[c.resourceRef]).length
      scenarios.push({
        name: 'tenant-boundary',
        description: 'A cross-tenant read is denied for an enforced boundary and leaks for a broken one; relationship is different-tenant.',
        metrics: {
          tenantAccuracy: eq(rate(correct, 2), 1, `${correct}/2 tenant comparisons matched ground truth`),
          relationship: eq([enforced, broken].filter((c) => c.resourceRelationship === 'different-tenant').length, 2, 'both were classified different-tenant'),
          recall: eq(broken.result === 'inconsistent' ? 1 : 0, 1, 'the broken tenant boundary was detected'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // Scenario 3: inconclusive correctness (no positive control → never overclaim).
    {
      const s0 = Date.now()
      const url = `${fixture.url}/api/resources/obj-broken`
      const noControl = await run({ dimension: 'object-boundary', resourceRef: 'obj-broken', action: 'read', invariantRef: null, arms: [armPlan('subject', 'bob', 'obj-broken', url, 'deny')] } as ComparisonPlanInput)
      scenarios.push({
        name: 'inconclusive-correctness',
        description: 'Access obtained with no positive control is reported inconclusive, never a confirmed signal.',
        metrics: { inconclusive: eq(noControl.result === 'inconclusive' ? 1 : 0, 1, `result was ${noControl.result} without a control`) },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // Scenario 4: state transition + cleanup.
    {
      const s0 = Date.now()
      const url = `${fixture.url}/api/resources/obj-enforced`
      const state = await run({
        dimension: 'state-transition',
        resourceRef: 'obj-enforced',
        action: 'approve',
        arms: [armPlan('subject', 'alice', 'obj-enforced', `${url}/approve`, 'allow')].map((a) => ({ ...a, method: 'POST' as const })),
        stateProbeUrl: `${url}/state`,
        expectedTransition: 'draft→approved',
        cleanupRequired: true,
        cleanup: { identityRef: 'alice', url: `${url}/reset`, method: 'POST' as const, body: null },
      } as ComparisonPlanInput)
      scenarios.push({
        name: 'state-transition-cleanup',
        description: 'A state transition is recorded before→after and cleanup restores the original state (visibly).',
        metrics: {
          transition: eq(state.state?.transitionObserved ? 1 : 0, 1, `before=${state.state?.before?.businessResult} after=${state.state?.after?.businessResult}`),
          cleanup: eq(state.cleanup.attempted && state.cleanup.succeeded === true ? 1 : 0, 1, `cleanup ${state.cleanup.succeeded ? 'succeeded' : 'did not succeed'}`),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // Scenario 5: planner selection — bounded, controlled, duplicate-free, across multiple categories, pruned.
    {
      const s0 = Date.now()
      const { plans, stats } = await comparisons.propose(e)
      const withControls = plans.filter((p) => p.plan.arms.some((a) => a.role === 'positive-control' || a.role === 'negative-control')).length
      const keys = plans.map((p) => `${p.plan.dimension}|${p.plan.resourceRef}|${p.plan.action}`)
      const duplicates = keys.length - new Set(keys).size
      const dimensions = new Set(plans.map((p) => p.plan.dimension))
      scenarios.push({
        name: 'planner-selection',
        description: 'The planner proposes a bounded, controlled, duplicate-free set spanning multiple boundary categories, and prunes the candidate space.',
        metrics: {
          bounded: atMost(plans.length, 6, `${plans.length} proposals`),
          controlled: eq(plans.length === 0 ? 0 : withControls === plans.length ? 1 : 0, plans.length === 0 ? 0 : 1, 'every proposal carries a control arm'),
          duplicates: eq(duplicates, 0, 'no duplicate (dimension,resource,action) proposals'),
          categories: atLeast(dimensions.size, 3, `covers ${[...dimensions].join(', ')}`),
          pruned: eq(stats.proposed <= stats.candidates && stats.candidates <= stats.cartesian ? 1 : 0, 1, `cartesian ${stats.cartesian} → candidates ${stats.candidates} → proposed ${stats.proposed}`),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // Scenario 6: comparison → graph derivation. The broken object boundary (scenario 1) derives CAN_ACCESS.
    {
      const s0 = Date.now()
      await graph.project(e)
      const edges = await graph.edges(e, { type: 'CAN_ACCESS' })
      const derived = edges.find((edge) => edge.fromKey.startsWith('identity:') && edge.toKey.startsWith('resource:'))
      scenarios.push({
        name: 'graph-derivation',
        description: 'A strong inconsistent comparison derives a CAN_ACCESS graph fact with comparison-derived provenance, distinct from declared/observed.',
        metrics: {
          derivedEdge: atLeast(edges.length, 1, `${edges.length} CAN_ACCESS edge(s)`),
          distinctBasis: eq(derived && derived.basis === 'derived' ? 1 : 0, 1, 'the derived fact is basis=derived, not declared/observed'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // Scenario 7: AI proposal validation + deterministic fallback.
    {
      const s0 = Date.now()
      const input = await comparisons.plannerInput(e, 'isolated-lab')
      const good: ProposedComparison = {
        hypothesisId: 'hy_00000000000000',
        dimension: 'object-boundary',
        resourceRef: 'obj-enforced',
        action: 'read',
        invariantRef: null,
        expectedTransition: null,
        reason: 'valid proposal',
        arms: [
          { role: 'subject', identityRef: 'bob', resourceRef: 'obj-enforced', url: docEnforced, method: 'GET', body: null, expected: { outcome: 'deny', basis: 'ai-inferred', invariantRef: null, sourceRef: null, rationale: 'bob is not the owner' } },
          { role: 'positive-control', identityRef: 'alice', resourceRef: 'obj-enforced', url: docEnforced, method: 'GET', body: null, expected: { outcome: 'allow', basis: 'observed', invariantRef: null, sourceRef: null, rationale: 'alice owns it' } },
        ],
      }
      const invented = { ...good, resourceRef: 'ghost-resource' } as ProposedComparison
      const ownershipLie = { ...good, arms: [{ ...good.arms[0]!, identityRef: 'alice' }, good.arms[1]!] } as ProposedComparison // alice IS the owner → deny mismatch
      const acceptGood = validateProposedComparison(good, input).ok
      const rejectInvented = !validateProposedComparison(invented, input).ok
      const rejectLie = !validateProposedComparison(ownershipLie, input).ok
      // Deterministic fallback: the reasoner proposes without AI (and when AI is unavailable).
      const fallback = await reasoner.drive(e, { mode: 'propose' })
      const unavailable = await new ComparisonReasoner({ db, engine, service: comparisons, ai: UNAVAILABLE_AI }).drive(e, { mode: 'propose' })
      scenarios.push({
        name: 'ai-proposal-and-fallback',
        description: 'A valid AI proposal is accepted and adversarial ones (invented resource, false ownership) are rejected; the deterministic planner works without AI and when the provider is unavailable.',
        metrics: {
          acceptsValid: eq(acceptGood ? 1 : 0, 1, 'a well-formed proposal referencing real entities is accepted'),
          rejectsInvented: eq(rejectInvented ? 1 : 0, 1, 'a proposal referencing an invented resource is rejected'),
          rejectsOwnershipLie: eq(rejectLie ? 1 : 0, 1, 'a proposal whose ownership claim is false is rejected'),
          deterministicWorks: atLeast(fallback.deterministicProposed, 1, `${fallback.deterministicProposed} deterministic proposals (AI not required)`),
          fallbackOnUnavailable: eq(unavailable.aiOutcome === 'provider-unavailable' && unavailable.deterministicProposed >= 1 ? 1 : 0, 1, 'provider-unavailable falls back to deterministic planning'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    for (const s of scenarios) s.pass = Object.values(s.metrics).every((m) => m.pass)
    const allMetrics = scenarios.flatMap((s) => Object.values(s.metrics))
    const summary = {
      scenariosPassed: eq(scenarios.filter((s) => s.pass).length, scenarios.length, `${scenarios.filter((s) => s.pass).length}/${scenarios.length} scenarios passed`),
      metricsPassed: eq(allMetrics.filter((m) => m.pass).length, allMetrics.length, `${allMetrics.filter((m) => m.pass).length}/${allMetrics.length} metrics passed`),
      acceptanceRate: atLeast(rate(allMetrics.filter((m) => m.pass).length, allMetrics.length), 1, 'fraction of metrics passing'),
    }
    return { startedAt, durationMs: Date.now() - t0, scenarios, summary, pass: scenarios.every((s) => s.pass) }
  } finally {
    await fixture.close()
  }
}
