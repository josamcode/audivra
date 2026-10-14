import type { ComparisonPlanInput, RetestBlockerKind, RetestCase, RetestEligibility, ScopeManifest } from '@audivra/contracts'
import { evaluateUrl } from '../scope.ts'
import type { CapabilityRegistry } from '../capabilities/registry.ts'

/*
 * Phase 6C — decide, deterministically and BEFORE anything executes, whether a retest case can be replayed in
 * a target assessment. Every blocker is recorded explicitly; an ineligible retest is never silently treated
 * as a fix. The check is conservative: anything Audivra cannot establish (a missing resource/identity/session,
 * an out-of-scope target, an unavailable capability, an unsupported reproduction) is a gap, not a pass.
 */

export interface EligibilityContext {
  /** The target assessment the retest would run in. */
  environment: string | null
  scope: ScopeManifest
  /** Declared identity refs in the target engagement. */
  declaredIdentityRefs: Set<string>
  /** Declared resource refs in the target engagement. */
  declaredResourceRefs: Set<string>
  /** Identity refs with an active session in the target engagement. */
  activeSessionIdentityRefs: Set<string>
  /** Whether the engagement host(s) are authorized. */
  authorized: boolean
  /** The source assessment's environment (to flag a material environment change). */
  sourceEnvironment: string | null
  registry: CapabilityRegistry
}

/** blockers mapped to how the retest result should read when it cannot run. */
export function blockerToReason(kind: RetestBlockerKind): string {
  switch (kind) {
    case 'unsupported-reproduction':
      return 'The finding has no replayable reproduction (no controlled comparison to re-run)'
    case 'resource-missing':
      return 'The resource under test is no longer declared in the target assessment'
    case 'identity-unavailable':
      return 'A required test identity is not available in the target assessment'
    case 'session-unavailable':
      return 'A required session could not be established in the target assessment'
    case 'scope-excludes-target':
      return "The target's URL is outside the engagement scope"
    case 'authorization-invalid':
      return 'The target assessment is not authorized for this host'
    case 'capability-unavailable':
      return 'A required capability is not registered'
    case 'environment-changed':
      return 'The target environment differs materially from the original assessment'
  }
}

/**
 * Whether a blocker means the issue genuinely cannot be reconstructed (`cannot-reproduce`) vs. Audivra/policy
 * stopping the attempt (`blocked`). Either way it is NEVER a fix.
 */
export function blockerState(kind: RetestBlockerKind): 'cannot-reproduce' | 'blocked' {
  return kind === 'resource-missing' || kind === 'identity-unavailable' || kind === 'session-unavailable' || kind === 'environment-changed' || kind === 'unsupported-reproduction' ? 'cannot-reproduce' : 'blocked'
}

export function evaluateRetestEligibility(testCase: Pick<RetestCase, 'reproductionFormat' | 'reproduction' | 'capabilityIds'>, ctx: EligibilityContext): RetestEligibility {
  const capabilities = testCase.capabilityIds.map((capabilityId) => ({ capabilityId, available: ctx.registry.get(capabilityId) !== undefined }))
  const repro = testCase.reproduction
  const blocker = (kind: RetestBlockerKind): RetestEligibility => ({ eligible: false, blocker: kind, reason: blockerToReason(kind), capabilities })

  if (testCase.reproductionFormat !== 'differential-comparison' || !repro) return blocker('unsupported-reproduction')
  if (capabilities.some((c) => !c.available)) return blocker('capability-unavailable')
  if (!ctx.authorized) return blocker('authorization-invalid')

  const subject = repro.arms.find((a) => a.role === 'subject') ?? repro.arms[0]
  const resourceRefs = [...new Set(repro.arms.map((a) => a.resourceRef))]
  for (const ref of resourceRefs) if (!ctx.declaredResourceRefs.has(ref)) return blocker('resource-missing')

  const identityRefs = [...new Set(repro.arms.map((a) => a.identityRef).filter((r): r is string => !!r))]
  for (const ref of identityRefs) {
    if (!ctx.declaredIdentityRefs.has(ref)) return blocker('identity-unavailable')
    if (!ctx.activeSessionIdentityRefs.has(ref)) return blocker('session-unavailable')
  }

  for (const arm of repro.arms) {
    const evaluation = evaluateUrl(ctx.scope, arm.url, { kind: 'target' })
    if (evaluation.decision === 'deny') return blocker('scope-excludes-target')
  }

  const notes: string[] = []
  if (ctx.sourceEnvironment && ctx.environment && ctx.sourceEnvironment !== ctx.environment) notes.push(`environment changed: ${ctx.sourceEnvironment} → ${ctx.environment}`)
  void subject
  return { eligible: true, blocker: null, reason: notes.length ? `Replayable (${notes.join('; ')})` : 'Replayable against the target assessment', capabilities }
}

/** Resource refs referenced by a reproduction plan (used when adapting a substituted resource). */
export function reproductionResourceRefs(repro: ComparisonPlanInput): string[] {
  return [...new Set(repro.arms.map((a) => a.resourceRef))]
}
