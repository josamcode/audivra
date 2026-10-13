import http from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getLogger } from '@audivra/config'
import type { ExecutionStatus, ReasoningRun, SecurityEngagementDetail, SecurityHypothesis } from '@audivra/contracts'
import { createBoss, ensureQueues, processStore, QUEUES, type PgBoss } from '@audivra/database'
import { createProviderRouter, createReasoningAi, ProviderRegistry, ScriptedReasoningProvider, type ScriptedReasonerOptions } from '@audivra/ai-runtime'
import {
  createDbExecutionStore,
  createDurableBroker,
  createFixtureSensorRegistry,
  GraphService,
  ReasoningEngine,
  ReasoningService,
  SecurityService,
  type CapabilityBroker,
  type Resolver,
} from '@audivra/security'
import { setProcessStore } from '@audivra/tool-runtime'
import { createSecurityExecutionWorker, type SecurityExecutionWorker } from '../src/security-executions.ts'
import { createSecurityReasoningWorker, type SecurityReasoningWorker } from '../src/security-reasoning.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * Phase 4 on the real stack (PostgreSQL + pg-boss + the worker), with deterministic fixture sensors and a
 * deterministic provider routed through the real ProviderRouter:
 *
 *   sensor observation → graph update → hypothesis → selected capability → broker → execution
 *   → new observation → graph update → hypothesis update
 *
 * plus idempotent projection, propose mode, AI unavailable, refusal (never rerouted), malformed output,
 * provider change and worker restart mid-run, deterministic rejection of adversarial model output, and the
 * broker remaining the execution authority.
 */

const handle = testDb()
const { db, pool } = handle
const log = getLogger()
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const resolver: Resolver = async (host) => {
  if (host === '127.0.0.1' || host === 'localhost') return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver })
const graph = new GraphService({ db })
const reasoningReads = new ReasoningService({ db })
const registry = createFixtureSensorRegistry({ deepscan: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let boss: PgBoss
let executions: SecurityExecutionWorker
let broker: CapabilityBroker
let settledHook: (id: string) => Promise<void> = async () => undefined
let site: { port: number; hits: () => number; close: () => void }

function startSite(): Promise<typeof site> {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    const headers = { 'content-type': 'text/html', server: 'nginx/1.18.0' }
    if (req.url === '/admin') {
      res.writeHead(401, headers)
      return res.end('unauthorized')
    }
    res.writeHead(200, headers)
    res.end('<!doctype html><title>Fixture</title><a href="/about">About</a>')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as import('node:net').AddressInfo).port, hits: () => hits, close: () => server.close() })))
}

async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 60_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`)
    await sleep(200)
  }
}

async function readyEngagement(name: string): Promise<SecurityEngagementDetail> {
  const created = await service.createEngagement({ name, targetUrl: `http://127.0.0.1:${site.port}/`, environment: 'staging' })
  return (await service.requestAuthorization(created.id, { method: 'local-development' })).engagement
}

async function runSensor(engagementId: string, capabilityId: string, path = '/'): Promise<string> {
  const outcome = await broker.submit({ engagementId, capabilityId, input: { url: `http://127.0.0.1:${site.port}${path}` }, actor: user })
  expect(outcome.status, outcome.decision.reason).toBe('queued')
  const done = await until(async () => {
    const row = await createDbExecutionStore(db).get(outcome.executionId)
    return row && (['succeeded', 'failed', 'timed-out', 'cancelled', 'interrupted'] as ExecutionStatus[]).includes(row.status) ? row : null
  }, 30_000, 'execution settled')
  expect(done.status, JSON.stringify(done.failure)).toBe('succeeded')
  return outcome.executionId
}

function engineWith(options: ScriptedReasonerOptions | ScriptedReasoningProvider[] | null, extra: { ownerId?: string } = {}): { engine: ReasoningEngine; providers: ScriptedReasoningProvider[] } {
  if (options === null) return { engine: new ReasoningEngine({ db, broker, ai: null, registry, ownerId: extra.ownerId }), providers: [] }
  const providers = Array.isArray(options) ? options : [new ScriptedReasoningProvider(options)]
  const reg = new ProviderRegistry()
  for (const p of providers) reg.register(p)
  return { engine: new ReasoningEngine({ db, broker, ai: createReasoningAi(createProviderRouter(reg)), registry, ownerId: extra.ownerId }), providers }
}

const hypotheses = (engagementId: string): Promise<SecurityHypothesis[]> => reasoningReads.hypotheses(engagementId)

