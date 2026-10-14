import { describe, expect, it } from 'vitest'
import { defaultScopeManifest, type DomainDeclarationKind, type DomainSource, type ObservationType, type SecurityObservation } from '@audivra/contracts'
import {
  businessActionKey,
  businessStateKey,
  declarationKey,
  deriveGraph,
  edgeKey,
  identityKey,
  invariantKey,
  projectGraph,
  resourceKey,
  roleKey,
  tenantKey,
  type DomainDeclaration,
  type FactInput,
} from '../src/index.ts'

/*
 * The deterministic domain projector, as a pure function: declaration identity/dedupe, relationship
 * projection, unknown references (absence, never an invented target), conflicting declarations (both kept),
 * invariant source → basis mapping, provenance preservation, idempotency, and the invariant that a
 * credentialRef never reaches a graph node.
 */

const ORIGIN = 'http://127.0.0.1:4555'
const manifest = defaultScopeManifest(`${ORIGIN}/`)
let seq = 0
const T = '2026-10-13T10:00:00.000Z'

function decl(kind: DomainDeclarationKind, ref: string, spec: Record<string, unknown>, opts: { source?: DomainSource; confidence?: number; at?: string } = {}): DomainDeclaration {
  const id = `dom_${String(++seq).padStart(14, '0')}`
  return { id, kind, ref, key: declarationKey(kind, ref, spec), label: ref, source: opts.source ?? 'declared', confidence: opts.confidence ?? 1, spec, firstAt: opts.at ?? T, lastAt: opts.at ?? T }
}

function obs(type: ObservationType, asset: string): SecurityObservation {
  const id = `obs_${String(++seq).padStart(14, '0')}`
  return { id, engagementId: 'e', dedupeKey: id, type, asset, subject: 'response', title: `HTTP 200`, scopeClass: null, value: { status: 200 }, sourceType: 'tool-reported', confidence: 1, evidenceRefs: ['EV-1'], contributions: [{ executionId: 'sx_1', capabilityId: 'c', tool: 'httpx', toolVersion: 'v', evidenceRef: 'EV-1', confidence: 1, identityRef: null, sessionRef: null, at: T }], firstSeenAt: T, lastSeenAt: T }
}

/** Pure projection + derivation, so node basis/confidence/status can be asserted (mirrors graph.test.ts). */
function build(declarations: DomainDeclaration[], observations: SecurityObservation[] = []) {
  const desired = projectGraph({ observations, declarations, manifest })
  const byKey = new Map<string, FactInput>()
  for (const n of desired.nodes.values()) byKey.set(`node|${n.key}`, { subjectType: 'node', key: n.key, kind: n.kind, label: n.label, scopeClass: n.scopeClass, attributes: n.attributes, provenance: [] })
  for (const e of desired.edges.values()) byKey.set(`edge|${e.key}`, { subjectType: 'edge', key: e.key, type: e.type, fromKey: e.fromKey, toKey: e.toKey, scopeClass: null, attributes: e.attributes, provenance: [] })
  for (const p of desired.provenance) byKey.get(`${p.subjectType}|${p.subjectKey}`)!.provenance.push(p)
  const derived = deriveGraph({ facts: [...byKey.values()], desired, executions: [], observations: new Map(observations.map((o) => [o.id, o])), storedConflicts: new Map(), now: '2026-10-13T12:00:00.000Z' })
  return { desired, derived }
}

