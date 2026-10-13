import { domainSourceMapping, type DomainDeclarationKind, type DomainSource, type ScopeManifest, type SecurityObservation } from '@audivra/contracts'
import { businessActionKey, businessStateKey, identityKey, invariantKey, resourceKey, roleKey, tenantKey } from './identity.ts'
import { Builder, projectObservationsInto, type DesiredGraph } from './project.ts'

/*
 * The deterministic domain projector: declared application-semantics records (identities, roles, tenants,
 * resources, business actions/states, invariants) in, graph nodes/edges with `user-declaration` provenance
 * out. Pure and order-independent, exactly like the observation projector, so re-projection is idempotent.
 *
 * Two passes: pass 1 creates every node (so every key exists), pass 2 creates edges by resolving a
 * declaration's references to the keys of other declarations. An unresolvable reference produces no edge —
 * `UNKNOWN != FALSE`, never an invented target. A `credentialRef` is never copied onto a node: only the
 * fact that a credential is configured.
 */

/** A declaration as the projector sees it (the stored row, with ISO timestamps). */
export interface DomainDeclaration {
  id: string
  kind: DomainDeclarationKind
  ref: string
  key: string
  label: string
  source: DomainSource
  confidence: number
  spec: Record<string, unknown>
  firstAt: string
  lastAt: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Deterministic key for a declaration (the service computes and stores the same; this re-derives for tests). */
export function declarationKey(kind: DomainDeclarationKind, ref: string, spec: Record<string, unknown>): string {
  switch (kind) {
    case 'identity':
      return identityKey(ref)
    case 'tenant':
      return tenantKey(ref, str(spec.externalId))
    case 'role':
      return roleKey(ref, str(spec.scopeTenantRef))
    case 'resource':
      return resourceKey(str(spec.resourceType) ?? 'resource', { externalId: str(spec.externalId), canonicalUrl: str(spec.canonicalUrl), ref })
    case 'business-action':
      return businessActionKey(str(spec.verb) ?? ref, str(spec.actsOnResourceType))
    case 'business-state':
      return businessStateKey(str(spec.name) ?? ref, str(spec.resourceType))
    case 'invariant':
      // The invariant key needs its affected-entity tokens; computed from the raw affects list.
      return invariantKey(str(spec.category) ?? 'other', affectTokens(spec), str(spec.rule) ?? ref)
  }
}

function affectTokens(spec: Record<string, unknown>): string[] {
  const affects = Array.isArray(spec.affects) ? spec.affects : []
  return affects
    .map((a) => {
      if (a && typeof a === 'object' && 'nodeKey' in a && typeof (a as { nodeKey: unknown }).nodeKey === 'string') return `node:${(a as { nodeKey: string }).nodeKey}`
      if (a && typeof a === 'object' && 'kind' in a && 'ref' in a) return `${String((a as { kind: unknown }).kind)}:${String((a as { ref: unknown }).ref)}`
      return null
    })
    .filter((t): t is string => !!t)
}

function nodeAttributes(b: Builder, kind: DomainDeclarationKind, key: string, spec: Record<string, unknown>): void {
  switch (kind) {
    case 'identity':
      b.attr(key, 'identityType', str(spec.identityType))
      b.attr(key, 'authMethod', str(spec.authMethod))
      b.attr(key, 'lifecycle', str(spec.lifecycle))
      // The reference itself is never stored on the node — only whether a credential is configured.
      b.attr(key, 'credentialConfigured', str(spec.credentialRef) !== null)
      break
    case 'tenant':
      b.attr(key, 'tenantType', str(spec.tenantType))
      b.attr(key, 'externalId', str(spec.externalId))
      break
    case 'resource':
      b.attr(key, 'resourceType', str(spec.resourceType))
      b.attr(key, 'testData', str(spec.testData))
      b.attr(key, 'externalId', str(spec.externalId))
      b.attr(key, 'canonicalUrl', str(spec.canonicalUrl))
      b.attr(key, 'endpoint', str(spec.endpointUrl))
      break
    case 'business-action':
      b.attr(key, 'verb', str(spec.verb))
      b.attr(key, 'effectClass', str(spec.effectClass))
      b.attr(key, 'actsOnResourceType', str(spec.actsOnResourceType))
      break
    case 'business-state':
      b.attr(key, 'resourceType', str(spec.resourceType))
      b.attr(key, 'terminal', spec.terminal === true)
      break
    case 'invariant':
      b.attr(key, 'category', str(spec.category))
      b.attr(key, 'rule', str(spec.rule))
      b.attr(key, 'status', str(spec.status))
      b.attr(key, 'expectation', str(spec.expectation))
      break
    case 'role':
      b.attr(key, 'scopedToTenant', str(spec.scopeTenantRef) !== null)
      break
  }
}

/** Projects declared domain records into an existing builder (observations should be projected first). */
export function projectDeclarationsInto(b: Builder, declarations: readonly DomainDeclaration[]): void {
  const index = new Map<string, DomainDeclaration>()
  for (const d of declarations) index.set(`${d.kind}|${d.ref}`, d)
  const resolve = (kind: DomainDeclarationKind, ref: string | null): string | null => (ref ? (index.get(`${kind}|${ref}`)?.key ?? null) : null)
  const conf = (d: DomainDeclaration): number => Math.min(d.confidence, domainSourceMapping(d.source).confidenceCap)
  const declareOn = (subjectType: 'node' | 'edge', subjectKey: string, d: DomainDeclaration) => {
    const m = domainSourceMapping(d.source)
    b.declare(subjectType, subjectKey, { sourceRef: d.id, source: m.provenanceSource, trust: m.trust, confidence: conf(d), rationale: null, at: d.lastAt })
  }
  const link = (type: Parameters<Builder['edge']>[0], fromKey: string | null, toKey: string | null, by: DomainDeclaration): string | null => {
    if (!fromKey || !toKey) return null
    const ek = b.edge(type, fromKey, toKey)
    declareOn('edge', ek, by)
    return ek
  }

  // Pass 1: every node (so every key exists for pass 2).
  for (const d of declarations) {
    b.node(d.kind, d.key, d.label, null)
    nodeAttributes(b, d.kind, d.key, d.spec)
    declareOn('node', d.key, d)
  }

  // Pass 2: edges, resolving references to keys.
  for (const d of declarations) {
    const spec = d.spec
    switch (d.kind) {
      case 'identity': {
        for (const roleRef of strList(spec.roleRefs)) link('HAS_ROLE', d.key, resolve('role', roleRef), d)
        link('BELONGS_TO_TENANT', d.key, resolve('tenant', str(spec.tenantRef)), d)
        break
      }
      case 'role': {
        link('BELONGS_TO_TENANT', d.key, resolve('tenant', str(spec.scopeTenantRef)), d)
        for (const actionRef of strList(spec.permits)) link('PERMITS', d.key, resolve('business-action', actionRef), d)
        break
      }
      case 'resource': {
        link('BELONGS_TO_TENANT', d.key, resolve('tenant', str(spec.tenantRef)), d)
        link('OWNS', resolve('identity', str(spec.ownerRef)), d.key, d)
        link('HAS_STATE', d.key, resolve('business-state', str(spec.currentStateRef)), d)
        for (const stateRef of strList(spec.stateRefs)) link('HAS_STATE', d.key, resolve('business-state', stateRef), d)
        break
      }
      case 'business-action': {
        for (const resourceRef of strList(spec.actsOnRefs)) link('ACTS_ON', d.key, resolve('resource', resourceRef), d)
        for (const roleRef of strList(spec.requiredRoleRefs)) link('PERMITS', resolve('role', roleRef), d.key, d)
        const transition = link('TRANSITIONS_TO', resolve('business-state', str(spec.requiredStateRef)), resolve('business-state', str(spec.resultingStateRef)), d)
        if (transition) b.add(transition, 'via', d.ref)
        break
      }
      case 'business-state': {
        for (const stateRef of strList(spec.transitionsToRefs)) link('TRANSITIONS_TO', d.key, resolve('business-state', stateRef), d)
        break
      }
      case 'invariant': {
        const affects = Array.isArray(spec.affects) ? spec.affects : []
        for (const a of affects) {
          let targetKey: string | null = null
          if (a && typeof a === 'object' && 'nodeKey' in a) targetKey = str((a as { nodeKey: unknown }).nodeKey)
          else if (a && typeof a === 'object' && 'kind' in a && 'ref' in a) targetKey = resolve((a as { kind: DomainDeclarationKind }).kind, str((a as { ref: unknown }).ref))
          link('GOVERNED_BY', targetKey, d.key, d)
        }
        break
      }
      case 'tenant':
        break
    }
  }
}

/** Projects observations and declarations together into one deterministic desired graph. */
export function projectGraph(input: { observations: readonly SecurityObservation[]; declarations: readonly DomainDeclaration[]; manifest: ScopeManifest }): DesiredGraph {
  const b = new Builder(input.manifest)
  projectObservationsInto(b, input.observations)
  projectDeclarationsInto(b, input.declarations)
  return b.result()
}