beforeAll(async () => {
  site = await startSite()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  setProcessStore({
    insert: (r) => processStore.insert(db, r),
    finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
    listStale: (ownerId) => processStore.listStale(db, ownerId),
  })
  executions = createSecurityExecutionWorker({ db, boss, log, runtime: { registry, pollIntervalMs: 200, maxActive: 2 }, onSettled: (id) => settledHook(id) })
  broker = createDurableBroker({ db, boss, registry, resolver })
})

afterAll(async () => {
  await executions.shutdown()
  await boss.stop({ graceful: false })
  setProcessStore(null)
  site.close()
  await handle.close()
})

beforeEach(async () => {
  await boss.offWork(QUEUES.securityExecution).catch(() => undefined)
  await boss.offWork(QUEUES.securityReasoning).catch(() => undefined)
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
  await boss.deleteAllJobs()
  settledHook = async () => undefined
  await executions.start()
})

describe('Security Graph projection', () => {
  it('projects sensor observations into a provenance-carrying graph, idempotently', async () => {
    const engagement = await readyEngagement('graph projection')
    const executionId = await runSensor(engagement.id, 'discovery.fixture-inspect')
    const first = await graph.project(engagement.id)
    expect(first.nodes.added).toBeGreaterThanOrEqual(3)

    const nodes = await graph.nodes(engagement.id)
    const tech = nodes.find((n) => n.kind === 'technology' && n.label.toLowerCase() === 'nginx')!
    expect(tech).toMatchObject({ basis: 'observed', tools: ['probe-inspect'], corroboration: 1 })
    const endpoint = nodes.find((n) => n.kind === 'endpoint' && n.label === '/')!
    expect(endpoint.attributes.status).toBe(200)
    expect(endpoint.firstExecutionId).toBe(executionId)
    const detail = await graph.node(tech.id)
    expect(detail.provenance.length).toBeGreaterThan(0)
    expect(detail.provenance.every((p) => p.observationId && p.evidenceRefs.length > 0 && p.executionIds.includes(executionId))).toBe(true)
    const gaps = await graph.gaps(engagement.id, 'open')
    expect(gaps.some((g) => g.kind === 'technology-uncorroborated' && g.subjectId === tech.id)).toBe(true)

    // Re-projection over the same observations changes nothing: no row is rewritten, no event recorded.
    const before = (await pool.query('select id, updated_at from security_graph_nodes order by id')).rows
    const events = (await service.listEvents(engagement.id)).length
    for (let i = 0; i < 3; i++) {
      const again = await graph.project(engagement.id)
      expect(again.nodes).toMatchObject({ added: 0, updated: 0 })
      expect(again.edges).toMatchObject({ added: 0, updated: 0 })
      expect(again.provenance).toEqual({ added: 0, updated: 0 })
      expect(again.gaps).toEqual({ opened: 0, resolved: 0 })
    }
    expect((await pool.query('select id, updated_at from security_graph_nodes order by id')).rows).toEqual(before)
    expect((await service.listEvents(engagement.id)).length).toBe(events)

    // A second sensor reporting the same technology merges onto the same entity, keeping both provenances.
    await runSensor(engagement.id, 'discovery.fixture-fingerprint')
    await graph.project(engagement.id)
    const merged = (await graph.nodes(engagement.id, { kind: 'technology' })).filter((n) => n.label.toLowerCase() === 'nginx')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ tools: ['probe-fingerprint', 'probe-inspect'], corroboration: 2 })
    expect((await graph.gaps(engagement.id)).find((g) => g.subjectId === tech.id && g.kind === 'technology-uncorroborated')).toMatchObject({ status: 'resolved' })
  })
})

