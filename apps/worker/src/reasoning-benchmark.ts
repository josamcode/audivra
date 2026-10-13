import http from 'node:http'
import type { Logger } from '@audivra/config'
import type { ReasoningRun, SecurityActor, SecurityHypothesis } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import { createProviderRouter, createReasoningAi, ProviderRegistry, ScriptedReasoningProvider, type ScriptedReasonerOptions } from '@audivra/ai-runtime'
import {
  CapabilityBroker,
  createDbExecutionStore,
  createDbSecurityStore,
  createFixtureSensorRegistry,
  ExecutionRuntime,
  GraphService,
  ReasoningEngine,
  ReasoningService,
  SecurityService,
  type CapabilityRegistry,
  type Resolver,
} from '@audivra/security'

/*
 * The Phase 4 reasoning benchmark: deterministic scenarios that measure the quality of Audivra's reasoning
 * — not how many hypotheses it produced. Each scenario runs the real projector, validator, ranking,
 * planner validation, broker and durable runtime (in-process fixture sensors, a local fixture site) with a
 * deterministic provider through the real router, including adversarial behaviours that apply
 * false-positive pressure. It penalizes unsupported hypotheses, invented evidence, duplicates, redundant or
 * needlessly expensive actions, and certainty the evidence does not justify.
 */

export interface BenchmarkMetric {
  value: number
  /** Human-readable target, e.g. "= 0" or "≥ 1". */
  target: string
  pass: boolean
  detail: string
}

export interface ScenarioResult {
  name: string
  description: string
  pass: boolean
  metrics: Record<string, BenchmarkMetric>
  run: Pick<ReasoningRun, 'status' | 'stopReason' | 'aiCoverage' | 'usage'> | null
  durationMs: number
}

export interface ReasoningBenchmarkResult {
  startedAt: string
  durationMs: number
  scenarios: ScenarioResult[]
  /** Aggregates across scenarios. */
  summary: Record<string, BenchmarkMetric>
  pass: boolean
}

