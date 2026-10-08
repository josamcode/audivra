import {
  classifyIp,
  isLocalhostName,
  isSameOrSubdomain,
  parseIp,
  type AuthorizationMethod,
  type AuthorizationMethodInfo,
  type AuthorizationSubject,
  type EffectiveAuthorizationStatus,
  type PolicyDecision,
  type ScopeManifest,
  type SecurityAuthorizationItem,
} from '@audivra/contracts'
import type { AuthorizationRow } from '@audivra/database'
import type { Resolver } from './dns.ts'

/*
 * Authorization: the difference between "a target the user typed" and "a target Audivra may assess".
 * Validity is computed here from stored records and the clock — never from what a model says.
 */

export type AuthorizationState = PolicyDecision['authorization']['state']

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 }

/** Local development authorizations last a week, so a forgotten one does not stay valid forever. */
export const LOCAL_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function effectiveAuthorizationStatus(
  record: { status: SecurityAuthorizationItem['status']; expiresAt: Date | string | null },
  now: Date,
): EffectiveAuthorizationStatus {
  if (record.status === 'verified' && record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime()) return 'expired'
  return record.status
}

export function toAuthorizationItem(row: AuthorizationRow, now: Date): SecurityAuthorizationItem {
  return {
    id: row.id,
    engagementId: row.engagementId,
    method: row.method,
    status: row.status,
    effectiveStatus: effectiveAuthorizationStatus(row, now),
    subject: row.subject,
    reason: row.reason,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    reference: row.reference,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Whether a subject covers a host and port (subdomains only when the subject says so). */
export function subjectCovers(subject: AuthorizationSubject, host: string, port: number | null): boolean {
  const subjectIp = parseIp(subject.host)
  const hostIp = parseIp(host)
  const hostMatches = subjectIp || hostIp
    ? subjectIp !== null && hostIp !== null && subjectIp.text === hostIp.text
    : subject.includeSubdomains
      ? isSameOrSubdomain(host, subject.host)
      : subject.host === host
  return hostMatches && (subject.port === null || subject.port === port)
}

const STATE_PRIORITY: AuthorizationState[] = ['expired', 'revoked', 'pending', 'failed']

/** Authorization of one destination: valid when at least one verified, unexpired record covers it. */
export function evaluateAuthorizationCoverage(
  authorizations: SecurityAuthorizationItem[],
  destination: { host: string; port: number | null },
): { state: AuthorizationState; authorizationIds: string[]; reason: string } {
  const covering = authorizations.filter((a) => subjectCovers(a.subject, destination.host, destination.port))
  const valid = covering.filter((a) => a.effectiveStatus === 'verified')
  const target = `${destination.host}${destination.port ? `:${destination.port}` : ''}`
  if (valid.length) {
    return { state: 'valid', authorizationIds: valid.map((a) => a.id), reason: `${target} is covered by a verified authorization` }
  }
  for (const state of STATE_PRIORITY) {
    const match = covering.find((a) => a.effectiveStatus === state)
    if (match) return { state, authorizationIds: [match.id], reason: `The authorization covering ${target} is ${state}` }
  }
  return { state: 'missing', authorizationIds: [], reason: `No authorization covers ${target}` }
}

/** Scope targets that no valid authorization covers (blocking readiness when non-empty). */
export function authorizationGaps(manifest: ScopeManifest, authorizations: SecurityAuthorizationItem[]): string[] {
  const gaps: string[] = []
  const valid = authorizations.filter((a) => a.effectiveStatus === 'verified')
  for (const rule of manifest.hosts) {
    const schemes = rule.schemes ?? manifest.protocols
    const ports = rule.ports ?? manifest.ports ?? schemes.map((s) => DEFAULT_PORTS[s]!)
    for (const port of ports) {
      const covered = valid.some(
        (a) => subjectCovers(a.subject, rule.host, port) && (!rule.includeSubdomains || a.subject.includeSubdomains || parseIp(rule.host) !== null),
      )
      if (!covered) gaps.push(`${rule.host}${rule.includeSubdomains ? ' (and subdomains)' : ''} port ${port}`)
    }
  }
  for (const address of manifest.networks.addresses) {
    if (!valid.some((a) => subjectCovers(a.subject, address, null))) gaps.push(`address ${address}`)
  }
  for (const block of manifest.networks.cidrs) gaps.push(`network ${block} (no available method can authorize a network block yet)`)
  return gaps
}

// ── Verification methods ────────────────────────────────────────────────────────────────────────────

export interface VerificationOutcome {
  status: 'verified' | 'failed'
  reason: string
  expiresAt: Date | null
  metadata: Record<string, unknown>
}

export interface AuthorizationProvider {
  method: AuthorizationMethod
  label: string
  description: string
  /** Null when usable; otherwise why not (shown to the user, never silently skipped). */
  unavailableReason: string | null
  verify?(subject: AuthorizationSubject, deps: { resolver: Resolver; now: Date }): Promise<VerificationOutcome>
}

/**
 * Local development: proves the subject is this machine, which the person running Audivra controls.
 * Only loopback IP literals and `localhost` names qualify, each name must resolve to loopback addresses
 * only, and the authorization is per port (other local services are not covered). It says nothing about
 * any other host, so it can never authorize a remote target.
 */
export const localDevelopmentProvider: AuthorizationProvider = {
  method: 'local-development',
  label: 'Local development (this machine)',
  description: 'For targets running on this computer (localhost / loopback addresses), one port at a time. Valid for 7 days.',
  unavailableReason: null,
  async verify(subject, { resolver, now }) {
    const fail = (reason: string, metadata: Record<string, unknown> = {}): VerificationOutcome => ({
      status: 'failed',
      reason,
      expiresAt: null,
      metadata: { rule: 'loopback-only', checkedAt: now.toISOString(), ...metadata },
    })
    if (subject.includeSubdomains) return fail('Local development authorization never covers subdomains.')
    if (subject.port === null) return fail('Local development authorization is per port: choose the port of the local target.')
    const ip = parseIp(subject.host)
    if (ip) {
      if (classifyIp(ip) !== 'loopback') return fail(`${subject.host} is not a loopback address of this machine.`, { category: classifyIp(ip) })
    } else if (!isLocalhostName(subject.host)) {
      return fail(`${subject.host} is not a localhost name; only loopback targets can be authorized locally.`)
    }
    let addresses: string[]
    try {
      addresses = ip ? [ip.text] : await resolver(subject.host)
    } catch (error) {
      return fail(`Could not resolve ${subject.host}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const nonLoopback = addresses.filter((a) => {
      const parsed = parseIp(a)
      return !parsed || classifyIp(parsed) !== 'loopback'
    })
    if (addresses.length === 0 || nonLoopback.length) {
      return fail(`${subject.host} resolves to non-loopback addresses (${nonLoopback.join(', ') || 'none'}).`, { resolvedAddresses: addresses })
    }
    return {
      status: 'verified',
      reason: `${subject.host}:${subject.port} is a loopback target on this machine.`,
      expiresAt: new Date(now.getTime() + LOCAL_AUTHORIZATION_TTL_MS),
      metadata: { rule: 'loopback-only', checkedAt: now.toISOString(), resolvedAddresses: addresses },
    }
  },
}

const NOT_YET = 'Not available in this version of Audivra. Planned; until then it cannot authorize anything.'

/** Every modelled method. Unimplemented ones are reported as unavailable — never faked. */
export const AUTHORIZATION_PROVIDERS: Record<AuthorizationMethod, AuthorizationProvider> = {
  'local-development': localDevelopmentProvider,
  'dns-txt': { method: 'dns-txt', label: 'DNS TXT record', description: 'Publish a challenge value in a TXT record of the domain.', unavailableReason: NOT_YET },
  'well-known-file': { method: 'well-known-file', label: 'Well-known file', description: 'Serve a challenge file under /.well-known/ on the target.', unavailableReason: NOT_YET },
  repository: { method: 'repository', label: 'Repository ownership', description: 'Prove control of the source repository that deploys the target.', unavailableReason: NOT_YET },
  deployment: { method: 'deployment', label: 'Deployment integration', description: 'Authorization granted by a connected deployment platform.', unavailableReason: NOT_YET },
  'manual-approval': { method: 'manual-approval', label: 'Organization approval', description: 'Recorded approval by an authorized person in your organization.', unavailableReason: NOT_YET },
}

export function authorizationMethods(): AuthorizationMethodInfo[] {
  return Object.values(AUTHORIZATION_PROVIDERS).map((p) => ({
    method: p.method,
    label: p.label,
    description: p.description,
    available: p.unavailableReason === null && typeof p.verify === 'function',
    unavailableReason: p.unavailableReason,
  }))
}
