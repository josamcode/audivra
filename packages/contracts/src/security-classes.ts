import { z } from 'zod'

/*
 * Classification vocabulary for the security control plane: environments, risk classes and mutation
 * (side-effect) classes. Policy decisions are made by comparing a capability's declared classes against
 * the environment's policy — never by inspecting what a capability does at run time.
 */

export const SECURITY_ENVIRONMENTS = ['production', 'staging', 'isolated-lab'] as const
export const SecurityEnvironment = z.enum(SECURITY_ENVIRONMENTS)
export type SecurityEnvironment = z.infer<typeof SecurityEnvironment>

export const SECURITY_ENVIRONMENT_INFO: Record<SecurityEnvironment, { label: string; description: string }> = {
  production: { label: 'Production', description: 'Live system with real users. The most restrictive policy applies.' },
  staging: { label: 'Staging', description: 'Pre-production copy. Broader policy, still explicitly controlled.' },
  'isolated-lab': { label: 'Isolated lab', description: 'Disposable environment set up for testing. Broadest policy, still bounded by the engagement.' },
}

/** Declared impact class of a capability, in increasing order. */
export const RISK_CLASSES = ['passive', 'low-impact', 'state-changing', 'high-impact', 'destructive'] as const
export const RiskClass = z.enum(RISK_CLASSES)
export type RiskClass = z.infer<typeof RiskClass>

export const RISK_CLASS_INFO: Record<RiskClass, { label: string; description: string }> = {
  passive: { label: 'Passive', description: 'Observes what the target already serves.' },
  'low-impact': { label: 'Low impact', description: 'Small, bounded interactions beyond normal browsing.' },
  'state-changing': { label: 'State changing', description: 'May create or change application state.' },
  'high-impact': { label: 'High impact', description: 'May noticeably affect the service or its data.' },
  destructive: { label: 'Destructive or resource-intensive', description: 'May cause loss of data or availability.' },
}

/** Declared side effects of a capability on the target, in increasing order. */
export const MUTATION_CLASSES = ['read-only', 'transient-state', 'reversible-write', 'irreversible-write'] as const
export const MutationClass = z.enum(MUTATION_CLASSES)
export type MutationClass = z.infer<typeof MutationClass>

export const MUTATION_CLASS_INFO: Record<MutationClass, { label: string; description: string }> = {
  'read-only': { label: 'Read only', description: 'Safe HTTP methods only (GET, HEAD, OPTIONS); nothing is written.' },
  'transient-state': { label: 'Transient state', description: 'Short-lived state such as sessions.' },
  'reversible-write': { label: 'Reversible write', description: 'Writes that can be cleaned up afterwards.' },
  'irreversible-write': { label: 'Irreversible write', description: 'Writes that cannot be undone.' },
}

export const riskRank = (value: RiskClass): number => RISK_CLASSES.indexOf(value)
export const mutationRank = (value: MutationClass): number => MUTATION_CLASSES.indexOf(value)

/**
 * The authorization invariant: a capability needs a valid authorization when it says so, and always when
 * it is above passive or not read-only. Enforced by the broker regardless of what the capability declares.
 */
export function authorizationRequiredFor(meta: { riskClass: RiskClass; sideEffect: MutationClass; requiresAuthorization: boolean }): boolean {
  return meta.requiresAuthorization || meta.riskClass !== 'passive' || meta.sideEffect !== 'read-only'
}
