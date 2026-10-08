import {
  currentPolicyProfile,
  EXECUTION_LIMIT_KEYS,
  findPolicyProfile,
  MUTATION_CLASS_INFO,
  MUTATION_CLASSES,
  RISK_CLASS_INFO,
  RISK_CLASSES,
  SECURITY_ENVIRONMENT_INFO,
  type EffectivePermission,
  type EffectivePolicy,
  type EnvironmentPolicy,
  type ExecutionLimits,
  type PolicyPermission,
  type ScopeManifest,
  type SecurityCapabilityMetadata,
  type SecurityEnvironment,
} from '@audivra/contracts'

/*
 * Environment and risk policy. One function computes what an engagement may do (`effectivePolicy`), one
 * decides a single capability (`evaluateCapabilityPolicy`). There are no environment checks anywhere
 * else: callers pass the engagement's environment in and act on the structured result.
 *
 * Composition rule: the profile sets the outer bound per environment; the engagement can only narrow
 * it, except that `opt-in` classes need the engagement to select them explicitly. `deny` always wins.
 */

export interface PolicyInput {
  environment: SecurityEnvironment | null
  policyProfileKey: string
  policyProfileVersion: number
  scope: ScopeManifest
}

/** The profile used when an engagement's pinned profile is unknown: nothing beyond passive, smallest limits. */
const FALLBACK = currentPolicyProfile('observe-only').environments.production

function environmentPolicy(input: PolicyInput): { env: EnvironmentPolicy; known: boolean; evaluatedEnvironment: SecurityEnvironment } {
  const evaluatedEnvironment = input.environment ?? 'production'
  const profile = findPolicyProfile(input.policyProfileKey, input.policyProfileVersion)
  return { env: profile?.environments[evaluatedEnvironment] ?? FALLBACK, known: Boolean(profile), evaluatedEnvironment }
}

function decide<T extends string>(
  value: T,
  permission: PolicyPermission,
  requested: readonly T[] | undefined,
  label: string,
  where: string,
): { selected: boolean; effective: EffectivePermission; reason: string; issue: string | null } {
  const explicit = requested !== undefined
  const selected = explicit ? requested.includes(value) : permission === 'allow' || permission === 'bounded'
  if (permission === 'deny') {
    return {
      selected,
      effective: 'denied',
      reason: `Never permitted in ${where}`,
      issue: explicit && selected ? `${label} is selected but denied in ${where} by the policy profile.` : null,
    }
  }
  if (!selected) {
    return { selected, effective: 'denied', reason: permission === 'opt-in' ? 'Needs an explicit opt-in' : 'Not selected for this engagement', issue: null }
  }
  if (permission === 'bounded') return { selected, effective: 'bounded', reason: 'Under the stricter bounded limits', issue: null }
  if (permission === 'opt-in') return { selected, effective: 'allowed', reason: 'Opted in for this engagement', issue: null }
  return { selected, effective: 'allowed', reason: explicit ? 'Selected for this engagement' : 'Included by default', issue: null }
}

