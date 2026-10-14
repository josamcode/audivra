import { describe, expect, it } from 'vitest'
import { defaultScopeManifest, type ObservationType, type SecurityObservation } from '@audivra/contracts'
import {
  aggregateProvenance,
  deriveGraph,
  edgeKey,
  endpointKey,
  hostKey,
  matchesTemplate,
  parseOperation,
  parseServerHeader,
  parseTechnology,
  projectObservations,
  technologyKey,
  urlParts,
  type ExecutionFact,
  type FactInput,
} from '../src/index.ts'

/*
 * The deterministic Security Graph projector, as pure functions: identity, merge across sensors,
 * provenance, derivations (template match, server-header technology), contradictions, staleness,
 * supersession, knowledge gaps and idempotency (the same observations always give the same graph).
 */

const ORIGIN = 'http://127.0.0.1:4331'
const manifest = defaultScopeManifest(`${ORIGIN}/`)
let seq = 0
const id = (prefix: string) => `${prefix}_${String(++seq).padStart(14, '0')}`

function obs(input: {
  type: ObservationType
  asset: string
  subject: string
  value?: Record<string, unknown>
  tool?: string
  executionId?: string
  capabilityId?: string
  confidence?: number
  sourceType?: SecurityObservation['sourceType']
  at?: string
  scopeClass?: SecurityObservation['scopeClass']
}): SecurityObservation {
  const at = input.at ?? '2026-10-13T10:00:00.000Z'
  const tool = input.tool ?? 'httpx'
  return {
    id: id('obs'),
    engagementId: 'eng1234567',
    dedupeKey: `${input.type}:${input.asset}:${input.subject}`,
    type: input.type,
    asset: input.asset,
    subject: input.subject,
    title: `${input.type} ${input.subject}`,
    scopeClass: input.scopeClass ?? null,
    value: input.value ?? {},
    sourceType: input.sourceType ?? 'tool-reported',
    confidence: input.confidence ?? 1,
    evidenceRefs: ['EV-1'],
    contributions: [{ executionId: input.executionId ?? 'sx_aaaaaaaaaaaaa1', capabilityId: input.capabilityId ?? 'discovery.http-inspect', tool, toolVersion: `${tool}@sha256:x`, evidenceRef: 'EV-1', confidence: input.confidence ?? 1, identityRef: null, sessionRef: null, at }],
    firstSeenAt: at,
    lastSeenAt: at,
  }
}

function derive(observations: SecurityObservation[], executions: ExecutionFact[] = [], extra: FactInput[] = []) {
  const desired = projectObservations(observations, manifest)
  const byKey = new Map<string, FactInput>()
  for (const n of desired.nodes.values()) byKey.set(`node|${n.key}`, { subjectType: 'node', key: n.key, kind: n.kind, label: n.label, scopeClass: n.scopeClass, attributes: n.attributes, provenance: [] })
  for (const e of desired.edges.values()) byKey.set(`edge|${e.key}`, { subjectType: 'edge', key: e.key, type: e.type, fromKey: e.fromKey, toKey: e.toKey, scopeClass: null, attributes: e.attributes, provenance: [] })
  for (const p of desired.provenance) byKey.get(`${p.subjectType}|${p.subjectKey}`)!.provenance.push(p)
  return { desired, derived: deriveGraph({ facts: [...byKey.values(), ...extra], desired, executions, observations: new Map(observations.map((o) => [o.id, o])), storedConflicts: new Map(), now: '2026-10-13T12:00:00.000Z' }) }
}

describe('graph identity', () => {
  it('normalizes URLs, technologies and operations into stable keys', () => {
    expect(urlParts('HTTP://127.0.0.1:4331/About/?b=1&a=2#x')).toEqual({ origin: ORIGIN, path: '/About', query: ['a', 'b'] })
    expect(urlParts('src/app.js')).toBeNull()
    expect(parseTechnology('Nginx:1.18.0')).toEqual({ name: 'nginx', version: '1.18.0', display: 'Nginx' })
    expect(parseTechnology('nginx/1.20.1 (Ubuntu)')).toMatchObject({ name: 'nginx', version: '1.20.1' })
    expect(parseTechnology('Express')).toMatchObject({ name: 'express', version: null })
    expect(parseServerHeader('Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f')).toMatchObject({ name: 'apache', version: '2.4.41' })
    expect(parseOperation('get /widgets/{id}')).toEqual({ method: 'GET', template: '/widgets/{id}' })
    expect(parseOperation('nonsense')).toBeNull()
    expect(matchesTemplate('/api/widgets/7', '/api', '/widgets/{id}')).toBe(true)
    expect(matchesTemplate('/widgets/7/x', '/', '/widgets/{id}')).toBe(false)
    expect(matchesTemplate('/widgets', '/', '/widgets/{id}')).toBe(false)
  })
})