describe('domain identity and projection', () => {
  it('projects identities, roles, tenants, resources and states with their relationships and declared provenance', () => {
    const declarations = [
      decl('tenant', 'acme', { tenantType: 'organization', externalId: 'org_1' }),
      decl('role', 'admin', { permits: ['refund'] }),
      decl('identity', 'alice', { identityType: 'user', authMethod: 'form', credentialRef: 'vault://acme/alice', roleRefs: ['admin'], tenantRef: 'acme' }),
      decl('business-state', 'paid', { resourceType: 'invoice', transitionsToRefs: ['refunded'] }),
      decl('business-state', 'refunded', { resourceType: 'invoice', terminal: true }),
      decl('business-action', 'refund', { verb: 'refund', actsOnRefs: ['inv1'], requiredRoleRefs: ['admin'], requiredStateRef: 'paid', resultingStateRef: 'refunded' }),
      decl('resource', 'inv1', { resourceType: 'invoice', externalId: 'INV-1', tenantRef: 'acme', ownerRef: 'alice', currentStateRef: 'paid', testData: 'test-owned' }),
    ]
    const { desired, derived } = build(declarations)
    const alice = identityKey('alice')
    const admin = roleKey('admin')
    const acme = tenantKey('acme', 'org_1')
    const inv = resourceKey('invoice', { externalId: 'INV-1', ref: 'inv1' })
    const refund = businessActionKey('refund')
    const paid = businessStateKey('paid', 'invoice')
    const refunded = businessStateKey('refunded', 'invoice')

    // Nodes, with basis and confidence.
    for (const key of [alice, admin, acme, inv, refund, paid, refunded]) expect(derived.nodes.get(key), key).toBeTruthy()
    expect(derived.nodes.get(alice)).toMatchObject({ kind: 'identity', basis: 'declared', confidence: 1, status: 'active', tools: [] })
    expect(derived.nodes.get(inv)!.attributes).toMatchObject({ resourceType: 'invoice', testData: 'test-owned', externalId: 'INV-1' })

    // Relationships.
    for (const [type, from, to] of [
      ['HAS_ROLE', alice, admin],
      ['BELONGS_TO_TENANT', alice, acme],
      ['BELONGS_TO_TENANT', inv, acme],
      ['OWNS', alice, inv],
      ['HAS_STATE', inv, paid],
      ['PERMITS', admin, refund],
      ['ACTS_ON', refund, inv],
      ['TRANSITIONS_TO', paid, refunded],
    ] as const) {
      expect(derived.edges.get(edgeKey(type, from, to)), `${type} ${from}→${to}`).toBeTruthy()
    }
    // The state transition is asserted by both the action and the state declaration (merged, two provenances).
    const transition = derived.edges.get(edgeKey('TRANSITIONS_TO', paid, refunded))!
    expect(transition.basis).toBe('declared')
    // Every fact carries user-declaration provenance that points back to a declaration.
    const aliceProv = desired.provenance.filter((p) => p.subjectType === 'node' && p.subjectKey === alice)
    expect(aliceProv).toHaveLength(1)
    expect(aliceProv[0]).toMatchObject({ source: 'user-declaration', trust: 'user-declaration', observationId: null, tools: [], evidenceRefs: [] })
    expect(aliceProv[0]!.sourceRef).toMatch(/^dom_/)
  })

  it('never puts a credentialRef on a graph node — only that a credential is configured', () => {
    const { derived } = build([decl('identity', 'bob', { credentialRef: 'super-secret-token-value', authMethod: 'api-token' })])
    const bob = derived.nodes.get(identityKey('bob'))!
    expect(bob.attributes).toMatchObject({ credentialConfigured: true, authMethod: 'api-token' })
    expect(JSON.stringify(bob)).not.toContain('super-secret-token-value')
  })

  it('merges two declarations of the same resource onto one node, keeping both provenances', () => {
    const a = decl('resource', 'first', { resourceType: 'doc', canonicalUrl: `${ORIGIN}/docs/7` })
    const b = decl('resource', 'second', { resourceType: 'doc', canonicalUrl: `${ORIGIN}/docs/7/` })
    expect(a.key).toBe(b.key)
    const { desired, derived } = build([a, b])
    expect([...derived.nodes.values()].filter((n) => n.kind === 'resource')).toHaveLength(1)
    const prov = desired.provenance.filter((p) => p.subjectType === 'node' && p.subjectKey === a.key)
    expect(prov.map((p) => p.sourceRef).sort()).toEqual([a.id, b.id].sort())
  })

  it('leaves an unresolvable reference as an absent relationship (unknown, never invented)', () => {
    const { derived } = build([decl('identity', 'carol', { roleRefs: ['ghost-role'], tenantRef: 'ghost-tenant' })])
    expect(derived.nodes.get(identityKey('carol'))).toBeTruthy()
    // No role/tenant node was invented, and no edge was created to a non-existent entity.
    expect([...derived.nodes.values()].some((n) => n.kind === 'role' || n.kind === 'tenant')).toBe(false)
    expect([...derived.edges.values()].some((e) => e.type === 'HAS_ROLE' || e.type === 'BELONGS_TO_TENANT')).toBe(false)
  })

  it('keeps contradictory ownership from two declarations rather than silently picking one', () => {
    const r = resourceKey('invoice', { externalId: 'INV-9', ref: 'r' })
    const declarations = [
      decl('identity', 'owner-a', {}),
      decl('identity', 'owner-b', {}),
      decl('resource', 'r', { resourceType: 'invoice', externalId: 'INV-9', ownerRef: 'owner-a' }),
      decl('resource', 'r2', { resourceType: 'invoice', externalId: 'INV-9', ownerRef: 'owner-b' }),
    ]
    const { derived } = build(declarations)
    const ownsA = derived.edges.get(edgeKey('OWNS', identityKey('owner-a'), r))
    const ownsB = derived.edges.get(edgeKey('OWNS', identityKey('owner-b'), r))
    expect(ownsA, 'owner-a OWNS').toBeTruthy()
    expect(ownsB, 'owner-b OWNS').toBeTruthy()
    expect([ownsA!.status, ownsB!.status]).toEqual(['active', 'active'])
  })

  it('maps an invariant source to the right basis and caps AI inference, and governs its affected entities', () => {
    const affectsResource = { kind: 'resource' as const, ref: 'inv' }
    const resource = decl('resource', 'inv', { resourceType: 'invoice', externalId: 'INV-1' })
    const spec = (source: DomainSource, confidence?: number) => decl('invariant', `rule-${source}`, { category: 'tenant-boundary', rule: "a resource's tenant should match the actor's tenant", affects: [affectsResource, { nodeKey: `endpoint:${ORIGIN}/` }], status: 'candidate' }, { source, confidence })

    const observed = build([resource, spec('observed')], [obs('http-response', `${ORIGIN}/`)])
    const invObservedKey = invariantKey('tenant-boundary', ['resource:inv', `node:endpoint:${ORIGIN}/`], "a resource's tenant should match the actor's tenant")
    expect(observed.derived.nodes.get(invObservedKey)).toMatchObject({ basis: 'observed' })
    // GOVERNED_BY reaches both the declared resource and the observed endpoint.
    expect(observed.derived.edges.get(edgeKey('GOVERNED_BY', resourceKey('invoice', { externalId: 'INV-1', ref: 'inv' }), invObservedKey))).toBeTruthy()
    expect(observed.derived.edges.get(edgeKey('GOVERNED_BY', `endpoint:${ORIGIN}/`, invObservedKey))).toBeTruthy()

    expect(build([resource, spec('declared')]).derived.nodes.get(invKeyFor('declared'))).toMatchObject({ basis: 'declared', confidence: 1 })
    expect(build([resource, spec('code-derived')]).derived.nodes.get(invKeyFor('code-derived'))).toMatchObject({ basis: 'observed' })
    const inferred = build([resource, spec('ai-inferred', 0.95)]).derived.nodes.get(invKeyFor('ai-inferred'))!
    expect(inferred.basis).toBe('inferred')
    expect(inferred.confidence).toBeLessThanOrEqual(0.6)
  })

  it('is deterministic and idempotent (same declarations, any order, give the same graph)', () => {
    const declarations = [
      decl('tenant', 'acme', { externalId: 'org_1' }),
      decl('identity', 'alice', { roleRefs: ['admin'], tenantRef: 'acme' }),
      decl('role', 'admin', { permits: [] }),
      decl('resource', 'inv1', { resourceType: 'invoice', externalId: 'INV-1', ownerRef: 'alice', tenantRef: 'acme' }),
    ]
    const canon = (g: ReturnType<typeof projectGraph>) =>
      JSON.stringify({ nodes: [...g.nodes.entries()].sort(), edges: [...g.edges.entries()].sort(), prov: g.provenance.map((p) => `${p.subjectType}|${p.subjectKey}|${p.source}|${p.sourceRef}`).sort() })
    expect(canon(projectGraph({ observations: [], declarations: [...declarations].reverse(), manifest }))).toBe(canon(projectGraph({ observations: [], declarations, manifest })))
  })
})

/** The invariant key is the same regardless of source (it is derived from category + affects + rule). */
function invKeyFor(_source: string): string {
  return invariantKey('tenant-boundary', ['resource:inv', `node:endpoint:${ORIGIN}/`], "a resource's tenant should match the actor's tenant")
}