describe('the bounded reasoning loop', () => {
  let reasoning: SecurityReasoningWorker
  afterAll(async () => reasoning?.stop())

  it('gathers new evidence through the broker and updates the hypothesis (worker-driven, investigate mode)', async () => {
    const providers = new ProviderRegistry().register(new ScriptedReasoningProvider())
    reasoning = createSecurityReasoningWorker({ db, boss, log, registry, providers, resolver })
    settledHook = (id) => reasoning.executionSettled(id)
    await reasoning.start()

    const engagement = await readyEngagement('reasoning loop')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    await until(async () => (await graph.nodes(engagement.id)).length > 0, 10_000, 'graph projected by the post-execution hook')

    const started = await reasoning.engine.start(engagement.id, { mode: 'investigate' }, user)
    const run = await until(async () => {
      const r = await reasoningReads.run(started.id)
      return ['completed', 'blocked', 'failed', 'cancelled'].includes(r.status) ? r : null
    }, 90_000, 'reasoning run finished')
    expect(run.status, JSON.stringify(run.decisions.slice(-4))).toBe('completed')
    expect(run.stopReason).toBe('sufficient-evidence')
    expect(run.aiCoverage).toBe('completed')

    const [h] = (await hypotheses(engagement.id)).filter((x) => x.category === 'technology')
    expect(h).toBeTruthy()
    expect(h!.status).toBe('confirmed-signal')
    expect(h!.history.map((t) => t.to)).toEqual(expect.arrayContaining(['proposed', 'needs-evidence', 'confirmed-signal']))
    expect(h!.review.verdict).toBe('reasonable')
    expect(h!.checkResults.find((r) => r.effect === 'supports')).toMatchObject({ met: true, tools: ['probe-fingerprint', 'probe-inspect'] })

    // The selected capability ran through the broker as an agent request, and its evidence reached the graph.
    const actions = await reasoningReads.actions(engagement.id, run.id)
    const executed = actions.find((a) => a.status === 'completed')!
    expect(executed).toMatchObject({ capabilityId: 'discovery.fixture-fingerprint', hypothesisId: h!.id })
    const execution = (await createDbExecutionStore(db).get(executed.executionId!))!
    expect(execution.requestedBy).toMatchObject({ kind: 'agent', agentRunId: run.id })
    expect(execution.correlationId).toBe(executed.id)
    const tech = (await graph.nodes(engagement.id, { kind: 'technology' })).find((n) => n.label.toLowerCase() === 'nginx')!
    expect(tech.corroboration).toBe(2)

    // Concise, persisted rationale and timeline — no hidden chain-of-thought.
    expect(run.decisions.length).toBeGreaterThan(4)
    expect(run.usage).toMatchObject({ actionsExecuted: 1, iterations: 0 })
    expect(run.usage.aiCalls).toBeGreaterThanOrEqual(3)
    expect(run.usage.providers['scripted-reasoner']).toBeGreaterThanOrEqual(3)
    const types = (await service.listEvents(engagement.id)).map((e) => e.type)
    for (const t of ['reasoning.started', 'hypothesis.proposed', 'reasoning.action-proposed', 'reasoning.action-executed', 'hypothesis.updated', 'reasoning.completed', 'graph.entity-discovered']) expect(types, t).toContain(t)

    // Coverage is reasoning coverage, not a score.
    const coverage = await reasoningReads.coverage(engagement.id)
    expect(coverage.hypotheses).toMatchObject({ total: 1, investigated: 1 })
    expect(coverage.graph.technologiesCorroborated.corroborated).toBeGreaterThanOrEqual(1)
    expect(coverage.latestRun).toMatchObject({ id: run.id, stopReason: 'sufficient-evidence' })
  }, 150_000)

  it('propose mode plans and preflights but never executes', async () => {
    const engagement = await readyEngagement('propose mode')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    const { engine } = engineWith({})
    const before = (await createDbExecutionStore(db).listForEngagement(engagement.id)).length
    const run = await engine.runToCompletion((await engine.start(engagement.id, {}, user)).id)
    expect(run).toMatchObject({ status: 'completed', stopReason: 'awaiting-approval', mode: 'propose' })
    const actions = await reasoningReads.actions(engagement.id, run.id)
    expect(actions.map((a) => a.status)).toEqual(['approved-by-policy'])
    expect(actions[0]!.decision).toMatchObject({ decision: 'allow' })
    expect((await createDbExecutionStore(db).listForEngagement(engagement.id)).length).toBe(before)
  })
})