const USER: SecurityActor = { kind: 'user', id: 'benchmark', agentRunId: null }
const eq = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `= ${want}`, pass: value === want, detail })
const atLeast = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≥ ${want}`, pass: value >= want, detail })
const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000)

interface Fixture {
  origin: string
  close(): void
}

/** The benchmark's target: each path exposes a different, known header set. */
function startFixtureSite(): Promise<Fixture> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const headers: Record<string, string> = { 'content-type': 'text/html' }
    if (path === '/apache') headers.server = 'Apache/2.4.41'
    else headers.server = 'nginx/1.18.0'
    if (path === '/powered') headers['x-powered-by'] = 'Express'
    res.writeHead(200, headers)
    res.end('<!doctype html><title>benchmark</title>')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, close: () => server.close() })))
}

interface Harness {
  db: Db
  service: SecurityService
  graph: GraphService
  reads: ReasoningService
  registry: CapabilityRegistry
  broker: CapabilityBroker
  runtime: ExecutionRuntime
  origin: string
}

function harness(db: Db, origin: string, registry: CapabilityRegistry, log?: Logger): Harness {
  const resolver: Resolver = async (host) => {
    if (host === '127.0.0.1' || host === 'localhost') return ['127.0.0.1']
    throw new Error(`unexpected DNS lookup of ${host}`)
  }
  const store = createDbSecurityStore(db)
  const executions = createDbExecutionStore(db)
  const runtime = new ExecutionRuntime({ registry, store, executions, resolver, pollIntervalMs: 100, log })
  // Executions run in this process as soon as the broker accepts them (no queue process needed).
  const broker = new CapabilityBroker({ registry, store, resolver, executions: { store: executions, queue: { enqueue: async (id) => (void runtime.run(id), id) } } })
  return { db, service: new SecurityService({ db, resolver }), graph: new GraphService({ db }), reads: new ReasoningService({ db }), registry, broker, runtime, origin }
}

async function engagement(h: Harness, name: string): Promise<string> {
  const created = await h.service.createEngagement({ name, targetUrl: `${h.origin}/`, environment: 'staging' }, USER)
  await h.service.requestAuthorization(created.id, { method: 'local-development' }, USER)
  return created.id
}

async function sensor(h: Harness, engagementId: string, capabilityId: string, path: string): Promise<void> {
  const outcome = await h.broker.submit({ engagementId, capabilityId, input: { url: `${h.origin}${path}` }, actor: USER })
  if (outcome.status !== 'queued') throw new Error(`${capabilityId} was not accepted: ${outcome.decision.reason}`)
  const store = createDbExecutionStore(h.db)
  for (let i = 0; i < 200; i++) {
    const row = await store.get(outcome.executionId)
    if (row && ['succeeded', 'failed', 'timed-out', 'cancelled', 'interrupted'].includes(row.status)) {
      if (row.status !== 'succeeded') throw new Error(`${capabilityId} ${row.status}`)
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`${capabilityId} did not finish`)
}

function engine(h: Harness, providers: ScriptedReasoningProvider[] | null): ReasoningEngine {
  if (!providers) return new ReasoningEngine({ db: h.db, broker: h.broker, ai: null, registry: h.registry })
  const registry = new ProviderRegistry()
  for (const p of providers) registry.register(p)
  return new ReasoningEngine({ db: h.db, broker: h.broker, ai: createReasoningAi(createProviderRouter(registry)), registry: h.registry })
}

async function reason(h: Harness, engagementId: string, providers: ScriptedReasoningProvider[] | null, mode: 'propose' | 'investigate' = 'investigate'): Promise<ReasoningRun> {
  const e = engine(h, providers)
  const started = await e.start(engagementId, { mode }, USER)
  return e.runToCompletion(started.id, { pollMs: 100, timeoutMs: 120_000 })
}

const scripted = (options: ScriptedReasonerOptions = {}) => [new ScriptedReasoningProvider(options)]

async function scenario(name: string, description: string, body: () => Promise<{ metrics: Record<string, BenchmarkMetric>; run: ReasoningRun | null }>): Promise<ScenarioResult> {
  const started = performance.now()
  try {
    const { metrics, run } = await body()
    return { name, description, metrics, pass: Object.values(metrics).every((m) => m.pass), run: run ? { status: run.status, stopReason: run.stopReason, aiCoverage: run.aiCoverage, usage: run.usage } : null, durationMs: Math.round(performance.now() - started) }
  } catch (error) {
    return { name, description, metrics: { error: { value: 1, target: '= 0', pass: false, detail: error instanceof Error ? error.message : String(error) } }, pass: false, run: null, durationMs: Math.round(performance.now() - started) }
  }
}

/** Hypotheses whose subjects all exist, whose cited evidence exists, and that are about an explicit unknown or cite evidence. */
async function precision(h: Harness, engagementId: string, hypotheses: SecurityHypothesis[]) {
  const nodes = new Set((await h.graph.nodes(engagementId, { limit: 1000 })).map((n) => n.id))
  const observations = new Set((await h.service.listObservations(engagementId)).map((o) => o.id))
  const grounded = hypotheses.filter((x) => x.subjectEntityIds.every((id) => nodes.has(id)) && x.supportingObservationIds.every((id) => observations.has(id)) && (x.supportingObservationIds.length > 0 || x.gapIds.length > 0))
  const subjects = hypotheses.map((x) => [...x.subjectEntityIds].sort().join(','))
  return { grounded: grounded.length, duplicates: subjects.length - new Set(subjects).size }
}

export async function runReasoningBenchmark(options: { db: Db; log?: Logger }): Promise<ReasoningBenchmarkResult> {
  const startedAt = new Date()
  const t0 = performance.now()
  const site = await startFixtureSite()
  const withDeepscan = harness(options.db, site.origin, createFixtureSensorRegistry({ deepscan: true }), options.log)
  const plain = harness(options.db, site.origin, createFixtureSensorRegistry(), options.log)
  const scenarios: ScenarioResult[] = []
  try {
    scenarios.push(
      await scenario('graph-construction', 'Two sensors report the same endpoint and technology: one entity each, both provenances kept, idempotent re-projection.', async () => {
        const h = plain
        const id = await engagement(h, 'bench: graph construction')
        await sensor(h, id, 'discovery.fixture-inspect', '/')
        await sensor(h, id, 'discovery.fixture-fingerprint', '/')
        await h.graph.project(id)
        const again = await h.graph.project(id)
        const nodes = await h.graph.nodes(id, { limit: 1000 })
        const tech = nodes.filter((n) => n.kind === 'technology' && n.label.toLowerCase() === 'nginx')
        const endpoints = nodes.filter((n) => n.kind === 'endpoint' && n.label === '/')
        const observations = await h.service.listObservations(id)
        const provenanceIds = new Set<string>()
        for (const n of nodes) for (const p of (await h.graph.node(n.id)).provenance) if (p.observationId) provenanceIds.add(p.observationId)
        return {
          run: null,
          metrics: {
            expectedEntities: eq(Number(nodes.some((n) => n.kind === 'host')) + endpoints.length + tech.length, 3, 'host, endpoint "/" and technology nginx exist'),
            duplicateEntities: eq(tech.length - 1 + (endpoints.length - 1), 0, 'the same entity from two sensors merges onto one'),
            corroboration: eq(tech[0]?.corroboration ?? 0, 2, 'both sensors are recorded on the merged technology'),
            provenancePreserved: eq(rate(observations.filter((o) => provenanceIds.has(o.id)).length, observations.length), 1, 'every observation is reachable from the graph provenance'),
            idempotentChanges: eq(again.nodes.added + again.nodes.updated + again.edges.added + again.edges.updated + again.provenance.added + again.provenance.updated, 0, 'a repeated projection changes nothing'),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('grounded-loop', 'A single-sensor technology: the loop proposes a grounded hypothesis, selects the cheapest capability that can corroborate it, and confirms it with new evidence.', async () => {
        const h = plain
        const id = await engagement(h, 'bench: grounded loop')
        await sensor(h, id, 'discovery.fixture-inspect', '/')
        const run = await reason(h, id, scripted())
        const hypotheses = await h.reads.hypotheses(id)
        const actions = await h.reads.actions(id)
        const executed = actions.filter((a) => a.status === 'completed' || a.status === 'failed')
        const useful = executed.filter((a) => a.capabilityId === 'discovery.fixture-fingerprint')
        const p = await precision(h, id, hypotheses)
        return {
          run,
          metrics: {
            hypothesisPrecision: eq(rate(p.grounded, hypotheses.length), 1, 'every stored hypothesis is grounded in existing entities and evidence'),
            resolved: eq(hypotheses.filter((x) => x.status === 'confirmed-signal').length, 1, 'the hypothesis is confirmed by independent evidence'),
            usefulNextAction: eq(rate(useful.length, executed.length), 1, 'the executed capability was one that could produce the missing evidence'),
            unnecessaryActions: eq(executed.length - useful.length, 0, 'no action was executed that could not help'),
            stopReason: eq(Number(run.stopReason === 'sufficient-evidence'), 1, `stopped: ${run.stopReason}`),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('adversarial-pressure', 'A researcher mixing grounded hypotheses with invented ids, invented evidence, restatements, claims beyond the graph, borrowed evidence and out-of-scope subjects; a planner proposing unregistered capabilities and raw arguments.', async () => {
        const h = plain
        const id = await engagement(h, 'bench: adversarial')
        await sensor(h, id, 'discovery.fixture-inspect', '/')
        await sensor(h, id, 'discovery.fixture-inspect', '/powered')
        const run = await reason(h, id, scripted({ researcher: 'adversarial', planner: 'invalid' }))
        const q = run.usage.quality
        const hypotheses = await h.reads.hypotheses(id)
        const p = await precision(h, id, hypotheses)
        const rejected = Object.values(q.hypothesesRejected).reduce((a, b) => a + b, 0)
        const adversarial = q.hypothesesProposed - q.hypothesesAccepted - q.hypothesesMerged
        return {
          run,
          metrics: {
            unsupportedHypothesisRate: eq(rate(hypotheses.length - p.grounded, hypotheses.length), 0, 'no stored hypothesis lacks support or references something that does not exist'),
            invalidProposalsRejected: eq(rate(rejected, adversarial), 1, `${rejected} of ${adversarial} invalid proposals rejected (${Object.entries(q.hypothesesRejected).map(([k, n]) => `${k} ${n}`).join(', ')})`),
            duplicateHypothesisRate: eq(rate(p.duplicates, hypotheses.length), 0, 'no two stored hypotheses concern the same entities'),
            groundedProposalAccepted: atLeast(q.hypothesesAccepted, 1, 'the grounded proposal survives among the adversarial ones'),
            invalidActionsRejected: atLeast(Object.values(q.actionsRejected).reduce((a, b) => a + b, 0), 2, `rejected: ${Object.entries(q.actionsRejected).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`),
            invalidActionsExecuted: eq(run.usage.actionsExecuted, 0, 'no invalid action reached the broker'),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('unnecessary-cost', 'A planner that prefers an expensive capability when a cheap one produces the same evidence.', async () => {
        const h = withDeepscan
        const id = await engagement(h, 'bench: expensive planner')
        await sensor(h, id, 'discovery.fixture-inspect', '/')
        const run = await reason(h, id, scripted({ planner: 'expensive' }))
        return {
          run,
          metrics: {
            unnecessaryExpensiveActions: eq((await h.reads.actions(id)).filter((a) => a.capabilityId === 'discovery.fixture-deepscan' && a.status !== 'rejected').length, 0, 'the expensive action was rejected as unnecessary'),
            rejectedAsUnnecessary: eq(run.usage.quality.actionsRejected['unnecessary-cost'] ?? 0, 1, 'recorded with its reason'),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('redundant-action', 'After a capability ran without resolving a hypothesis, a planner that proposes it again.', async () => {
        // The deep scan stays an untried option, so the hypothesis remains open and the planner gets to repeat itself.
        const h = withDeepscan
        const id = await engagement(h, 'bench: redundant')
        await sensor(h, id, 'discovery.fixture-fingerprint', '/powered')
        await sensor(h, id, 'discovery.fixture-inspect', '/powered')
        const run = await reason(h, id, scripted({ planner: 'redundant' }))
        const executed = (await h.reads.actions(id)).filter((a) => a.status === 'completed' || a.status === 'failed')
        const keys = executed.map((a) => a.actionKey)
        return {
          run,
          metrics: {
            redundantProposalsRejected: atLeast(run.usage.quality.actionsRejected['redundant'] ?? 0, 1, 'the repeated action was rejected as redundant'),
            redundantExecutions: eq(keys.length - new Set(keys).size, 0, 'the same action never runs twice for nothing'),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('prefers-unknown', 'A technology no other eligible sensor can corroborate: the loop must end with "we could not confirm it", not invent certainty.', async () => {
        const h = plain
        const id = await engagement(h, 'bench: unknown')
        await sensor(h, id, 'discovery.fixture-fingerprint', '/powered')
        await sensor(h, id, 'discovery.fixture-inspect', '/powered')
        const run = await reason(h, id, scripted())
        const hypotheses = await h.reads.hypotheses(id)
        const express = hypotheses.find((x) => /express/i.test(x.claim))
        return {
          run,
          metrics: {
            falselyConfirmed: eq(hypotheses.filter((x) => x.status === 'confirmed-signal' || x.status === 'supported').length, 0, 'nothing is called supported without evidence'),
            honestlyUnresolved: eq(Number(express?.status === 'exhausted'), 1, `express hypothesis ended ${express?.status ?? 'missing'}`),
            boundedActions: atLeast(run.budget.maxActions - run.usage.actionsExecuted, 0, `${run.usage.actionsExecuted} action(s) within the budget`),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('contradiction', 'Two web servers reported on one host: both facts are kept and marked contradicted, and the conflict is an explicit unknown.', async () => {
        const h = plain
        const id = await engagement(h, 'bench: contradiction')
        await sensor(h, id, 'discovery.fixture-inspect', '/')
        await sensor(h, id, 'discovery.fixture-inspect', '/apache')
        await h.graph.project(id)
        const techs = await h.graph.nodes(id, { kind: 'technology' })
        const gaps = await h.graph.gaps(id, 'open')
        return {
          run: null,
          metrics: {
            bothFactsKept: eq(techs.filter((t) => ['nginx', 'apache'].includes(t.label.toLowerCase())).length, 2, 'neither fact was discarded'),
            markedContradicted: eq(techs.filter((t) => t.status === 'contradicted').length, 2, 'both carry the conflict'),
            conflictIsUnknown: eq(gaps.filter((g) => g.kind === 'contradiction-unresolved').length, 1, 'the conflict is an open question'),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('ai-unavailable', 'No AI provider is available: deterministic graph, observations and coverage stay usable; only AI work pauses.', async () => {
        const h = plain
        const id = await engagement(h, 'bench: ai unavailable')
        await sensor(h, id, 'discovery.fixture-inspect', '/')
        const run = await reason(h, id, scripted({ health: 'unavailable' }))
        const coverage = await h.reads.coverage(id)
        return {
          run,
          metrics: {
            stoppedAsUnavailable: eq(Number(run.stopReason === 'provider-unavailable' && run.status === 'blocked'), 1, `${run.status}: ${run.stopReason}`),
            graphAvailable: atLeast(coverage.graph.entities, 3, 'graph entities projected without AI'),
            nothingInvented: eq(coverage.hypotheses.total, 0, 'no hypothesis without AI'),
          },
        }
      }),
    )

    scenarios.push(
      await scenario('provider-refusal', 'The preferred provider refuses: the refusal is recorded distinctly, never rerouted to the second provider, and nothing is persisted from it.', async () => {
        const h = plain
        const id = await engagement(h, 'bench: refusal')
        await sensor(h, id, 'discovery.fixture-inspect', '/')
        const refuser = new ScriptedReasoningProvider({ id: 'refuser', fail: { researcher: 'provider-refused' } })
        const backup = new ScriptedReasoningProvider({ id: 'backup' })
        const run = await reason(h, id, [refuser, backup])
        return {
          run,
          metrics: {
            refusedDistinctly: eq(Number(run.stopReason === 'provider-refused' && run.aiCoverage === 'provider-refused'), 1, `${run.stopReason} / ${run.aiCoverage}`),
            notRerouted: eq(backup.requests.length, 0, 'the second provider was never asked'),
            nothingPersisted: eq((await h.reads.hypotheses(id)).length, 0, 'no hypothesis from a refused task'),
          },
        }
      }),
    )
  } finally {
    await withDeepscan.runtime.shutdown().catch(() => undefined)
    await plain.runtime.shutdown().catch(() => undefined)
    site.close()
  }

  const all = scenarios.flatMap((s) => Object.entries(s.metrics).map(([k, m]) => ({ scenario: s.name, key: k, ...m })))
  const runs = scenarios.map((s) => s.run).filter((r): r is NonNullable<ScenarioResult['run']> => !!r)
  const aiCalls = runs.reduce((a, r) => a + r.usage.aiCalls, 0)
  const proposed = runs.reduce((a, r) => a + r.usage.quality.hypothesesProposed, 0)
  const accepted = runs.reduce((a, r) => a + r.usage.quality.hypothesesAccepted, 0)
  const summary: Record<string, BenchmarkMetric> = {
    scenariosPassed: eq(scenarios.filter((s) => s.pass).length, scenarios.length, `${scenarios.filter((s) => s.pass).length} of ${scenarios.length} scenarios`),
    metricsPassed: eq(all.filter((m) => m.pass).length, all.length, `${all.filter((m) => m.pass).length} of ${all.length} metrics`),
    acceptanceRate: { value: rate(accepted, proposed), target: 'informational', pass: true, detail: `${accepted} of ${proposed} model proposals survived validation` },
    aiCalls: { value: aiCalls, target: 'informational', pass: true, detail: 'AI calls across scenarios' },
    actionsExecuted: { value: runs.reduce((a, r) => a + r.usage.actionsExecuted, 0), target: 'informational', pass: true, detail: 'capability executions across scenarios' },
  }
  return { startedAt: startedAt.toISOString(), durationMs: Math.round(performance.now() - t0), scenarios, summary, pass: scenarios.every((s) => s.pass) }
}