export function effectivePolicy(input: PolicyInput): EffectivePolicy {
  const { env, known, evaluatedEnvironment } = environmentPolicy(input)
  const profile = findPolicyProfile(input.policyProfileKey, input.policyProfileVersion)
  const where = SECURITY_ENVIRONMENT_INFO[evaluatedEnvironment].label.toLowerCase()
  const issues: string[] = []
  if (!known) issues.push(`Policy profile ${input.policyProfileKey} v${input.policyProfileVersion} is not known to this version of Audivra.`)

  const risk = RISK_CLASSES.map((value) => {
    const d = decide(value, env.risk[value], input.scope.permissions.riskClasses, RISK_CLASS_INFO[value].label, where)
    if (d.issue) issues.push(d.issue)
    return { value, profile: env.risk[value], selected: d.selected, effective: d.effective, reason: d.reason }
  })
  const mutation = MUTATION_CLASSES.map((value) => {
    const d = decide(value, env.mutation[value], input.scope.permissions.mutationClasses, MUTATION_CLASS_INFO[value].label, where)
    if (d.issue) issues.push(d.issue)
    return { value, profile: env.mutation[value] as PolicyPermission, selected: d.selected, effective: d.effective, reason: d.reason }
  })
  if (!risk.some((r) => r.effective !== 'denied')) issues.push('No risk class is permitted, so nothing could ever execute.')
  if (!mutation.some((m) => m.effective !== 'denied')) issues.push('No mutation class is permitted, so nothing could ever execute.')

  const selectedExternal = input.scope.permissions.externalIntegrations
  if (selectedExternal === 'allow' && env.externalIntegrations === 'deny') {
    issues.push(`External integrations are selected but denied in ${where} by the policy profile.`)
  }

  const effective = { ...env.ceilings }
  const clamped: string[] = []
  for (const key of EXECUTION_LIMIT_KEYS) {
    const requested = input.scope.limits[key]
    if (requested === undefined) continue
    if (requested > env.ceilings[key]) clamped.push(`${key}: ${requested} → ${env.ceilings[key]} (${where} ceiling)`)
    effective[key] = Math.min(requested, env.ceilings[key])
  }

  return {
    environment: input.environment,
    evaluatedEnvironment,
    profile: {
      key: input.policyProfileKey,
      version: input.policyProfileVersion,
      name: profile?.name ?? input.policyProfileKey,
      description: profile?.description ?? 'Unknown profile: everything beyond passive is denied.',
      known,
    },
    risk,
    mutation,
    externalIntegrations: {
      profile: env.externalIntegrations,
      selected: selectedExternal,
      effective: selectedExternal === 'allow' && env.externalIntegrations === 'opt-in' ? 'allowed' : 'denied',
    },
    limits: { effective, ceilings: env.ceilings, bounded: env.bounded, clamped },
    issues,
  }
}

export interface CapabilityPolicyResult {
  allowed: boolean
  rule: string
  reason: string
  risk: EffectivePermission
  mutation: EffectivePermission
  limits: ExecutionLimits
}

/** Decides one capability against an engagement's effective policy. */
export function evaluateCapabilityPolicy(policy: EffectivePolicy, capability: SecurityCapabilityMetadata): CapabilityPolicyResult {
  const risk = policy.risk.find((r) => r.value === capability.riskClass)!
  const mutation = policy.mutation.find((m) => m.value === capability.sideEffect)!
  const limits = { ...policy.limits.effective }
  if (risk.effective === 'bounded') {
    for (const key of EXECUTION_LIMIT_KEYS) limits[key] = Math.min(limits[key], policy.limits.bounded[key])
  }
  limits.executionTimeoutSeconds = Math.min(limits.executionTimeoutSeconds, capability.timeoutProfile.maxSeconds)
  const base = { risk: risk.effective, mutation: mutation.effective, limits }
  const deny = (rule: string, reason: string): CapabilityPolicyResult => ({ allowed: false, rule, reason, ...base })
  const env = SECURITY_ENVIRONMENT_INFO[policy.evaluatedEnvironment].label

  if (policy.environment === null) return deny('policy.environment-not-set', 'Choose the engagement environment before anything can execute')
  if (policy.issues.length) return deny('policy.invalid', policy.issues[0]!)
  if (!capability.supportedEnvironments.includes(policy.evaluatedEnvironment)) {
    return deny('policy.environment-unsupported', `${capability.name} does not support the ${env} environment`)
  }
  if (risk.effective === 'denied') {
    return deny(risk.profile === 'deny' ? 'policy.risk-denied' : 'policy.risk-not-selected', `${RISK_CLASS_INFO[capability.riskClass].label} capabilities: ${risk.reason.toLowerCase()} (${env})`)
  }
  if (mutation.effective === 'denied') {
    return deny(mutation.profile === 'deny' ? 'policy.mutation-denied' : 'policy.mutation-not-selected', `${MUTATION_CLASS_INFO[capability.sideEffect].label} side effects: ${mutation.reason.toLowerCase()} (${env})`)
  }
  if (capability.requiresExternalIntegration && policy.externalIntegrations.effective === 'denied') {
    return deny('policy.external-integration-denied', `External integrations are not permitted for this engagement (${env})`)
  }
  return {
    allowed: true,
    rule: risk.effective === 'bounded' ? 'policy.allowed-bounded' : 'policy.allowed',
    reason: `${RISK_CLASS_INFO[capability.riskClass].label}, ${MUTATION_CLASS_INFO[capability.sideEffect].label.toLowerCase()}: permitted in ${env}`,
    ...base,
  }
}
