import type {
  GraphEntityKind,
  GraphRelationType,
  ObservationScopeClass,
  ProvenanceSource,
  ScopeManifest,
  SecurityObservation,
  SourceTrust,
} from '@audivra/contracts'
import { classifyDiscovered } from '../execution/observations.ts'
import {
  apiOperationKey,
  concreteOperationUrl,
  edgeKey,
  endpointKey,
  endpointUrl,
  hostKey,
  matchesTemplate,
  parameterKey,
  parseOperation,
  parseServerHeader,
  parseTechnology,
  signalKey,
  sourceFileKey,
  technologyKey,
  templateParameters,
  urlParts,
  type ParameterLocation,
  type UrlParts,
} from './identity.ts'

/*
 * The deterministic graph projector, as a pure function: stored observations in, desired graph facts out.
 * No database, no clock, no AI — the same observations always produce the same facts, which is what makes
 * re-projection idempotent. Persistence, aggregation (basis/confidence/status), conflicts, staleness and
 * knowledge gaps are applied afterwards (`derive.ts`, `projector.ts`).
 *
 * Each observation supports every fact it implies (an endpoint URL implies its host and the HOSTS edge),
 * through one provenance row per (fact, observation). Rule-based facts computed from observations (a
 * technology parsed from a Server header, an endpoint matching an API path template) carry `derivation`
 * provenance with the rule named in the rationale.
 */

export interface DesiredNode {
  kind: GraphEntityKind
  key: string
  label: string
  scopeClass: ObservationScopeClass | null
  attributes: Record<string, unknown>
}

export interface DesiredEdge {
  type: GraphRelationType
  key: string
  fromKey: string
  toKey: string
  attributes: Record<string, unknown>
}

export interface DesiredProvenance {
  subjectType: 'node' | 'edge'
  subjectKey: string
  /** `observation` / `derivation` from a sensor, or `user-declaration` / `ai-inference` from a domain declaration. */
  source: ProvenanceSource
  trust: SourceTrust
  sourceRef: string
  observationId: string | null
  evidenceRefs: string[]
  executionIds: string[]
  capabilityIds: string[]
  tools: string[]
  confidence: number
  rationale: string | null
  firstAt: string
  lastAt: string
}

/** Where an entity's observed response status came from (for gap resolution). */
export interface StatusSource {
  status: number
  observationId: string
  executionId: string | null
  at: string
}

export interface DesiredGraph {
  nodes: Map<string, DesiredNode>
  edges: Map<string, DesiredEdge>
  provenance: DesiredProvenance[]
  /** endpoint key → latest observed response status and its source. */
  statusSources: Map<string, StatusSource>
  /** entity key → ids of observations projected onto it (any source). */
  observationsByEntity: Map<string, string[]>
  /** Observation types that have no projection rule yet (counted, not silently dropped). */
  unprojected: Record<string, number>
}

const MAX_SET = 25
const byTimeThenId = (a: SecurityObservation, b: SecurityObservation) => a.lastSeenAt.localeCompare(b.lastSeenAt) || a.id.localeCompare(b.id)
const uniq = (values: Iterable<string>, max = 20) => [...new Set(values)].slice(-max)

/** Confirmation rules for heuristic signals: what independent observation (from another tool) confirms one. */
export const SIGNAL_CONFIRMATIONS: Record<string, { observationType: SecurityObservation['type']; subject: string | null; how: string }> = {
  'audivra-server-banner': { observationType: 'http-header', subject: 'server', how: 'a Server header read by another sensor' },
}

export class Builder {
  readonly nodes = new Map<string, DesiredNode & { sets: Map<string, Set<string>> }>()
  readonly edges = new Map<string, DesiredEdge & { sets: Map<string, Set<string>> }>()
  readonly provenance = new Map<string, DesiredProvenance>()
  readonly statusSources = new Map<string, StatusSource>()
  readonly observationsByEntity = new Map<string, Set<string>>()
  readonly unprojected: Record<string, number> = {}
  readonly #scopeCache = new Map<string, ObservationScopeClass>()

  constructor(private readonly manifest: ScopeManifest) {}

  scope(url: string): ObservationScopeClass {
    let value = this.#scopeCache.get(url)
    if (!value) {
      value = classifyDiscovered(this.manifest, url)
      this.#scopeCache.set(url, value)
    }
    return value
  }

