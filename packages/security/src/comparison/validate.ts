import type { ComparisonArmPlan, ComparisonPlanInput, EnvironmentPolicy, ScopeManifest, SecurityEnvironment } from '@audivra/contracts'
import { evaluateUrl } from '../scope.ts'

/*
 * Phase 5 Step 4 — deterministic pre-execution validation. Before any arm runs, every reference must resolve
 * to a real engagement entity and every precondition must hold: the engagement is runnable, the identity is
 * declared, a valid session exists for it, the resource is declared and in scope, the capability for the
 * method exists and its class is permitted by the environment policy, and a state-changing arm targets
 * test-owned/synthetic data (or an isolated lab). The AI cannot bypass these — a failed check blocks the
 * comparison (or the arm) with a precise reason, and the Capability Broker re-checks policy at execution.
 */

export interface ValidationIdentity {
  ref: string
  tenantRef: string | null
}
export interface ValidationResource {
  ref: string
  ownerRef: string | null
  tenantRef: string | null
  testData: string
}
export interface ValidationSession {
  id: string
  identityRef: string
  status: string
  expiresAt: number | null
}

export interface ValidationContext {
  engagement: { id: string; status: string; environment: SecurityEnvironment | null; scope: ScopeManifest }
  identities: Map<string, ValidationIdentity>
  resources: Map<string, ValidationResource>
  /** Active session per identity ref (the engine resolves/establishes these before validation). */
  sessions: Map<string, ValidationSession>
  policy: EnvironmentPolicy
  now: number
}

/** A plan arm that passed validation, bound to the exact capability and session it will run with. */
export interface ResolvedArm extends ComparisonArmPlan {
  capabilityId: 'access.identity-read' | 'access.identity-action'
  sessionRef: string | null
}

export type PlanValidation = { ok: true; arms: ResolvedArm[]; cleanupRequired: boolean } | { ok: false; scope: 'plan' | 'arm'; armIndex: number | null; reason: string }

const RUNNABLE = new Set(['ready', 'active'])
const SAFE_METHODS = new Set(['GET', 'HEAD'])
const WRITE_SAFE_DATA = new Set(['test-owned', 'synthetic'])

export function validateComparisonPlan(ctx: ValidationContext, plan: ComparisonPlanInput): PlanValidation {
  if (!RUNNABLE.has(ctx.engagement.status)) return { ok: false, scope: 'plan', armIndex: null, reason: `The engagement is ${ctx.engagement.status}, not runnable` }
  if (!ctx.engagement.environment) return { ok: false, scope: 'plan', armIndex: null, reason: 'The engagement has no environment set' }
  if (!ctx.resources.has(plan.resourceRef)) return { ok: false, scope: 'plan', armIndex: null, reason: `Resource "${plan.resourceRef}" is not declared` }

  const arms: ResolvedArm[] = []
  let cleanupRequired = plan.cleanupRequired
  for (let i = 0; i < plan.arms.length; i++) {
    const arm = plan.arms[i]!
    const resolved = validateArm(ctx, arm, i)
    if ('reason' in resolved) return { ok: false, scope: 'arm', armIndex: i, reason: resolved.reason }
    if (resolved.capabilityId === 'access.identity-action') cleanupRequired = cleanupRequired || plan.cleanupRequired
    arms.push(resolved)
  }
  if (!arms.some((a) => a.role === 'subject')) return { ok: false, scope: 'plan', armIndex: null, reason: 'A comparison needs at least one subject arm' }
  return { ok: true, arms, cleanupRequired }
}

function validateArm(ctx: ValidationContext, arm: ComparisonArmPlan, index: number): ResolvedArm | { reason: string } {
  // Identity + session (explicit; never an implicit "current login").
  let sessionRef: string | null = null
  if (arm.identityRef) {
    if (!ctx.identities.has(arm.identityRef)) return { reason: `arm ${index}: identity "${arm.identityRef}" is not declared` }
    const session = ctx.sessions.get(arm.identityRef)
    if (!session) return { reason: `arm ${index}: identity "${arm.identityRef}" has no established session` }
    if (session.status !== 'active') return { reason: `arm ${index}: the session for "${arm.identityRef}" is ${session.status}, not active` }
    if (session.expiresAt && session.expiresAt <= ctx.now) return { reason: `arm ${index}: the session for "${arm.identityRef}" has expired` }
    sessionRef = session.id
  }
  // Resource.
  const resource = ctx.resources.get(arm.resourceRef)
  if (!resource) return { reason: `arm ${index}: resource "${arm.resourceRef}" is not declared` }
  // Scope.
  const evaluation = evaluateUrl(ctx.engagement.scope, arm.url)
  if (evaluation.decision !== 'allow') return { reason: `arm ${index}: ${arm.url} is out of scope (${evaluation.reason})` }
  // Capability for the method, and the environment policy for its class.
  const write = !SAFE_METHODS.has(arm.method)
  const capabilityId = write ? ('access.identity-action' as const) : ('access.identity-read' as const)
  if (write) {
    if (ctx.policy.risk['state-changing'] === 'deny') return { reason: `arm ${index}: state-changing actions are denied in the ${ctx.engagement.environment} environment` }
    if (ctx.policy.mutation['reversible-write'] === 'deny') return { reason: `arm ${index}: reversible writes are denied in the ${ctx.engagement.environment} environment` }
    // Test-data: never write to production-like/unknown data unless an isolated lab (where the whole env is disposable).
    if (ctx.engagement.environment !== 'isolated-lab' && !WRITE_SAFE_DATA.has(resource.testData)) {
      return { reason: `arm ${index}: a state-changing action needs a test-owned/synthetic resource (resource "${arm.resourceRef}" is ${resource.testData})` }
    }
  }
  return { ...arm, capabilityId, sessionRef }
}
