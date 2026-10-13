import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capabilityIdentity, ScopeManifest, type ExecutionLimits } from '@audivra/contracts'
import {
  CapabilityBroker,
  CapabilityRegistry,
  identityHttpCapability,
  identityKey,
  projectGraph,
  ScopedHttpClient,
  sessionHeaders,
  sessionKey,
  type ExecutionAuthResolver,
  type Resolver,
  type ValidatedIdentity,
} from '../src/index.ts'
import { startIdentityFixture, type IdentityFixture } from '../../../test/helpers.ts'
import { MemoryStore, snapshot, spyCapability, verifiedLocal } from './memory-store.ts'

/*
 * Phase 5 Step 3 — the identity-aware execution boundary as pure/near-pure units: how session material
 * becomes request headers, how a capability declares its identity needs, how established sessions project
 * onto the graph, that injected auth is strictly same-origin, and that the broker validates (or refuses)
 * the referenced identity without ever touching a secret.
 */

const LIMITS: ExecutionLimits = { maxRequests: 5, requestsPerSecond: 10, concurrency: 1, executionTimeoutSeconds: 10, maxResponseBytes: 1_000_000, maxArtifactMb: 1 }
const loopback: Resolver = async () => ['127.0.0.1']

describe('sessionHeaders', () => {
  it('turns cookies, a bearer token and extra headers into request headers (lower-cased)', () => {
    expect(sessionHeaders({ cookies: [{ name: 'sid', value: 'abc' }, { name: 'csrf', value: 'xyz' }] })).toEqual({ cookie: 'sid=abc; csrf=xyz' })
    expect(sessionHeaders({ bearerToken: 'T0KEN' })).toEqual({ authorization: 'Bearer T0KEN' })
    expect(sessionHeaders({ headers: { 'X-Api-Key': 'k' } })).toEqual({ 'x-api-key': 'k' })
    expect(sessionHeaders({})).toEqual({})
  })
})

describe('capabilityIdentity', () => {
  it('defaults to anonymous-only when a capability declares no identity block', () => {
    expect(capabilityIdentity({})).toEqual({ supportsIdentity: false, requiresIdentity: false, supportsAnonymous: true, requiresSession: false })
  })
  it('reflects a declared identity block', () => {
    expect(capabilityIdentity(identityHttpCapability.metadata)).toEqual({ supportsIdentity: true, requiresIdentity: false, supportsAnonymous: true, requiresSession: false })
  })
})

describe('session graph projection (AUTHENTICATES_AS)', () => {
  const manifest = ScopeManifest.parse({ hosts: [{ host: '127.0.0.1', ports: [4000] }], protocols: ['http'] })
  const now = new Date().toISOString()
  const alice = { id: 'dom_aaaaaaaaaaaaaa', kind: 'identity' as const, ref: 'alice', key: identityKey('alice'), label: 'Alice', source: 'declared' as const, confidence: 1, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: 'alice-cred' }, firstAt: now, lastAt: now }
  const session = (id: string, status: 'active' | 'revoked' | 'expired', identityRef = 'alice') => ({ id, identityRef, environment: 'staging' as const, authMethod: 'api-token', status, establishedAt: now, expiresAt: null })

  it('links an active session to its identity with active:true', () => {
    const graph = projectGraph({ observations: [], declarations: [alice], sessions: [session('sess_aaaaaaaaaaaaaa', 'active')], manifest })
    const node = graph.nodes.get(sessionKey('sess_aaaaaaaaaaaaaa'))
    expect(node?.kind).toBe('session')
    expect(node?.attributes).toMatchObject({ status: 'active', active: true, authMethod: 'api-token' })
    const edge = [...graph.edges.values()].find((e) => e.type === 'AUTHENTICATES_AS')
    expect(edge).toMatchObject({ fromKey: sessionKey('sess_aaaaaaaaaaaaaa'), toKey: identityKey('alice'), attributes: { active: true } })
  })

  it('keeps the edge for a revoked session but marks it inactive (honest history)', () => {
    const graph = projectGraph({ observations: [], declarations: [alice], sessions: [session('sess_bbbbbbbbbbbbbb', 'revoked')], manifest })
    expect(graph.nodes.get(sessionKey('sess_bbbbbbbbbbbbbb'))?.attributes).toMatchObject({ status: 'revoked', active: false })
    expect([...graph.edges.values()].find((e) => e.type === 'AUTHENTICATES_AS')?.attributes).toMatchObject({ active: false })
  })

  it('does not invent an AUTHENTICATES_AS edge for an undeclared identity (UNKNOWN != FALSE)', () => {
    const graph = projectGraph({ observations: [], declarations: [], sessions: [session('sess_cccccccccccccc', 'active', 'ghost')], manifest })
    expect(graph.nodes.get(sessionKey('sess_cccccccccccccc'))?.kind).toBe('session')
    expect([...graph.edges.values()].some((e) => e.type === 'AUTHENTICATES_AS')).toBe(false)
  })
})

