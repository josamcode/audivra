import type { ImpactClass, SecurityFinding, StartCondition, TrustBoundaryKind } from '@audivra/contracts'

/*
 * Phase 6B — the conservative, deterministic mapping from a verified/supported finding to what it actually
 * ENABLES: the start condition it requires, the entities it grants access to, the structured impact it
 * demonstrates, and the trust boundary it crosses. This is derived from the finding's category, its affected
 * entities, its severity inputs and its reproduction record — never from an AI freely deciding that one
 * finding "means" admin access. A gap in the mapping stays a gap.
 */

export interface FindingEnablement {
  /** The start condition the finding requires to be exploited. */
  precondition: StartCondition
  /** Graph node keys of the entities the finding demonstrates access to / impact on. */
  grantedEntityKeys: string[]
  /** The subject principal's graph node key, when the finding was exploited as an identity. */
  principalKey: string | null
  impact: ImpactClass
  impactLabel: string
  boundary: TrustBoundaryKind | null
}

/** How much "further" an impact gets you — used to order escalation chains (greater impact later). */
export const IMPACT_RANK: Record<ImpactClass, number> = {
  'unauthorized-data-access': 1,
  'cross-tenant-access': 2,
  'unauthorized-state-change': 3,
  'privilege-boundary-crossed': 4,
  'sensitive-capability-reached': 4,
  'security-control-bypassed': 5,
}

const CATEGORY_IMPACT: Record<string, { impact: ImpactClass; boundary: TrustBoundaryKind | null }> = {
  'tenant-isolation': { impact: 'cross-tenant-access', boundary: 'tenant' },
  authorization: { impact: 'unauthorized-data-access', boundary: null },
  'business-logic': { impact: 'unauthorized-state-change', boundary: 'business-state' },
  'session-management': { impact: 'security-control-bypassed', boundary: 'authentication' },
  authentication: { impact: 'security-control-bypassed', boundary: 'authentication' },
  'api-behavior': { impact: 'sensitive-capability-reached', boundary: null },
  exposure: { impact: 'sensitive-capability-reached', boundary: null },
  configuration: { impact: 'security-control-bypassed', boundary: null },
  dependency: { impact: 'sensitive-capability-reached', boundary: null },
  'transport-tls': { impact: 'security-control-bypassed', boundary: null },
  'source-runtime-inconsistency': { impact: 'sensitive-capability-reached', boundary: null },
}

export function findingEnablement(finding: SecurityFinding): FindingEnablement {
  const identity = finding.affectedEntities.find((e) => e.kind === 'identity')
  const resources = finding.affectedEntities.filter((e) => e.kind === 'resource' || e.kind === 'business-action' || e.kind === 'endpoint' || e.kind === 'api-operation')
  const subjectArm = finding.reproduction?.arms.find((a) => a.role === 'subject') ?? null

  const principalKey = identity?.key ?? null
  const precondition: StartCondition = principalKey
    ? { kind: 'authenticated-identity', identityRef: subjectArm?.identityRef ?? identity?.label ?? null, entityKey: principalKey, label: `authenticated as ${identity?.label ?? subjectArm?.identityRef ?? 'a test identity'}` }
    : subjectArm && subjectArm.identityRef === null
      ? { kind: 'anonymous', identityRef: null, entityKey: null, label: 'an anonymous client' }
      : { kind: 'authenticated-identity', identityRef: subjectArm?.identityRef ?? null, entityKey: null, label: 'an authenticated identity' }

  const base = CATEGORY_IMPACT[finding.category] ?? { impact: 'sensitive-capability-reached', boundary: null }
  // A privilege boundary crossing (role/function) is a stronger, explicit impact than plain data access.
  const privilegeCrossed = finding.severityInputs.privilegeBoundaryCrossed
  const impact: ImpactClass = finding.category === 'authorization' && privilegeCrossed ? 'privilege-boundary-crossed' : base.impact
  const boundary: TrustBoundaryKind | null = finding.severityInputs.tenantBoundaryCrossed ? 'tenant' : privilegeCrossed ? 'role' : base.boundary

  const grantedEntityKeys = [...new Set(resources.map((r) => r.key))]
  const impactLabel = resources[0]?.label ? `${impactWords(impact)} on ${resources[0].label}` : impactWords(impact)
  return { precondition, grantedEntityKeys, principalKey, impact, impactLabel, boundary }
}

function impactWords(impact: ImpactClass): string {
  switch (impact) {
    case 'unauthorized-data-access':
      return 'unauthorized data access'
    case 'cross-tenant-access':
      return 'cross-tenant access'
    case 'unauthorized-state-change':
      return 'unauthorized state change'
    case 'privilege-boundary-crossed':
      return 'a privilege boundary crossed'
    case 'sensitive-capability-reached':
      return 'a sensitive capability reached'
    case 'security-control-bypassed':
      return 'a security control bypassed'
  }
}

export { impactWords }
