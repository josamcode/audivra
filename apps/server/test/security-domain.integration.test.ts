import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getLogger } from '@audivra/config'
import type { SecurityDomainDeclaration, SecurityEngagementDetail, SecurityGraphEdge, SecurityGraphNode } from '@audivra/contracts'
import { createBoss, ensureQueues, recordSecurityObservation, type PgBoss } from '@audivra/database'
import { DomainService, GraphService, identityKey, roleKey, SecurityService, tenantKey, type Resolver } from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * Phase 5 Step 1 on the real database: declaring the application-semantics domain (identities, roles,
 * tenants, resources, business states), projecting it into the Phase 4 Security Graph with provenance,
 * idempotency, the credentialRef never reaching a graph node, configuration-actor enforcement (agents
 * refused), redaction, co-existence with Phase 4 observations, and the read-only API.
 */

const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const resolver: Resolver = async () => ['127.0.0.1']
const service = new SecurityService({ db, resolver })
const domain = new DomainService({ db })
const graph = new GraphService({ db })
const ORIGIN = 'http://127.0.0.1:4777'

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>

async function engagement(name: string): Promise<SecurityEngagementDetail> {
  return service.createEngagement({ name, targetUrl: `${ORIGIN}/`, environment: 'staging' }, user)
}

async function api<T = unknown>(url: string): Promise<{ status: number; body: T; text: string }> {
  const r = await app.inject({ method: 'GET', url })
  return { status: r.statusCode, body: (r.headers['content-type']?.includes('json') ? r.json() : null) as T, text: r.body }
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
})

