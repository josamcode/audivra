import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getLogger } from '@audivra/config'
import type {
  GraphProjectionResult,
  KnowledgeGap,
  ReasoningCoverage,
  ReasoningRun,
  SecurityEngagementDetail,
  SecurityGraphEdge,
  SecurityGraphNeighborhood,
  SecurityGraphNode,
  SecurityGraphNodeDetail,
  SecurityGraphSummary,
  SecurityObservation,
} from '@audivra/contracts'
import { createBoss, ensureQueues, QUEUES, type PgBoss } from '@audivra/database'
import { createDbSecurityStore, SecurityService, type Resolver } from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The Phase 4 API on the real database: bounded graph reads (entities, relationships, neighbourhoods,
 * provenance, evidence, unknowns), an idempotent deterministic rebuild, hypotheses, and reasoning runs
 * that can be started (strict input) and cancelled — but no endpoint that executes a capability or runs a
 * prompt, and every response redacted.
 */

const handle = testDb()
const { db, pool } = handle
const resolver: Resolver = async (host) => {
  if (host === '127.0.0.1' || host === 'localhost') return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}
const service = new SecurityService({ db, resolver })
const store = createDbSecurityStore(db)
const ORIGIN = 'http://127.0.0.1:4555'

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>

async function api<T = unknown>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: T; text: string }> {
  const response = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) })
  return { status: response.statusCode, body: (response.headers['content-type']?.includes('json') ? response.json() : null) as T, text: response.body }
}

async function observe(engagementId: string, input: { type: SecurityObservation['type']; asset: string; subject: string; title: string; value?: Record<string, unknown>; tool?: string; sourceType?: SecurityObservation['sourceType']; confidence?: number }) {
  const evidence = await store.recordEvidence({
    engagementId,
    source: 'system',
    type: 'tool-result',
    title: `${input.tool ?? 'httpx'} output`,
    summary: 'fixture',
    provenance: { engagementId, executionId: 'sx_fixture0000001', correlationId: 'c', capabilityId: 'discovery.http-inspect', capabilityVersion: 1, implementation: 'x', decisionEventId: null, environment: 'staging', scopeVersion: 1, scopeHash: 'h', configVersion: 1, policyProfile: { key: 'k', version: 1 }, authorizationIds: [], sensitivity: 'normal', identityRef: null, sessionRef: null },
  })
  return store.recordObservation({
    engagementId,
    dedupeKey: `${input.type}:${input.asset}:${input.subject}`,
    type: input.type,
    asset: input.asset,
    subject: input.subject,
    title: input.title,
    scopeClass: null,
    value: input.value ?? {},
    sourceType: input.sourceType ?? 'tool-reported',
    contribution: { executionId: 'sx_fixture0000001', capabilityId: 'discovery.http-inspect', tool: input.tool ?? 'httpx', toolVersion: 'httpx@sha256:x', evidenceRef: evidence.ref, confidence: input.confidence ?? 1, identityRef: null, sessionRef: null, at: new Date().toISOString() },
  })
}

async function engagementWithObservations(): Promise<SecurityEngagementDetail> {
  const engagement = await service.createEngagement({ name: 'graph api', targetUrl: `${ORIGIN}/`, environment: 'staging' })
  await observe(engagement.id, { type: 'http-response', asset: `${ORIGIN}/`, subject: 'response', title: 'HTTP 200', value: { status: 200 } })
  await observe(engagement.id, { type: 'http-header', asset: `${ORIGIN}/`, subject: 'server', title: 'Server: nginx/1.18.0', value: { header: 'server', value: 'nginx/1.18.0 api_key=supersecretvalue123' } })
  await observe(engagement.id, { type: 'technology', asset: `${ORIGIN}/`, subject: 'Nginx', title: 'Technology: Nginx', value: { technology: 'Nginx:1.18.0' }, sourceType: 'tool-inferred', confidence: 0.9 })
  await observe(engagement.id, { type: 'redirect', asset: `${ORIGIN}/old`, subject: `${ORIGIN}/admin`, title: 'Redirect 302', value: { status: 302, destination: `${ORIGIN}/admin`, followed: false } })
  await observe(engagement.id, { type: 'form', asset: `${ORIGIN}/contact`, subject: 'post /send', title: 'Form POST', value: { method: 'post', action: '/send', parameters: ['email', 'message'] }, tool: 'katana' })
  return engagement
}

beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: getLogger(), security: service })
})

afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})

beforeEach(async () => {
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
  await boss.deleteAllJobs()
})

describe('Security Graph API', () => {
  it('rebuilds deterministically and serves bounded, provenance-carrying reads', async () => {
    const engagement = await engagementWithObservations()
    const first = await api<GraphProjectionResult>('POST', `/api/security/engagements/${engagement.id}/graph/project`)
    expect(first.status).toBe(200)
    expect(first.body.nodes.added).toBeGreaterThan(5)
    const again = await api<GraphProjectionResult>('POST', `/api/security/engagements/${engagement.id}/graph/project`)
    expect(again.body.nodes).toMatchObject({ added: 0, updated: 0 })

    const summary = (await api<SecurityGraphSummary>('GET', `/api/security/engagements/${engagement.id}/graph/summary`)).body
    expect(summary.byKind).toMatchObject({ host: 1, technology: 1, parameter: 2 })
    expect(summary.byRelation).toMatchObject({ HOSTS: expect.any(Number), DEPENDS_ON: 1, REDIRECTS_TO: 1, CALLS: 1, READS: 2 })
    expect(summary.gaps.open).toBeGreaterThan(0)

    const nodes = (await api<SecurityGraphNode[]>('GET', `/api/security/engagements/${engagement.id}/graph/nodes?kind=endpoint`)).body
    expect(nodes.map((n) => n.label).sort()).toEqual(['/', '/admin', '/contact', '/old', '/send'])
    expect((await api<SecurityGraphNode[]>('GET', `/api/security/engagements/${engagement.id}/graph/nodes?q=admin`)).body.map((n) => n.label)).toEqual(['/admin'])
    const edges = (await api<SecurityGraphEdge[]>('GET', `/api/security/engagements/${engagement.id}/graph/edges?type=REDIRECTS_TO`)).body
    expect(edges).toHaveLength(1)
    expect(edges[0]!.toKey).toBe(`endpoint:${ORIGIN}/admin`)

    // Explicit unknowns: the redirect target was never inspected; the form target's authentication is unknown.
    const gaps = (await api<KnowledgeGap[]>('GET', `/api/security/engagements/${engagement.id}/graph/gaps?status=open`)).body
    const admin = nodes.find((n) => n.label === '/admin')!
    expect(gaps.find((g) => g.subjectId === admin.id)).toMatchObject({ kind: 'endpoint-behavior-unknown', status: 'open' })
    expect(gaps.some((g) => g.kind === 'authentication-requirement-unknown')).toBe(true)

    // Entity detail: relationships, why Audivra believes it, and redaction.
    const tech = (await api<SecurityGraphNode[]>('GET', `/api/security/engagements/${engagement.id}/graph/nodes?kind=technology`)).body[0]!
    const detail = await api<SecurityGraphNodeDetail>('GET', `/api/security/graph/nodes/${tech.id}`)
    expect(detail.body.neighbors[0]).toMatchObject({ direction: 'in', edge: { type: 'DEPENDS_ON' }, node: { kind: 'host' } })
    expect(detail.body.provenance.map((p) => p.source).sort()).toEqual(['derivation', 'observation'])
    expect(detail.body.provenance.every((p) => p.evidenceRefs.length > 0)).toBe(true)
    const root = nodes.find((n) => n.label === '/')!
    const rootDetail = await api('GET', `/api/security/graph/nodes/${root.id}`)
    expect(rootDetail.text).not.toContain('supersecretvalue123')
    expect((await api<SecurityObservation[]>('GET', `/api/security/graph/nodes/${tech.id}/observations`)).body.map((o) => o.type).sort()).toEqual(['http-header', 'technology'])
    expect((await api<unknown[]>('GET', `/api/security/graph/nodes/${tech.id}/evidence`)).body.length).toBe(2)

    // Neighbourhoods are bounded to two hops.
    const hood = (await api<SecurityGraphNeighborhood>('GET', `/api/security/graph/nodes/${tech.id}/neighborhood?depth=9`)).body
    expect(hood.depth).toBe(2)
    expect(hood.nodes.some((n) => n.label === '/admin')).toBe(true)
    expect((await api('GET', '/api/security/graph/nodes/gn_doesnotexist00')).status).toBe(404)
    expect((await api('GET', '/api/security/graph/nodes/..%2f..%2fetc')).status).toBe(404)
  })
})