describe('provider resilience', () => {
  it('AI unavailable: graph, observations and existing hypotheses stay usable; only AI work pauses', async () => {
    const engagement = await readyEngagement('ai unavailable')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    const { engine } = engineWith({ health: 'unavailable' })
    const run = await engine.runToCompletion((await engine.start(engagement.id, { mode: 'investigate' }, user)).id)
    expect(run).toMatchObject({ status: 'blocked', stopReason: 'provider-unavailable', aiCoverage: 'provider-unavailable' })
    expect((await graph.nodes(engagement.id)).length).toBeGreaterThan(0)
    expect((await graph.gaps(engagement.id, 'open')).length).toBeGreaterThan(0)
    expect(await hypotheses(engagement.id)).toEqual([])

    // AI turned off entirely behaves the same way, and a later run with AI resumes from stored knowledge.
    const off = engineWith(null).engine
    expect(await off.runToCompletion((await off.start(engagement.id, {}, user)).id)).toMatchObject({ status: 'blocked', stopReason: 'provider-unavailable' })
    const on = engineWith({}).engine
    const resumed = await on.runToCompletion((await on.start(engagement.id, {}, user)).id)
    expect(resumed.stopReason).toBe('awaiting-approval')
    expect((await hypotheses(engagement.id)).length).toBe(1)
  })

  it('a refusal is recorded distinctly, never rerouted to another provider, and corrupts nothing', async () => {
    const engagement = await readyEngagement('refusal')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    const refuser = new ScriptedReasoningProvider({ id: 'refuser', fail: { researcher: 'provider-refused' } })
    const backup = new ScriptedReasoningProvider({ id: 'backup' })
    const { engine } = engineWith([refuser, backup])
    const nodes = (await pool.query('select id, updated_at from security_graph_nodes order by id')).rows
    const run = await engine.runToCompletion((await engine.start(engagement.id, { mode: 'investigate' }, user)).id)
    expect(run).toMatchObject({ status: 'blocked', stopReason: 'provider-refused', aiCoverage: 'provider-refused' })
    expect(backup.requests).toHaveLength(0)
    expect(run.aiRuns.map((p) => [p.providerId, p.outcome])).toEqual([['refuser', 'provider-refused']])
    expect(await hypotheses(engagement.id)).toEqual([])
    const projectedNodes = (await pool.query('select id from security_graph_nodes order by id')).rows.map((r: { id: string }) => r.id)
    expect(projectedNodes).toEqual(expect.arrayContaining(nodes.map((r: { id: string }) => r.id)))
  })

  it('malformed structured output is rejected before anything is persisted', async () => {
    const engagement = await readyEngagement('malformed')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    const { engine } = engineWith({ fail: { researcher: 'malformed' } })
    const run = await engine.runToCompletion((await engine.start(engagement.id, {}, user)).id)
    expect(await hypotheses(engagement.id)).toEqual([])
    expect(run).toMatchObject({ status: 'blocked', stopReason: 'ai-output-invalid', aiCoverage: 'partial' })
    expect(run.aiRuns.some((p) => p.outcome === 'invalid-structured-output' && p.outputStatus === 'invalid')).toBe(true)
    expect((await graph.nodes(engagement.id)).length).toBeGreaterThan(0)
  })

  it('a transient provider failure falls back to the next eligible provider', async () => {
    const engagement = await readyEngagement('fallback')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    const flaky = new ScriptedReasoningProvider({ id: 'flaky', fail: { researcher: 'provider-timeout', planner: 'provider-timeout', verifier: 'provider-timeout' } })
    const steady = new ScriptedReasoningProvider({ id: 'steady' })
    const { engine } = engineWith([flaky, steady])
    const run = await engine.runToCompletion((await engine.start(engagement.id, {}, user)).id)
    expect(run.stopReason).toBe('awaiting-approval')
    expect(run.aiRuns.map((p) => p.providerId)).toEqual(expect.arrayContaining(['flaky', 'steady']))
    expect((await hypotheses(engagement.id))[0]!.origin.providerId).toBe('steady')
  })

  it('survives a worker restart, a lost session and a provider change mid-run', async () => {
    const engagement = await readyEngagement('restart')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    // Worker A drives the run until it waits for its execution, then "dies" (its lease is left behind).
    const a = engineWith({ id: 'provider-a' }, { ownerId: 'worker-a' })
    const started = await a.engine.start(engagement.id, { mode: 'investigate' }, user)
    const parked = (await a.engine.drive(started.id))!
    expect(parked).toMatchObject({ status: 'waiting', stage: 'await' })
    await pool.query(`update security_reasoning_runs set status = 'running', lease_owner = 'worker-a', heartbeat_at = now() - interval '10 minutes' where id = $1`, [started.id])
    await until(async () => (await a.engine.readyToResume(started.id)) || (await pool.query('select 1 from security_executions where engagement_id = $1 and status = $2', [engagement.id, 'succeeded'])).rowCount! >= 2, 30_000, 'execution done')

    // Worker B (a different provider, no shared session) recovers the run and finishes it from stored state.
    const b = engineWith({ id: 'provider-b' }, { ownerId: 'worker-b' })
    expect(await b.engine.recover()).toContain(started.id)
    const finished: ReasoningRun = await b.engine.runToCompletion(started.id)
    expect(finished).toMatchObject({ status: 'completed', stopReason: 'sufficient-evidence' })
    const providersUsed = new Set(finished.aiRuns.map((p) => p.providerId))
    expect([...providersUsed].sort()).toEqual(['provider-a', 'provider-b'])
    expect(new Set(a.providers[0]!.requests.map((r) => r.resumeSessionId ?? null))).toEqual(new Set([null]))
    expect((await hypotheses(engagement.id))[0]!.status).toBe('confirmed-signal')
  })
})