describe('domain declarations → Security Graph', () => {
  it('declares a tenant, role, identity and resource, and projects them with declared provenance — idempotently', async () => {
    const e = await engagement('acme engagement')
    await domain.declare(e.id, { kind: 'tenant', ref: 'acme', spec: { externalId: 'org_1' } }, user)
    await domain.declare(e.id, { kind: 'role', ref: 'admin', spec: { permits: [] } }, user)
    await domain.declare(e.id, { kind: 'identity', ref: 'alice', spec: { identityType: 'user', authMethod: 'form', credentialRef: 'vault://acme/alice', roleRefs: ['admin'], tenantRef: 'acme' } }, user)
    await domain.declare(e.id, { kind: 'resource', ref: 'inv1', spec: { resourceType: 'invoice', externalId: 'INV-1', tenantRef: 'acme', ownerRef: 'alice', testData: 'test-owned' } }, user)

    const first = await graph.project(e.id)
    expect(first.nodes.added).toBe(4)
    expect(first.addedByKind).toMatchObject({ identity: 1, role: 1, tenant: 1, resource: 1 })
    expect(first.edges.added).toBeGreaterThanOrEqual(4) // HAS_ROLE, 2× BELONGS_TO_TENANT, OWNS

    const nodes = await graph.nodes(e.id)
    const alice = nodes.find((n) => n.key === identityKey('alice'))!
    expect(alice).toMatchObject({ kind: 'identity', basis: 'declared', confidence: 1, status: 'active' })
    expect(alice.attributes).toMatchObject({ credentialConfigured: true, authMethod: 'form' })

    // The declaration's provenance points back at it; no observation, evidence or tool.
    const detail = await graph.node(alice.id)
    expect(detail.provenance).toHaveLength(1)
    expect(detail.provenance[0]).toMatchObject({ source: 'user-declaration', trust: 'user-declaration', observationId: null, tools: [], evidenceRefs: [] })
    expect(detail.neighbors.map((n) => n.edge.type).sort()).toEqual(['BELONGS_TO_TENANT', 'HAS_ROLE', 'OWNS'])

    // Idempotency: re-projecting changes nothing and rewrites no row.
    const before = (await pool.query('select id, updated_at from security_graph_nodes order by id')).rows
    for (let i = 0; i < 3; i++) {
      const again = await graph.project(e.id)
      expect(again.nodes).toMatchObject({ added: 0, updated: 0 })
      expect(again.edges).toMatchObject({ added: 0, updated: 0 })
      expect(again.provenance).toEqual({ added: 0, updated: 0 })
    }
    expect((await pool.query('select id, updated_at from security_graph_nodes order by id')).rows).toEqual(before)
  })

  it('never writes a credentialRef onto a graph node', async () => {
    const e = await engagement('creds')
    await domain.declare(e.id, { kind: 'identity', ref: 'svc', spec: { authMethod: 'api-token', credentialRef: 'vault://acme/svc-token-pointer' } }, user)
    await graph.project(e.id)
    const node = (await graph.nodes(e.id, { kind: 'identity' }))[0]!
    const full = await graph.node(node.id)
    expect(node.attributes.credentialConfigured).toBe(true)
    expect(JSON.stringify(full)).not.toContain('vault://acme/svc-token-pointer')
    // The pointer stays only in the declaration spec (operational table), not in the graph.
    const nodeRows = await pool.query('select attributes from security_graph_nodes where engagement_id = $1', [e.id])
    expect(JSON.stringify(nodeRows.rows)).not.toContain('vault://acme/svc-token-pointer')
  })

  it('co-exists with Phase 4 observations without disturbing them', async () => {
    const e = await engagement('mixed')
    await recordSecurityObservation(db, {
      engagementId: e.id,
      dedupeKey: `http-response:${ORIGIN}/:response`,
      type: 'http-response',
      asset: `${ORIGIN}/`,
      subject: 'response',
      title: 'HTTP 200',
      scopeClass: 'in-scope',
      value: { status: 200 },
      sourceType: 'tool-reported',
      contribution: { executionId: 'sx_fixture0000001', capabilityId: 'discovery.http-inspect', tool: 'httpx', toolVersion: 'v', evidenceRef: null, confidence: 1, identityRef: null, sessionRef: null, at: new Date().toISOString() },
    })
    await domain.declare(e.id, { kind: 'identity', ref: 'alice', spec: {} }, user)
    await graph.project(e.id)

    const nodes = await graph.nodes(e.id)
    const endpoint = nodes.find((n) => n.kind === 'endpoint')!
    expect(endpoint).toMatchObject({ basis: 'observed' })
    expect(endpoint.attributes.status).toBe(200)
    expect(nodes.find((n) => n.kind === 'identity')).toMatchObject({ basis: 'declared' })
    // A re-projection with both sources present is still a no-op.
    expect((await graph.project(e.id)).nodes).toMatchObject({ added: 0, updated: 0 })
  })

  it('refuses an agent, rejects duplicates and invalid input, and redacts secrets in the spec', async () => {
    const e = await engagement('guards')
    await expect(domain.declare(e.id, { kind: 'identity', ref: 'x', spec: {} }, { kind: 'agent', id: 'a', agentRunId: 'r' })).rejects.toThrow(/Agents cannot/)
    await expect(domain.declare(e.id, { kind: 'resource', ref: 'bad', spec: {} as never }, user)).rejects.toThrow(/resourceType/)

    const first = await domain.declare(e.id, { kind: 'tenant', ref: 'acme', spec: {} }, user)
    expect(first).toMatchObject({ kind: 'tenant', ref: 'acme', key: tenantKey('acme'), basis: 'declared', status: 'active' })
    await expect(domain.declare(e.id, { kind: 'tenant', ref: 'acme', spec: {} }, user)).rejects.toThrow(/already exists/)

    const withSecret = await domain.declare(e.id, { kind: 'identity', ref: 'rob', spec: { credentialRef: 'vault://rob', notes: 'temp header Authorization: Bearer abcdef0123456789abcdef' } }, user)
    expect(JSON.stringify(withSecret.spec)).not.toContain('abcdef0123456789abcdef')
    expect(withSecret.spec.credentialRef).toBe('vault://rob') // the opaque pointer is not a secret and is kept
  })

  it('serves a bounded, read-only declarations API', async () => {
    const e = await engagement('api')
    await domain.declare(e.id, { kind: 'role', ref: 'member', spec: {} }, user)
    const created = await domain.declare(e.id, { kind: 'identity', ref: 'alice', spec: { roleRefs: ['member'] } }, user)

    const list = await api<SecurityDomainDeclaration[]>(`/api/security/engagements/${e.id}/domain/declarations`)
    expect(list.status).toBe(200)
    expect(list.body.map((d) => d.ref).sort()).toEqual(['alice', 'member'])
    expect((await api<SecurityDomainDeclaration[]>(`/api/security/engagements/${e.id}/domain/declarations?kind=identity`)).body.map((d) => d.key)).toEqual([identityKey('alice')])
    expect((await api<SecurityDomainDeclaration>(`/api/security/domain/declarations/${created.id}`)).body).toMatchObject({ ref: 'alice', key: identityKey('alice') })
    expect((await api(`/api/security/domain/declarations/dom_00000000000000`)).status).toBe(404)

    // The role the identity references projects into the graph, reachable through the existing node API.
    await graph.project(e.id)
    const roles = await graph.nodes(e.id, { kind: 'role' })
    expect(roles.map((r) => r.key)).toEqual([roleKey('member')])
    const edges: SecurityGraphEdge[] = await graph.edges(e.id, { type: 'HAS_ROLE' })
    expect(edges[0]).toMatchObject({ fromKey: identityKey('alice'), toKey: roleKey('member') })
    const identities: SecurityGraphNode[] = await graph.nodes(e.id, { kind: 'identity' })
    expect(identities).toHaveLength(1)
  })
})
