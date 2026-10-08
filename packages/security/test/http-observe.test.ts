import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ScopeManifest } from '@audivra/contracts'
import { CapabilityBroker, createDefaultRegistry, ScopedHttpClient, ScopeViolationError, BudgetExceededError, type Resolver } from '../src/index.ts'
import { startScopeFixture, type ScopeFixture } from '../../../test/helpers.ts'
import { MemoryStore, snapshot, verifiedLocal } from './memory-store.ts'

/*
 * The real Phase 1 capability against the local scope fixture (127.0.0.1 only). A second fixture
 * instance on another port stands in for "a different service on the same machine": the tests prove
 * it never receives a request.
 */

let primary: ScopeFixture
let other: ScopeFixture
const workspace = mkdtempSync(path.join(os.tmpdir(), 'audivra-observe-'))
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
// Loopback names resolve locally; anything else must never be looked up by these tests.
const resolver: Resolver = async (host) => {
  if (host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.1']
  throw new Error(`unexpected DNS lookup of ${host}`)
}

beforeAll(async () => {
  primary = await startScopeFixture('primary')
  other = await startScopeFixture('other-service')
})
afterAll(async () => {
  await primary.close()
  await other.close()
  rmSync(workspace, { recursive: true, force: true })
})

function observe(input: Record<string, unknown>, store = new MemoryStore(snapshot(primary.port), [verifiedLocal(primary.port)])) {
  const broker = new CapabilityBroker({
    registry: createDefaultRegistry(),
    store,
    resolver,
    workspaceRoot: () => workspace,
    checkResources: async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} }),
  })
  return { store, run: () => broker.execute({ engagementId: store.engagement.id, capabilityId: 'discovery.http-observe', input, actor: user }) }
}

describe('discovery.http-observe through the broker', () => {
  it('Case A: observes an allowed route and records evidence with full provenance', async () => {
    const { run, store } = observe({ url: `${primary.url}/allowed` })
    const outcome = await run()
    expect(outcome.status).toBe('completed')
    expect(outcome.output).toMatchObject({ status: 200, finalUrl: `${primary.url}/allowed`, redirects: [], blockedRedirect: null })
    expect(primary.hits.get('/allowed')).toBe(1)
    const [evidence] = outcome.evidence
    expect(evidence).toMatchObject({ ref: 'EV-1', type: 'http-header', source: 'system', url: `${primary.url}/allowed` })
    expect(evidence!.provenance).toMatchObject({
      engagementId: store.engagement.id,
      executionId: outcome.executionId,
      capabilityId: 'discovery.http-observe',
      implementation: 'builtin/http-observe@1',
      environment: 'staging',
      scopeVersion: 1,
      scopeHash: store.engagement.scopeHash,
      policyProfile: { key: 'standard', version: 1 },
      authorizationIds: [verifiedLocal(primary.port).id],
      decisionEventId: store.events.find((e) => e.type === 'capability.allowed')!.id,
    })
    const artifact = JSON.parse(readFileSync(path.join(workspace, evidence!.artifactPath!), 'utf8'))
    expect(artifact.network).toHaveLength(1)
    expect(artifact.network[0]).toMatchObject({ decision: 'allow', status: 200, addresses: ['127.0.0.1'] })
  })

  it('follows redirects that stay in scope, evaluating every hop', async () => {
    const outcome = await observe({ url: `${primary.url}/redirect/chain` }).run()
    expect(outcome.output).toMatchObject({ status: 200, finalUrl: `${primary.url}/allowed` })
    expect((outcome.output as { redirects: unknown[] }).redirects).toHaveLength(2)
    expect(outcome.network.map((a) => a.decision)).toEqual(['allow', 'allow', 'allow'])
  })

  it('never follows a redirect out of scope: other host name, alternate port, subdomain, third party', async () => {
    const cases: [string, string][] = [
      [`/redirect/other-host`, 'scope.host-not-listed'],
      [`/redirect/other-port?port=${other.port}`, 'scope.port-not-allowed'],
      [`/redirect/subdomain`, 'scope.host-not-listed'],
      [`/redirect/external`, 'scope.host-not-listed'],
    ]
    const allowedBefore = primary.hits.get('/allowed') ?? 0
    for (const [route, rule] of cases) {
      const outcome = await observe({ url: `${primary.url}${route}` }).run()
      expect(outcome.status, route).toBe('completed')
      const output = outcome.output as { status: number; blockedRedirect: { rule: string } | null }
      expect(output.status, route).toBe(302)
      expect(output.blockedRedirect?.rule, route).toBe(rule)
      expect(outcome.network.at(-1)).toMatchObject({ decision: 'deny', status: null })
    }
    // The redirect targets were never contacted: not on the other port, not via another host name.
    expect(other.total()).toBe(0)
    expect(primary.hits.get('/allowed') ?? 0).toBe(allowedBefore)
  })

  it('stops redirect loops at the hop limit', async () => {
    const outcome = await observe({ url: `${primary.url}/redirect/loop` }).run()
    expect((outcome.output as { blockedRedirect: { rule: string } }).blockedRedirect.rule).toBe('redirect.too-many-hops')
  })

  it('Case C: a request against another target is denied by scope before anything is sent', async () => {
    const before = other.total()
    for (const url of [`${other.url}/allowed`, `http://localhost:${primary.port}/allowed`, 'https://third-party.invalid/']) {
      const outcome = await observe({ url }).run()
      expect(outcome.decision).toMatchObject({ decision: 'deny', stage: 'scope' })
      expect(outcome.network).toEqual([])
    }
    expect(other.total()).toBe(before)
  })

  it('Case B: an unauthorized engagement is denied and nothing is sent', async () => {
    const before = primary.total()
    const outcome = await observe({ url: `${primary.url}/allowed` }, new MemoryStore(snapshot(primary.port), [])).run()
    expect(outcome.decision).toMatchObject({ decision: 'deny', stage: 'authorization' })
    expect(primary.total()).toBe(before)
  })

  it('redacts secret response headers from evidence', async () => {
    const outcome = await observe({ url: `${primary.url}/headers` }).run()
    const evidence = JSON.stringify(outcome.evidence)
    expect(evidence).not.toContain('fixture-session-secret-value')
    expect(evidence).not.toContain('fixture-api-key-secret')
    expect(outcome.evidence[0]!.provenance.redactions).toBeGreaterThan(0)
    expect(outcome.evidence[0]!.provenance.sensitivity).toBe('sensitive')
  })
})