  node(kind: GraphEntityKind, key: string, label: string, scopeClass: ObservationScopeClass | null = null): string {
    if (!this.nodes.has(key)) this.nodes.set(key, { kind, key, label: label.slice(0, 300), scopeClass, attributes: {}, sets: new Map() })
    return key
  }

  edge(type: GraphRelationType, fromKey: string, toKey: string): string {
    const key = edgeKey(type, fromKey, toKey)
    if (!this.edges.has(key)) this.edges.set(key, { type, key, fromKey, toKey, attributes: {}, sets: new Map() })
    return key
  }

  #fact(key: string) {
    return this.nodes.get(key) ?? this.edges.get(key)
  }

  attr(key: string, name: string, value: unknown) {
    const fact = this.#fact(key)
    if (fact && value !== undefined && value !== null && value !== '') fact.attributes[name] = value
  }

  add(key: string, name: string, value: string | null | undefined) {
    const fact = this.#fact(key)
    if (!fact || !value) return
    const set = fact.sets.get(name) ?? new Set<string>()
    set.add(String(value).slice(0, 300))
    fact.sets.set(name, set)
  }

  /** A provenance row: `observation` support, or a rule-based `derivation` from that observation. */
  support(subjectType: 'node' | 'edge', subjectKey: string, o: SecurityObservation, derivation?: { rule: string; confidence: number; rationale: string }) {
    const source = derivation ? 'derivation' : 'observation'
    const sourceRef = derivation ? `${derivation.rule}:${o.id}` : o.id
    const id = `${subjectType}|${subjectKey}|${source}|${sourceRef}`
    if (this.provenance.has(id)) return
    const contributions = [...o.contributions].sort((a, b) => a.at.localeCompare(b.at))
    this.provenance.set(id, {
      subjectType,
      subjectKey,
      source,
      trust: derivation ? 'deterministic-derivation' : o.type === 'source-finding' ? 'source-analysis' : 'runtime-observation',
      sourceRef,
      observationId: o.id,
      evidenceRefs: uniq(o.evidenceRefs),
      executionIds: uniq(contributions.map((c) => c.executionId)),
      capabilityIds: uniq(contributions.map((c) => c.capabilityId)),
      tools: uniq(contributions.map((c) => c.tool)).sort(),
      confidence: derivation ? derivation.confidence : o.confidence,
      rationale: derivation ? derivation.rationale.slice(0, 400) : null,
      firstAt: o.firstSeenAt,
      lastAt: o.lastSeenAt,
    })
    const entities = this.observationsByEntity.get(subjectKey) ?? new Set<string>()
    entities.add(o.id)
    this.observationsByEntity.set(subjectKey, entities)
  }

  /**
   * A provenance row from a domain declaration or a comparison derivation. A declaration carries no
   * evidence/tools/executions; a comparison derivation (Step 5) carries the evidence refs and execution ids
   * that back it, so a derived fact keeps provenance to the comparison that produced it.
   */
  declare(
    subjectType: 'node' | 'edge',
    subjectKey: string,
    p: { sourceRef: string; source: ProvenanceSource; trust: SourceTrust; confidence: number; rationale: string | null; at: string; evidenceRefs?: string[]; executionIds?: string[]; capabilityIds?: string[] },
  ): void {
    const id = `${subjectType}|${subjectKey}|${p.source}|${p.sourceRef}`
    if (this.provenance.has(id)) return
    this.provenance.set(id, {
      subjectType,
      subjectKey,
      source: p.source,
      trust: p.trust,
      sourceRef: p.sourceRef,
      observationId: null,
      evidenceRefs: uniq(p.evidenceRefs ?? []),
      executionIds: uniq(p.executionIds ?? []),
      capabilityIds: uniq(p.capabilityIds ?? []),
      tools: [],
      confidence: p.confidence,
      rationale: p.rationale ? p.rationale.slice(0, 400) : null,
      firstAt: p.at,
      lastAt: p.at,
    })
  }

  /** Host + endpoint + HOSTS (+ query parameters) for a URL an observation is about. */
  url(o: SecurityObservation, url: string): { parts: UrlParts; host: string; endpoint: string } | null {
    const parts = urlParts(url)
    if (!parts) return null
    const host = this.node('host', hostKey(parts.origin), parts.origin, this.scope(parts.origin))
    const endpoint = this.node('endpoint', endpointKey(parts.origin, parts.path), parts.path, this.scope(endpointUrl(parts.origin, parts.path)))
    this.attr(endpoint, 'url', endpointUrl(parts.origin, parts.path))
    const hosts = this.edge('HOSTS', host, endpoint)
    this.support('node', host, o)
    this.support('node', endpoint, o)
    this.support('edge', hosts, o)
    this.add(endpoint, 'observedVia', o.type)
    for (const name of parts.query) this.parameter(o, endpoint, 'query', name)
    return { parts, host, endpoint }
  }

  parameter(o: SecurityObservation, ownerKey: string, location: ParameterLocation, name: string) {
    const param = this.node('parameter', parameterKey(ownerKey, location, name), name)
    this.attr(param, 'location', location)
    this.attr(param, 'name', name)
    const reads = this.edge('READS', ownerKey, param)
    this.support('node', param, o)
    this.support('edge', reads, o)
  }

  status(endpoint: string, status: number, o: SecurityObservation) {
    this.attr(endpoint, 'status', status)
    const latest = [...o.contributions].sort((a, b) => b.at.localeCompare(a.at))[0]
    this.statusSources.set(endpoint, { status, observationId: o.id, executionId: latest?.executionId ?? null, at: o.lastSeenAt })
  }

  technology(o: SecurityObservation, host: string, endpointPath: string | null, raw: string, via: string, derivation?: { rule: string; confidence: number; rationale: string }) {
    const tech = via === 'fingerprint' ? parseTechnology(raw) : parseServerHeader(raw)
    if (!tech) return
    const key = this.node('technology', technologyKey(tech.name), tech.display)
    this.attr(key, 'name', tech.name)
    this.add(key, 'versions', tech.version)
    this.add(key, 'via', via)
    const depends = this.edge('DEPENDS_ON', host, key)
    this.add(depends, 'via', via)
    this.add(depends, 'versions', tech.version)
    if (endpointPath) this.add(depends, 'seenOn', endpointPath)
    // Latest version per tool, for version-conflict detection (observations are processed oldest first).
    if (tech.version) {
      const fact = this.edges.get(depends)!
      const byTool = { ...((fact.attributes.versionByTool as Record<string, string> | undefined) ?? {}) }
      for (const tool of new Set(o.contributions.map((c) => c.tool))) byTool[tool] = tech.version
      fact.attributes.versionByTool = byTool
    }
    this.support('node', key, o, derivation)
    this.support('edge', depends, o, derivation)
  }

  signal(o: SecurityObservation, affectedKey: string, assetKey: string) {
    const key = this.node('signal', signalKey(o.type, o.subject, assetKey), o.title, this.nodes.get(affectedKey)?.scopeClass ?? null)
    this.attr(key, 'observationType', o.type)
    this.attr(key, 'subject', o.subject)
    this.attr(key, 'sourceType', o.sourceType)
    for (const [name, value] of Object.entries(o.value)) {
      if (['templateId', 'toolSeverity', 'name', 'type', 'operation', 'checkId', 'severity', 'startLine', 'message'].includes(name)) this.attr(key, name, value)
    }
    const affects = this.edge('AFFECTS', key, affectedKey)
    this.support('node', key, o)
    this.support('edge', affects, o)
  }

  operation(o: SecurityObservation, baseUrl: string, label: string): string | null {
    const parts = urlParts(baseUrl)
    const op = parseOperation(label)
    if (!parts || !op) return null
    const host = this.node('host', hostKey(parts.origin), parts.origin, this.scope(parts.origin))
    const key = this.node('api-operation', apiOperationKey(parts.origin, parts.path, op.method, op.template), `${op.method} ${op.template}`, this.scope(endpointUrl(parts.origin, parts.path)))
    this.attr(key, 'method', op.method)
    this.attr(key, 'template', op.template)
    this.attr(key, 'origin', parts.origin)
    this.attr(key, 'basePath', parts.path)
    this.attr(key, 'concreteUrl', concreteOperationUrl(parts.origin, parts.path, op.template))
    const exposes = this.edge('EXPOSES', host, key)
    this.support('node', host, o)
    this.support('node', key, o)
    this.support('edge', exposes, o)
    for (const name of templateParameters(op.template)) this.parameter(o, key, 'path', name)
    return key
  }

  result(): DesiredGraph {
    const finish = <T extends { attributes: Record<string, unknown>; sets: Map<string, Set<string>> }>(fact: T) => {
      const { sets, ...rest } = fact
      const attributes: Record<string, unknown> = { ...rest.attributes }
      for (const [name, set] of sets) attributes[name] = [...set].sort().slice(0, MAX_SET)
      return { ...rest, attributes }
    }
    return {
      nodes: new Map([...this.nodes].map(([k, v]) => [k, finish(v) as DesiredNode])),
      edges: new Map([...this.edges].map(([k, v]) => [k, finish(v) as DesiredEdge])),
      provenance: [...this.provenance.values()],
      statusSources: this.statusSources,
      observationsByEntity: new Map([...this.observationsByEntity].map(([k, v]) => [k, [...v].sort()])),
      unprojected: this.unprojected,
    }
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function resolveUrl(value: string, base: string): string | null {
  try {
    return new URL(value, base).toString()
  } catch {
    return null
  }
}

function projectOne(b: Builder, o: SecurityObservation): void {
  switch (o.type) {
    case 'http-response': {
      const at = b.url(o, o.asset)
      if (!at) break
      const status = num(o.value.status)
      if (status !== null) b.status(at.endpoint, status, o)
      b.attr(at.endpoint, 'title', str(o.value.title))
      b.attr(at.endpoint, 'contentType', str(o.value.contentType))
      b.add(at.endpoint, 'methods', (str(o.value.method) ?? 'GET').toUpperCase())
      break
    }
    case 'endpoint': {
      const at = b.url(o, o.asset)
      if (!at) break
      b.add(at.endpoint, 'methods', o.subject.toUpperCase())
      const status = o.value.contacted === false ? null : num(o.value.status)
      if (status !== null) b.status(at.endpoint, status, o)
      b.add(at.endpoint, 'discoveredFrom', str(o.value.source))
      break
    }
    case 'http-header': {
      const at = b.url(o, o.asset)
      if (!at) break
      const header = (str(o.value.header) ?? o.subject).toLowerCase()
      const value = str(o.value.value)
      if (value) b.attr(at.endpoint, `header:${header}`, value.slice(0, 200))
      if (header === 'server' && value) {
        b.technology(o, at.host, at.parts.path, value, 'server-header', {
          rule: 'server-header-technology',
          confidence: 0.8,
          rationale: `Parsed from the Server response header "${value.slice(0, 80)}"`,
        })
      }
      break
    }
    case 'technology': {
      const at = b.url(o, o.asset)
      if (!at) break
      b.technology(o, at.host, at.parts.path, str(o.value.technology) ?? o.subject, 'fingerprint')
      break
    }
    case 'form': {
      const page = b.url(o, o.asset)
      if (!page) break
      const actionUrl = resolveUrl(str(o.value.action) ?? o.asset, o.asset)
      const action = actionUrl ? b.url(o, actionUrl) : null
      if (!action) break
      const method = (str(o.value.method) ?? 'GET').toUpperCase()
      b.add(action.endpoint, 'methods', method)
      b.add(action.endpoint, 'formMethods', method)
      const calls = b.edge('CALLS', page.endpoint, action.endpoint)
      b.add(calls, 'methods', method)
      b.support('edge', calls, o)
      const parameters = Array.isArray(o.value.parameters) ? o.value.parameters.filter((p): p is string => typeof p === 'string') : []
      for (const name of parameters.slice(0, 30)) b.parameter(o, action.endpoint, 'form', name.slice(0, 80))
      break
    }
    case 'redirect': {
      const from = b.url(o, o.asset)
      const destination = str(o.value.destination)
      const to = destination ? b.url(o, destination) : null
      if (!from || !to) break
      const redirect = b.edge('REDIRECTS_TO', from.endpoint, to.endpoint)
      b.attr(redirect, 'status', num(o.value.status))
      b.attr(redirect, 'followed', o.value.followed === true)
      b.support('edge', redirect, o)
      break
    }
    case 'api-operation': {
      b.operation(o, o.asset, str(o.value.operation) ?? o.subject)
      break
    }
    case 'api-validation': {
      const operation = str(o.value.operation)
      const op = operation ? b.operation(o, o.asset, operation) : null
      const parts = urlParts(o.asset)
      if (!parts) break
      const host = b.node('host', hostKey(parts.origin), parts.origin, b.scope(parts.origin))
      b.support('node', host, o)
      b.signal(o, op ?? host, op ?? host)
      break
    }
    case 'api-workflow': {
      const parts = urlParts(o.asset)
      if (!parts) break
      const host = b.node('host', hostKey(parts.origin), parts.origin, b.scope(parts.origin))
      b.support('node', host, o)
      b.signal(o, host, host)
      break
    }
    case 'web-signal': {
      const at = b.url(o, o.asset)
      if (!at) break
      b.signal(o, at.endpoint, at.endpoint)
      // A server-banner template extracts the Server header value: an independent technology report.
      const extracted = Array.isArray(o.value.extracted) ? o.value.extracted.filter((v): v is string => typeof v === 'string') : []
      if (o.value.templateId === 'audivra-server-banner' && extracted[0]) {
        b.technology(o, at.host, at.parts.path, extracted[0], 'server-banner', {
          rule: 'server-banner-technology',
          confidence: 0.7,
          rationale: `Extracted from the Server header by the server-banner template ("${extracted[0].slice(0, 80)}")`,
        })
      }
      break
    }
    case 'source-finding': {
      const path = (str(o.value.path) ?? o.asset).slice(0, 1024)
      const file = b.node('source-file', sourceFileKey(path), path)
      b.support('node', file, o)
      b.signal(o, file, file)
      break
    }
    case 'dependency-vulnerability':
    case 'oast-interaction':
    case 'tls-config': {
      const at = b.url(o, o.asset)
      if (!at) {
        b.unprojected[o.type] = (b.unprojected[o.type] ?? 0) + 1
        break
      }
      b.signal(o, at.endpoint, at.endpoint)
      break
    }
    case 'service':
    case 'traffic-flow': {
      if (!b.url(o, o.asset)) b.unprojected[o.type] = (b.unprojected[o.type] ?? 0) + 1
      break
    }
    default:
      b.unprojected[o.type] = (b.unprojected[o.type] ?? 0) + 1
  }
}

/** Endpoints that are concrete instances of an API operation's path template (deterministic derivation). */
function deriveTemplateMatches(b: Builder, observations: Map<string, SecurityObservation>): void {
  const operations = [...b.nodes.values()].filter((n) => n.kind === 'api-operation')
  if (operations.length === 0) return
  const endpoints = [...b.nodes.values()].filter((n) => n.kind === 'endpoint')
  for (const op of operations) {
    const origin = String(op.attributes.origin ?? '')
    const basePath = String(op.attributes.basePath ?? '/')
    const template = String(op.attributes.template ?? '')
    for (const endpoint of endpoints) {
      if (!endpoint.key.startsWith(`endpoint:${origin}/`) && endpoint.key !== `endpoint:${origin}`) continue
      const path = endpoint.key.slice(`endpoint:${origin}`.length) || '/'
      if (!matchesTemplate(path, basePath, template)) continue
      const belongs = b.edge('BELONGS_TO', endpoint.key, op.key)
      // The derivation is supported by the observations that established the endpoint.
      for (const observationId of b.observationsByEntity.get(endpoint.key) ?? []) {
        const o = observations.get(observationId)
        if (o) b.support('edge', belongs, o, { rule: 'path-template-match', confidence: 0.9, rationale: `${path} matches the API path template ${template}` })
      }
    }
  }
}

/** Projects observations into an existing builder (shared by observation-only and combined projection). */
export function projectObservationsInto(b: Builder, observations: readonly SecurityObservation[]): void {
  const sorted = [...observations].sort(byTimeThenId)
  for (const o of sorted) projectOne(b, o)
  deriveTemplateMatches(b, new Map(sorted.map((o) => [o.id, o])))
}

/** Projects observations into the desired deterministic graph. Pure and order-independent. */
export function projectObservations(observations: readonly SecurityObservation[], manifest: ScopeManifest): DesiredGraph {
  const b = new Builder(manifest)
  projectObservationsInto(b, observations)
  return b.result()
}