describe('validation pressure and execution authority', () => {
  it('rejects invented ids, borrowed evidence, restatements, claims beyond the graph and invalid actions', async () => {
    const engagement = await readyEngagement('adversarial')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    await runSensor(engagement.id, 'discovery.fixture-inspect', '/admin')
    const { engine } = engineWith({ researcher: 'adversarial', planner: 'invalid' })
    const run = await engine.runToCompletion((await engine.start(engagement.id, { mode: 'investigate' }, user)).id)
    const q = run.usage.quality
    expect(q.hypothesesAccepted).toBe(1)
    expect(q.hypothesesRejected).toMatchObject({ 'unknown-entity': 1, 'unknown-evidence': 1, 'claim-outside-graph': 1 })
    expect(q.hypothesesRejected['restated-in-batch']).toBe(1)
    expect(q.hypothesesRejected['unrelated-evidence']).toBe(1)
    const stored = await hypotheses(engagement.id)
    expect(stored).toHaveLength(1)
    expect(stored.flatMap((h) => h.subjectEntityIds).every((id) => id !== 'gn_00000000000000')).toBe(true)
    expect(q.actionsRejected['unknown-capability']).toBeGreaterThanOrEqual(1)
    expect(q.actionsRejected['invalid-input']).toBeGreaterThanOrEqual(1)
    expect(run.stopReason).toBe('no-eligible-capability')
    expect(run.usage.actionsExecuted).toBe(0)
  })

  it('rejects an unnecessarily expensive action when a cheaper one produces the same evidence', async () => {
    const engagement = await readyEngagement('expensive')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    const { engine } = engineWith({ planner: 'expensive' })
    const run = await engine.runToCompletion((await engine.start(engagement.id, { mode: 'investigate' }, user)).id)
    expect(run.usage.quality.actionsRejected['unnecessary-cost']).toBe(1)
    expect(run.usage.actionsExecuted).toBe(0)
  })

  it('the broker remains the execution authority: withdrawn authorization blocks every planned action', async () => {
    const engagement = await readyEngagement('authority')
    await runSensor(engagement.id, 'discovery.fixture-inspect')
    await service.revokeAuthorization(engagement.id, engagement.authorizations[0]!.id)
    const hitsBefore = site.hits()
    const { engine } = engineWith({})
    const run = await engine.runToCompletion((await engine.start(engagement.id, { mode: 'investigate' }, user)).id)
    expect(run).toMatchObject({ status: 'completed', stopReason: 'policy-blocked' })
    const actions = await reasoningReads.actions(engagement.id, run.id)
    expect(actions.map((a) => a.status)).toEqual(['blocked'])
    expect(actions[0]!.decision).toMatchObject({ decision: 'deny', stage: 'authorization' })
    expect((await hypotheses(engagement.id))[0]!.status).toBe('blocked')
    expect(site.hits()).toBe(hitsBefore)
  })

  it('agents cannot start reasoning, and budgets are clamped to strict ceilings', async () => {
    const engagement = await readyEngagement('limits')
    const { engine } = engineWith({})
    await expect(engine.start(engagement.id, {}, { kind: 'agent', id: 'x', agentRunId: 'y' })).rejects.toThrow(/Agents cannot/)
    await expect(engine.start(engagement.id, { budget: { maxIterations: 50 } }, user)).rejects.toThrow()
    const run = await engine.start(engagement.id, { budget: { maxIterations: 1, maxActions: 0 } }, user)
    expect(run.budget).toMatchObject({ maxIterations: 1, maxActions: 0 })
    await expect(engine.start(engagement.id, {}, user)).rejects.toThrow(/already in progress/)
    expect((await engine.cancel(run.id, user)).status).toBe('cancelled')
  })
})