describe('ScopedHttpClient injects auth only same-origin', () => {
  let fixture: IdentityFixture
  beforeAll(async () => {
    fixture = await startIdentityFixture('inject')
  })
  afterAll(async () => {
    await fixture.close()
  })

  const manifest = () => ScopeManifest.parse({ hosts: [{ host: '127.0.0.1', ports: [fixture.port] }], protocols: ['http'] })

  it('attaches the session headers when the target origin matches', async () => {
    const client = new ScopedHttpClient({ manifest: manifest(), limits: LIMITS, mutation: 'read-only', resolver: loopback, signal: AbortSignal.timeout(5000), auth: { headers: { cookie: 'sid=ALICE' }, origin: fixture.url } })
    const res = await client.request({ url: `${fixture.url}/echo`, method: 'GET', followRedirects: false })
    expect(res.status).toBe(200)
    expect(fixture.requests.at(-1)?.headers.cookie).toBe('sid=ALICE')
  })

  it('withholds the session headers when the origin differs (no cross-origin leak)', async () => {
    const client = new ScopedHttpClient({ manifest: manifest(), limits: LIMITS, mutation: 'read-only', resolver: loopback, signal: AbortSignal.timeout(5000), auth: { headers: { cookie: 'sid=ALICE' }, origin: 'http://elsewhere.invalid' } })
    await client.request({ url: `${fixture.url}/echo`, method: 'GET', followRedirects: false })
    expect(fixture.requests.at(-1)?.headers.cookie).toBeUndefined()
  })
})

describe('broker identity decisions', () => {
  const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
  const PORT = 4997
  const TARGET = `http://127.0.0.1:${PORT}/allowed`
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'audivra-identity-'))
  afterAll(() => rmSync(workspace, { recursive: true, force: true }))

  const validated: ValidatedIdentity = { identityRef: 'alice', sessionRef: 'sess_aaaaaaaaaaaaaa', authMethod: 'api-token' }
  const fakeResolver: ExecutionAuthResolver = {
    validate: async () => validated,
    resolve: async () => ({ headers: { cookie: 'sid=ALICE' }, origin: `http://127.0.0.1:${PORT}` }),
  }

  function run(patch: Parameters<typeof spyCapability>[0], extra: Record<string, unknown>, authResolver?: ExecutionAuthResolver) {
    const { capability, calls } = spyCapability(patch)
    const store = new MemoryStore(snapshot(PORT), [verifiedLocal(PORT)])
    const broker = new CapabilityBroker({
      registry: new CapabilityRegistry().register(capability),
      store,
      resolver: async () => ['127.0.0.1'],
      checkResources: async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} }),
      workspaceRoot: () => workspace,
      authResolver,
    })
    return { calls, store, outcome: broker.execute({ engagementId: store.engagement.id, capabilityId: 'test.spy', input: { url: TARGET }, actor: user, ...extra }) }
  }

  it('refuses a session reference on a capability that does not support identity', async () => {
    const { outcome } = run({}, { sessionRef: 'sess_aaaaaaaaaaaaaa' }, fakeResolver)
    const settled = await outcome
    expect(settled.status).toBe('denied')
    expect(settled.decision.checks.some((c) => c.stage === 'identity' && c.rule === 'identity.not-supported')).toBe(true)
  })

  it('refuses an identity capability that requires a session when none is referenced', async () => {
    const { outcome } = run({ identity: { supportsIdentity: true, requiresIdentity: false, supportsAnonymous: false, requiresSession: true } }, { identityRef: 'alice' }, fakeResolver)
    const settled = await outcome
    expect(settled.status).toBe('denied')
    expect(settled.decision.checks.some((c) => c.rule === 'identity.session-required')).toBe(true)
  })

  it('refuses an identity-only capability requested anonymously', async () => {
    const { outcome } = run({ identity: { supportsIdentity: true, requiresIdentity: false, supportsAnonymous: false, requiresSession: false } }, {}, fakeResolver)
    const settled = await outcome
    expect(settled.status).toBe('denied')
    expect(settled.decision.checks.some((c) => c.rule === 'identity.anonymous-not-allowed')).toBe(true)
  })

  it('validates the referenced session and hands the capability an identity-tagged context', async () => {
    const { outcome, calls } = run({ identity: { supportsIdentity: true, requiresIdentity: false, supportsAnonymous: true, requiresSession: false } }, { identityRef: 'alice', sessionRef: 'sess_aaaaaaaaaaaaaa' }, fakeResolver)
    const settled = await outcome
    expect(settled.status, settled.decision.reason).toBe('completed')
    expect(settled.decision.checks.some((c) => c.stage === 'identity' && c.outcome === 'pass')).toBe(true)
    expect((calls[0]?.context as { identity: ValidatedIdentity | null }).identity).toEqual(validated)
  })

  it('runs anonymously (no identity) exactly as before when no resolver is configured', async () => {
    const { outcome, calls } = run({ identity: { supportsIdentity: true, requiresIdentity: false, supportsAnonymous: true, requiresSession: false } }, {})
    const settled = await outcome
    expect(settled.status).toBe('completed')
    expect((calls[0]?.context as { identity: ValidatedIdentity | null }).identity).toBeNull()
  })
})
