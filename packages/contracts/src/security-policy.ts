import { z } from 'zod'
import type { MutationClass, RiskClass, SecurityEnvironment } from './security-classes.ts'
import type { ExecutionLimits } from './security-scope.ts'

/*
 * Security policy profiles: versioned product assets (like audit templates and prompts), not environment
 * variables. An engagement pins a profile key *and* version, so a later profile change never rewrites
 * what an existing engagement allows; retired versions stay listed here for that reason.
 *
 * Per environment a profile states, for every risk and mutation class:
 *   allow    — permitted, included by default
 *   bounded  — permitted, included by default, executed under the stricter `bounded` limits
 *   opt-in   — permitted only when the engagement explicitly lists the class
 *   deny     — never permitted, whatever the engagement says
 * and the hard ceilings for every execution limit.
 */

export const POLICY_PERMISSIONS = ['allow', 'bounded', 'opt-in', 'deny'] as const
export type PolicyPermission = (typeof POLICY_PERMISSIONS)[number]

export const POLICY_PERMISSION_INFO: Record<PolicyPermission, { label: string; description: string }> = {
  allow: { label: 'Allowed', description: 'Permitted by default.' },
  bounded: { label: 'Bounded', description: 'Permitted by default under stricter limits.' },
  'opt-in': { label: 'Explicit opt-in', description: 'Permitted only if the engagement explicitly selects it.' },
  deny: { label: 'Denied', description: 'Never permitted in this environment.' },
}

export interface EnvironmentPolicy {
  risk: Record<RiskClass, PolicyPermission>
  mutation: Record<MutationClass, Exclude<PolicyPermission, 'bounded'>>
  /** Third-party services a capability may call (callback hosts, external APIs). */
  externalIntegrations: 'opt-in' | 'deny'
  ceilings: ExecutionLimits
  /** Limits applied to capabilities whose risk class is `bounded` here. */
  bounded: ExecutionLimits
}

export interface SecurityPolicyProfile {
  key: PolicyProfileKey
  version: number
  name: string
  description: string
  /** Retired versions remain resolvable for engagements pinned to them but are not offered for new ones. */
  retired?: boolean
  environments: Record<SecurityEnvironment, EnvironmentPolicy>
}

export const POLICY_PROFILE_KEYS = ['standard', 'observe-only'] as const
export const PolicyProfileKey = z.enum(POLICY_PROFILE_KEYS)
export type PolicyProfileKey = z.infer<typeof PolicyProfileKey>
export const DEFAULT_POLICY_PROFILE_KEY: PolicyProfileKey = 'standard'

const PRODUCTION_CEILINGS: ExecutionLimits = {
  maxRequests: 1000,
  requestsPerSecond: 2,
  concurrency: 2,
  executionTimeoutSeconds: 900,
  maxResponseBytes: 5_000_000,
  maxArtifactMb: 250,
}
const PRODUCTION_BOUNDED: ExecutionLimits = {
  maxRequests: 200,
  requestsPerSecond: 1,
  concurrency: 1,
  executionTimeoutSeconds: 300,
  maxResponseBytes: 2_000_000,
  maxArtifactMb: 100,
}
const STAGING_CEILINGS: ExecutionLimits = {
  maxRequests: 5000,
  requestsPerSecond: 10,
  concurrency: 4,
  executionTimeoutSeconds: 3600,
  maxResponseBytes: 20_000_000,
  maxArtifactMb: 1000,
}
const LAB_CEILINGS: ExecutionLimits = {
  maxRequests: 50_000,
  requestsPerSecond: 50,
  concurrency: 16,
  executionTimeoutSeconds: 14_400,
  maxResponseBytes: 50_000_000,
  maxArtifactMb: 5000,
}

const OBSERVE_ONLY: Omit<EnvironmentPolicy, 'ceilings' | 'bounded'> = {
  risk: { passive: 'allow', 'low-impact': 'deny', 'state-changing': 'deny', 'high-impact': 'deny', destructive: 'deny' },
  mutation: { 'read-only': 'allow', 'transient-state': 'deny', 'reversible-write': 'deny', 'irreversible-write': 'deny' },
  externalIntegrations: 'deny',
}

export const SECURITY_POLICY_PROFILES: readonly SecurityPolicyProfile[] = [
  {
    key: 'standard',
    version: 1,
    name: 'Standard',
    description: 'Production stays near passive; staging and isolated labs allow more, with anything risky requiring an explicit opt-in.',
    environments: {
      production: {
        risk: { passive: 'allow', 'low-impact': 'bounded', 'state-changing': 'opt-in', 'high-impact': 'deny', destructive: 'deny' },
        mutation: { 'read-only': 'allow', 'transient-state': 'opt-in', 'reversible-write': 'opt-in', 'irreversible-write': 'deny' },
        externalIntegrations: 'deny',
        ceilings: PRODUCTION_CEILINGS,
        bounded: PRODUCTION_BOUNDED,
      },
      staging: {
        risk: { passive: 'allow', 'low-impact': 'allow', 'state-changing': 'opt-in', 'high-impact': 'opt-in', destructive: 'deny' },
        mutation: { 'read-only': 'allow', 'transient-state': 'allow', 'reversible-write': 'opt-in', 'irreversible-write': 'deny' },
        externalIntegrations: 'opt-in',
        ceilings: STAGING_CEILINGS,
        bounded: STAGING_CEILINGS,
      },
      'isolated-lab': {
        risk: { passive: 'allow', 'low-impact': 'allow', 'state-changing': 'allow', 'high-impact': 'opt-in', destructive: 'opt-in' },
        mutation: { 'read-only': 'allow', 'transient-state': 'allow', 'reversible-write': 'allow', 'irreversible-write': 'opt-in' },
        externalIntegrations: 'opt-in',
        ceilings: LAB_CEILINGS,
        bounded: LAB_CEILINGS,
      },
    },
  },
  {
    key: 'observe-only',
    version: 1,
    name: 'Observe only',
    description: 'Passive, read-only capabilities in every environment. Nothing else can ever be enabled.',
    environments: {
      production: { ...OBSERVE_ONLY, ceilings: PRODUCTION_BOUNDED, bounded: PRODUCTION_BOUNDED },
      staging: { ...OBSERVE_ONLY, ceilings: PRODUCTION_CEILINGS, bounded: PRODUCTION_CEILINGS },
      'isolated-lab': { ...OBSERVE_ONLY, ceilings: STAGING_CEILINGS, bounded: STAGING_CEILINGS },
    },
  },
]

export function findPolicyProfile(key: string, version: number): SecurityPolicyProfile | undefined {
  return SECURITY_POLICY_PROFILES.find((p) => p.key === key && p.version === version)
}

/** Newest non-retired version of a profile (used for new engagements). */
export function currentPolicyProfile(key: PolicyProfileKey = DEFAULT_POLICY_PROFILE_KEY): SecurityPolicyProfile {
  const candidates = SECURITY_POLICY_PROFILES.filter((p) => p.key === key && !p.retired)
  const latest = candidates.sort((a, b) => b.version - a.version)[0]
  if (!latest) throw new Error(`Unknown policy profile ${key}`)
  return latest
}