describe('scoped HTTP client limits', () => {
  const manifest = () => ScopeManifest.parse({ hosts: [{ host: '127.0.0.1', ports: [primary.port] }], protocols: ['http'] })
  const limits = { maxRequests: 2, requestsPerSecond: 50, concurrency: 1, executionTimeoutSeconds: 10, maxResponseBytes: 10_000, maxArtifactMb: 10 }

  it('enforces the request budget across redirect hops', async () => {
    const client = new ScopedHttpClient({ manifest: manifest(), limits, mutation: 'read-only', resolver, signal: new AbortController().signal })
    await expect(client.request({ url: `${primary.url}/redirect/chain` })).rejects.toBeInstanceOf(BudgetExceededError)
    expect(client.requestCount).toBe(2)
  })

  it('refuses unsafe methods and out-of-scope URLs without sending', async () => {
    const client = new ScopedHttpClient({ manifest: manifest(), limits, mutation: 'read-only', resolver, signal: new AbortController().signal })
    await expect(client.request({ url: `${primary.url}/allowed`, method: 'POST' as 'GET' })).rejects.toBeInstanceOf(ScopeViolationError)
    await expect(client.request({ url: `${other.url}/allowed` })).rejects.toBeInstanceOf(ScopeViolationError)
    expect(client.requestCount).toBe(0)
  })

  it('spaces requests according to the rate limit', async () => {
    const client = new ScopedHttpClient({ manifest: manifest(), limits: { ...limits, maxRequests: 3, requestsPerSecond: 5 }, mutation: 'read-only', resolver, signal: new AbortController().signal })
    const started = Date.now()
    for (let i = 0; i < 3; i++) await client.request({ url: `${primary.url}/allowed` })
    expect(Date.now() - started).toBeGreaterThanOrEqual(380)
  })
})