describe('graph projection', () => {
  it('merges the same endpoint reported by two sensors onto one entity, keeping both provenances', () => {
    const a = obs({ type: 'http-response', asset: `${ORIGIN}/about`, subject: 'response', value: { status: 200, title: 'About' } })
    const b = obs({ type: 'endpoint', asset: `${ORIGIN}/about/`, subject: 'get', value: { status: 200, contacted: true }, tool: 'katana', capabilityId: 'discovery.crawl', executionId: 'sx_bbbbbbbbbbbbb1' })
    const { desired, derived } = derive([a, b])
    const endpoint = derived.nodes.get(endpointKey(ORIGIN, '/about'))!
    expect([...desired.nodes.keys()].filter((k) => k.startsWith('endpoint:'))).toEqual([endpointKey(ORIGIN, '/about')])
    expect(endpoint.tools).toEqual(['httpx', 'katana'])
    expect(endpoint.corroboration).toBe(2)
    expect(endpoint.basis).toBe('observed')
    expect(endpoint.provenance.map((p) => p.observationId).sort()).toEqual([a.id, b.id].sort())
    expect(derived.edges.get(edgeKey('HOSTS', hostKey(ORIGIN), endpointKey(ORIGIN, '/about')))).toBeTruthy()
  })

  it('is deterministic and order-independent (idempotent projection)', () => {
    const list = [
      obs({ type: 'technology', asset: `${ORIGIN}/`, subject: 'Express', value: { technology: 'Express' }, sourceType: 'tool-inferred', confidence: 0.9 }),
      obs({ type: 'form', asset: `${ORIGIN}/`, subject: 'post /login', value: { method: 'post', action: '/login', parameters: ['user', 'pass'] }, tool: 'katana' }),
      obs({ type: 'redirect', asset: `${ORIGIN}/old`, subject: 'x', value: { status: 302, destination: `${ORIGIN}/new` } }),
    ]
    const once = projectObservations(list, manifest)
    const twice = projectObservations([...list].reverse(), manifest)
    const canon = (g: ReturnType<typeof projectObservations>) => JSON.stringify({ nodes: [...g.nodes.entries()].sort(), edges: [...g.edges.entries()].sort(), prov: g.provenance.map((p) => `${p.subjectKey}|${p.sourceRef}`).sort() })
    expect(canon(twice)).toBe(canon(once))
    // Forms become a CALLS edge to the action and READS edges to its parameters.
    expect(once.edges.get(edgeKey('CALLS', endpointKey(ORIGIN, '/'), endpointKey(ORIGIN, '/login')))).toBeTruthy()
    expect([...once.nodes.values()].filter((n) => n.kind === 'parameter').map((n) => n.label).sort()).toEqual(['pass', 'user'])
  })

  it('derives a technology from a Server header with derivation provenance, and links endpoints to API path templates', () => {
    const header = obs({ type: 'http-header', asset: `${ORIGIN}/`, subject: 'server', value: { header: 'server', value: 'nginx/1.18.0' } })
    const op = obs({ type: 'api-operation', asset: ORIGIN, subject: 'get /widgets/{id}', value: { operation: 'GET /widgets/{id}' }, tool: 'schemathesis', capabilityId: 'api.contract-test' })
    const crawl = obs({ type: 'endpoint', asset: `${ORIGIN}/widgets/7`, subject: 'get', value: { status: 200, contacted: true }, tool: 'katana' })
    const { derived } = derive([header, op, crawl])
    const nginx = derived.nodes.get(technologyKey('nginx'))!
    expect(nginx.basis).toBe('derived')
    expect(nginx.provenance[0]).toMatchObject({ source: 'derivation', observationId: header.id })
    const opNode = [...derived.nodes.values()].find((n) => n.kind === 'api-operation')!
    expect(opNode.label).toBe('GET /widgets/{id}')
    const belongs = derived.edges.get(edgeKey('BELONGS_TO', endpointKey(ORIGIN, '/widgets/7'), opNode.key))!
    expect(belongs.basis).toBe('derived')
    expect(derived.gaps.find((g) => g.kind === 'api-operation-unobserved' && g.subjectKey === opNode.key)?.state).toBe('resolved')
  })

  it('keeps contradicting facts and marks them contradicted instead of choosing one', () => {
    const a = obs({ type: 'technology', asset: `${ORIGIN}/`, subject: 'Nginx', value: { technology: 'Nginx' }, sourceType: 'tool-inferred', confidence: 0.9 })
    const b = obs({ type: 'technology', asset: `${ORIGIN}/x`, subject: 'Apache', value: { technology: 'Apache' }, tool: 'katana', sourceType: 'tool-inferred', confidence: 0.9 })
    const { derived } = derive([a, b])
    const nginx = derived.edges.get(edgeKey('DEPENDS_ON', hostKey(ORIGIN), technologyKey('nginx')))!
    const apache = derived.edges.get(edgeKey('DEPENDS_ON', hostKey(ORIGIN), technologyKey('apache')))!
    expect(nginx.status).toBe('contradicted')
    expect(apache.status).toBe('contradicted')
    expect(nginx.conflicts[0]).toMatchObject({ group: `web-server@${hostKey(ORIGIN)}`, with: [apache.key] })
    expect(derived.nodes.get(technologyKey('nginx'))!.status).toBe('contradicted')
    expect(derived.gaps.filter((g) => g.kind === 'contradiction-unresolved' && g.state === 'open')).toHaveLength(1)
  })

  it('detects a version disagreement between sensors, but not an upgrade seen over time by one sensor', () => {
    const httpx = obs({ type: 'http-header', asset: `${ORIGIN}/`, subject: 'server', value: { header: 'server', value: 'nginx/1.18.0' } })
    const banner = obs({ type: 'web-signal', asset: `${ORIGIN}/`, subject: 'audivra-server-banner', value: { templateId: 'audivra-server-banner', extracted: ['nginx/1.20.0'] }, tool: 'nuclei', sourceType: 'tool-heuristic', confidence: 0.5 })
    expect(derive([httpx, banner]).derived.edges.get(edgeKey('DEPENDS_ON', hostKey(ORIGIN), technologyKey('nginx')))!.status).toBe('contradicted')
    const later = obs({ type: 'http-header', asset: `${ORIGIN}/x`, subject: 'server', value: { header: 'server', value: 'nginx/1.20.0' }, at: '2026-10-13T11:00:00.000Z' })
    expect(derive([httpx, later]).derived.edges.get(edgeKey('DEPENDS_ON', hostKey(ORIGIN), technologyKey('nginx')))!.status).toBe('active')
  })

  it('marks facts stale when the same sensor re-ran completely on the same target and did not report them', () => {
    const old = obs({ type: 'technology', asset: `${ORIGIN}/`, subject: 'Express', value: { technology: 'Express' }, executionId: 'sx_run00000000001', sourceType: 'tool-inferred', at: '2026-10-13T09:00:00.000Z' })
    const executions: ExecutionFact[] = [
      { id: 'sx_run00000000001', capabilityId: 'discovery.http-inspect', target: `${ORIGIN}/`, status: 'succeeded', sensorState: 'success', finishedAt: '2026-10-13T09:00:01.000Z' },
      { id: 'sx_run00000000002', capabilityId: 'discovery.http-inspect', target: `${ORIGIN}/`, status: 'succeeded', sensorState: 'success', finishedAt: '2026-10-13T10:00:00.000Z' },
    ]
    const tech = derive([old], executions).derived.nodes.get(technologyKey('express'))!
    expect(tech.status).toBe('stale')
    expect(tech.statusReason).toContain('sx_run00000000002')
    // A partial later run proves nothing: the fact stays active.
    const partial = executions.map((e) => (e.id === 'sx_run00000000002' ? { ...e, sensorState: 'partial' } : e))
    expect(derive([old], partial).derived.nodes.get(technologyKey('express'))!.status).toBe('active')
  })

  it('supersedes an older redirect destination', () => {
    const first = obs({ type: 'redirect', asset: `${ORIGIN}/go`, subject: 'a', value: { status: 302, destination: `${ORIGIN}/a` }, at: '2026-10-13T09:00:00.000Z' })
    const second = obs({ type: 'redirect', asset: `${ORIGIN}/go`, subject: 'b', value: { status: 302, destination: `${ORIGIN}/b` }, at: '2026-10-13T10:00:00.000Z' })
    const { derived } = derive([first, second])
    expect(derived.edges.get(edgeKey('REDIRECTS_TO', endpointKey(ORIGIN, '/go'), endpointKey(ORIGIN, '/a')))!.status).toBe('superseded')
    expect(derived.edges.get(edgeKey('REDIRECTS_TO', endpointKey(ORIGIN, '/go'), endpointKey(ORIGIN, '/b')))!.status).toBe('active')
  })
})