describe('reasoning API', () => {
  it('starts a bounded run with strict input, refuses a second one, and cancels', async () => {
    const engagement = await engagementWithObservations()
    expect((await api('POST', `/api/security/engagements/${engagement.id}/reasoning/runs`, { capabilityId: 'discovery.http-inspect', input: { url: ORIGIN } })).status).toBe(400)
    expect((await api('POST', `/api/security/engagements/${engagement.id}/reasoning/runs`, { mode: 'investigate', budget: { maxActions: 99 } })).status).toBe(400)
    const started = await api<ReasoningRun>('POST', `/api/security/engagements/${engagement.id}/reasoning/runs`, { mode: 'propose', budget: { maxIterations: 2 } })
    expect(started.status).toBe(201)
    expect(started.body).toMatchObject({ status: 'queued', mode: 'propose', budget: { maxIterations: 2 }, requestedBy: { kind: 'user' } })
    const jobs = await pool.query('select data from pgboss.job where name = $1', [QUEUES.securityReasoning])
    expect(jobs.rows.map((r: { data: unknown }) => r.data)).toEqual([{ runId: started.body.id }])
    expect((await api('POST', `/api/security/engagements/${engagement.id}/reasoning/runs`, {})).status).toBe(409)

    expect((await api<ReasoningRun[]>('GET', `/api/security/engagements/${engagement.id}/reasoning/runs`)).body.map((r) => r.id)).toEqual([started.body.id])
    const cancelled = await api<ReasoningRun>('POST', `/api/security/reasoning/runs/${started.body.id}/cancel`)
    expect(cancelled.status).toBe(202)
    expect(cancelled.body).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' })
    const events = (await service.listEvents(engagement.id)).map((e) => e.type)
    expect(events).toEqual(expect.arrayContaining(['reasoning.started', 'reasoning.completed']))
  })

  it('serves hypotheses, actions and reasoning coverage, and offers no way to execute anything', async () => {
    const engagement = await engagementWithObservations()
    await api('POST', `/api/security/engagements/${engagement.id}/graph/project`)
    expect((await api('GET', `/api/security/engagements/${engagement.id}/hypotheses`)).body).toEqual([])
    expect((await api('GET', `/api/security/engagements/${engagement.id}/hypotheses?status=nonsense`)).status).toBe(400)
    expect((await api('GET', '/api/security/hypotheses/hy_00000000000000')).status).toBe(404)
    expect((await api('GET', `/api/security/engagements/${engagement.id}/reasoning/actions`)).body).toEqual([])

    const coverage = (await api<ReasoningCoverage>('GET', `/api/security/engagements/${engagement.id}/reasoning/coverage`)).body
    expect(coverage.graph.entities).toBeGreaterThan(5)
    expect(coverage.graph.technologiesCorroborated).toEqual({ corroborated: 0, total: 1 })
    expect(coverage.graph.endpointsInspected.total).toBeGreaterThan(coverage.graph.endpointsInspected.known)
    expect(coverage.hypotheses.total).toBe(0)
    expect(coverage.latestRun).toBeNull()
    expect(JSON.stringify(coverage)).not.toMatch(/score/i)

    for (const path of [
      `/api/security/engagements/${engagement.id}/reasoning/actions`,
      `/api/security/engagements/${engagement.id}/reasoning/execute`,
      `/api/security/engagements/${engagement.id}/reasoning/prompt`,
      `/api/security/engagements/${engagement.id}/hypotheses`,
      '/api/security/hypotheses/hy_00000000000000/execute',
      '/api/security/reasoning/actions/ra_00000000000000/run',
    ]) {
      expect((await api('POST', path, { capabilityId: 'discovery.http-inspect', input: { url: ORIGIN } })).status, path).toBe(404)
    }
  })
})