describe('knowledge gaps (unknown is not false)', () => {
  it('opens behavior and corroboration gaps, and resolves them when evidence arrives', () => {
    const redirect = obs({ type: 'redirect', asset: `${ORIGIN}/`, subject: 'x', value: { status: 302, destination: `${ORIGIN}/admin` } })
    const tech = obs({ type: 'technology', asset: `${ORIGIN}/`, subject: 'Express', value: { technology: 'Express' }, sourceType: 'tool-inferred', confidence: 0.9 })
    const before = derive([redirect, tech]).derived.gaps
    expect(before.find((g) => g.kind === 'endpoint-behavior-unknown' && g.subjectKey === endpointKey(ORIGIN, '/admin'))?.state).toBe('open')
    expect(before.find((g) => g.kind === 'technology-uncorroborated')?.state).toBe('open')

    const inspected = obs({ type: 'http-response', asset: `${ORIGIN}/admin`, subject: 'response', value: { status: 401 } })
    const corroborated = obs({ type: 'technology', asset: `${ORIGIN}/about`, subject: 'Express', value: { technology: 'Express' }, tool: 'katana', sourceType: 'tool-inferred', confidence: 0.9 })
    const after = derive([redirect, tech, inspected, corroborated]).derived.gaps
    expect(after.find((g) => g.kind === 'endpoint-behavior-unknown' && g.subjectKey === endpointKey(ORIGIN, '/admin'))).toMatchObject({ state: 'resolved', resolution: 'Responded HTTP 401', resolvedBy: { observationId: inspected.id } })
    expect(after.find((g) => g.kind === 'technology-uncorroborated')).toMatchObject({ state: 'resolved', resolution: 'Corroborated by httpx and katana' })
  })

  it('treats a heuristic signal as unconfirmed until another sensor independently confirms it', () => {
    const banner = obs({ type: 'web-signal', asset: `${ORIGIN}/`, subject: 'audivra-server-banner', value: { templateId: 'audivra-server-banner', extracted: ['nginx'] }, tool: 'nuclei', sourceType: 'tool-heuristic', confidence: 0.5 })
    const hsts = obs({ type: 'web-signal', asset: `${ORIGIN}/`, subject: 'audivra-missing-hsts', value: { templateId: 'audivra-missing-hsts' }, tool: 'nuclei', sourceType: 'tool-heuristic', confidence: 0.5 })
    const open = derive([banner, hsts]).derived.gaps.filter((g) => g.kind === 'signal-unconfirmed')
    expect(open.map((g) => g.state)).toEqual(['open', 'open'])
    // No shipped sensor can confirm a missing HSTS header: the gap says so (nothing answers it).
    expect(open.find((g) => g.subjectKey.includes('missing-hsts'))!.answeredBy).toEqual([])

    const header = obs({ type: 'http-header', asset: `${ORIGIN}/`, subject: 'server', value: { header: 'server', value: 'nginx' } })
    const after = derive([banner, hsts, header]).derived.gaps.filter((g) => g.kind === 'signal-unconfirmed')
    expect(after.find((g) => g.subjectKey.includes('server-banner'))).toMatchObject({ state: 'resolved' })
    expect(after.find((g) => g.subjectKey.includes('missing-hsts'))).toMatchObject({ state: 'open' })
  })

  it('never raises an AI inference above inferred, and caps its confidence', () => {
    const agg = aggregateProvenance([{ source: 'ai-inference', confidence: 0.95, tools: [], executionIds: [], observationId: null, firstAt: '2026-10-13T10:00:00.000Z', lastAt: '2026-10-13T10:00:00.000Z' }])
    expect(agg).toMatchObject({ basis: 'inferred', confidence: 0.6, corroboration: 0 })
    const mixed = aggregateProvenance([
      { source: 'ai-inference', confidence: 0.95, tools: [], executionIds: [], observationId: null, firstAt: '2026-10-13T10:00:00.000Z', lastAt: '2026-10-13T10:00:00.000Z' },
      { source: 'observation', confidence: 0.7, tools: ['katana'], executionIds: ['sx_1'], observationId: 'obs_1', firstAt: '2026-10-13T09:00:00.000Z', lastAt: '2026-10-13T09:00:00.000Z' },
    ])
    expect(mixed).toMatchObject({ basis: 'observed', confidence: 0.7, tools: ['katana'] })
  })
})
