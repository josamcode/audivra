import type { ComparisonArmPlan, ComparisonDimension, ComparisonPlanInput, ExpectedBehavior, ProposedComparison } from '@audivra/contracts'
import { comparisonDedupeKey } from './classify.ts'

/*
 * Phase 5 Step 4 — the comparison planner. It proposes the bounded set of comparisons that would reduce the
 * most authorization/business uncertainty, WITHOUT enumerating identities × resources × actions. It is
 * deterministic (so it works with the AI provider unavailable) and heavily pruned: one representative
 * comparison per resource/dimension, always with controls, always deduplicated against what already ran, and
 * ranked by information gain (untested boundaries on test-owned resources with available sessions first). An
 * AI proposal is only accepted after the same reference/ownership validation — it can never invent an
 * identity, resource or ownership relationship.
 */

export interface PlannerIdentity {
  ref: string
  tenantRef: string | null
  roleRefs: string[]
  hasSession: boolean
}
export interface PlannerResource {
  ref: string
  ownerRef: string | null
  tenantRef: string | null
  testData: string
  /** The URL the resource is reached through (canonical URL or endpoint). */
  url: string | null
}
export interface PlannerInvariant {
  ref: string
  category: string
  rule: string
  resourceRefs: string[]
}
export interface PlannerInput {
  environment: string
  identities: PlannerIdentity[]
  resources: PlannerResource[]
  invariants: PlannerInvariant[]
  /** Dedupe keys of comparisons that already exist (not re-proposed). */
  existingDedupeKeys: Set<string>
}

export interface RankedPlan {
  plan: ComparisonPlanInput
  informationGain: number
  reason: string
}

const expected = (outcome: ExpectedBehavior['outcome'], basis: ExpectedBehavior['basis'], invariantRef: string | null, rationale: string): ExpectedBehavior => ({ outcome, basis, invariantRef, sourceRef: null, rationale })
const arm = (role: ComparisonArmPlan['role'], identityRef: string | null, resourceRef: string, url: string, exp: ExpectedBehavior): ComparisonArmPlan => ({ role, identityRef, resourceRef, url, method: 'GET', body: null, expected: exp })

/** Proposes a bounded, ranked, deduplicated set of comparisons. */
export function proposeComparisons(input: PlannerInput, limit = 4): RankedPlan[] {
  const withSession = input.identities.filter((i) => i.hasSession)
  const invariantFor = (resourceRef: string, categories: string[]) => input.invariants.find((inv) => categories.includes(inv.category) && inv.resourceRefs.includes(resourceRef))
  const out: RankedPlan[] = []

  for (const resource of input.resources) {
    if (!resource.url) continue
    const owner = resource.ownerRef ? withSession.find((i) => i.ref === resource.ownerRef) : undefined

    // Object boundary: an identity that does not own the resource should be denied; the owner should be allowed.
    const other = withSession.find((i) => i.ref !== resource.ownerRef && (!resource.tenantRef || !i.tenantRef || i.tenantRef === resource.tenantRef))
    if (owner && other) {
      const inv = invariantFor(resource.ref, ['object-boundary', 'ownership'])
      const plan = objectBoundaryPlan(resource, owner, other, inv?.ref ?? null)
      pushUnique(out, input.existingDedupeKeys, plan, gain(resource, true, true), `Object boundary on ${resource.ref}: can ${other.ref} read ${owner.ref}'s resource?`)
    }

    // Tenant boundary: an identity in a different tenant should be denied a tenant-scoped resource.
    if (resource.tenantRef) {
      const crossTenant = withSession.find((i) => i.tenantRef && i.tenantRef !== resource.tenantRef)
      const sameTenant = withSession.find((i) => i.tenantRef === resource.tenantRef)
      if (crossTenant) {
        const inv = invariantFor(resource.ref, ['tenant-boundary'])
        const plan = tenantBoundaryPlan(resource, crossTenant, sameTenant ?? null, inv?.ref ?? null)
        pushUnique(out, input.existingDedupeKeys, plan, gain(resource, !!sameTenant, true), `Tenant boundary on ${resource.ref}: can ${crossTenant.ref} (other tenant) read it?`)
      }
    }
  }

  return out.sort((a, b) => b.informationGain - a.informationGain).slice(0, limit)
}

function objectBoundaryPlan(resource: PlannerResource, owner: PlannerIdentity, other: PlannerIdentity, invariantRef: string | null): ComparisonPlanInput {
  return basePlan('object-boundary', resource, invariantRef, [
    arm('subject', other.ref, resource.ref, resource.url!, expected('deny', invariantRef ? 'declared' : 'ai-inferred', invariantRef, `${other.ref} does not own ${resource.ref}`)),
    arm('positive-control', owner.ref, resource.ref, resource.url!, expected('allow', 'observed', invariantRef, `${owner.ref} owns ${resource.ref}`)),
    arm('negative-control', null, resource.ref, resource.url!, expected('deny', 'observed', invariantRef, 'anonymous access should be denied')),
  ])
}

function tenantBoundaryPlan(resource: PlannerResource, crossTenant: PlannerIdentity, sameTenant: PlannerIdentity | null, invariantRef: string | null): ComparisonPlanInput {
  const arms = [arm('subject', crossTenant.ref, resource.ref, resource.url!, expected('deny', invariantRef ? 'declared' : 'ai-inferred', invariantRef, `${crossTenant.ref} is in a different tenant than ${resource.ref}`))]
  if (sameTenant) arms.push(arm('positive-control', sameTenant.ref, resource.ref, resource.url!, expected('allow', 'observed', invariantRef, `${sameTenant.ref} is in the resource's tenant`)))
  arms.push(arm('negative-control', null, resource.ref, resource.url!, expected('deny', 'observed', invariantRef, 'anonymous access should be denied')))
  return basePlan('tenant-boundary', resource, invariantRef, arms)
}

function basePlan(dimension: ComparisonDimension, resource: PlannerResource, invariantRef: string | null, arms: ComparisonArmPlan[]): ComparisonPlanInput {
  return {
    hypothesisId: null,
    dimension,
    resourceRef: resource.ref,
    action: 'read',
    invariantRef,
    arms,
    cleanupRequired: false,
    cleanup: null,
    stateProbeUrl: null,
    expectedTransition: null,
    reason: `Representative ${dimension} comparison on ${resource.ref}`,
    coverageSampled: true,
  }
}

/** Information gain: untested boundaries on test-owned resources with a positive control rank highest. */
function gain(resource: PlannerResource, hasPositiveControl: boolean, hasNegativeControl: boolean): number {
  let g = 0.5
  if (hasPositiveControl) g += 0.25
  if (hasNegativeControl) g += 0.1
  if (resource.testData === 'test-owned' || resource.testData === 'synthetic') g += 0.1
  if (resource.testData === 'production-like') g -= 0.2
  return Math.max(0, Math.min(1, g))
}

function pushUnique(out: RankedPlan[], existing: Set<string>, plan: ComparisonPlanInput, informationGain: number, reason: string): void {
  const key = comparisonDedupeKey(plan.dimension, plan.action, plan.arms)
  if (existing.has(key) || out.some((p) => comparisonDedupeKey(p.plan.dimension, p.plan.action, p.plan.arms) === key)) return
  out.push({ plan, informationGain, reason })
}

// ── AI proposal validation ────────────────────────────────────────────────────────────────────────────

export const COMPARISON_PROPOSAL_REJECTIONS = ['unknown-identity', 'unknown-resource', 'no-session', 'ownership-mismatch', 'duplicate', 'no-controls', 'out-of-scope-claim'] as const
export type ComparisonProposalRejection = (typeof COMPARISON_PROPOSAL_REJECTIONS)[number]

export type ComparisonProposalVerdict = { ok: true; plan: ComparisonPlanInput } | { ok: false; reason: ComparisonProposalRejection; detail: string }

/**
 * Validates an AI-proposed comparison against real state: every identity/resource must exist and have a
 * session, ownership claims must match the declarations (the model cannot invent "other owner"), controls
 * must be present, and it must not duplicate an existing comparison.
 */
export function validateProposedComparison(proposal: ProposedComparison, input: PlannerInput): ComparisonProposalVerdict {
  const reject = (reason: ComparisonProposalRejection, detail: string): ComparisonProposalVerdict => ({ ok: false, reason, detail })
  const resource = input.resources.find((r) => r.ref === proposal.resourceRef)
  if (!resource) return reject('unknown-resource', `resource "${proposal.resourceRef}" is not declared`)
  for (const a of proposal.arms) {
    if (a.identityRef) {
      const identity = input.identities.find((i) => i.ref === a.identityRef)
      if (!identity) return reject('unknown-identity', `identity "${a.identityRef}" is not declared`)
      if (!identity.hasSession) return reject('no-session', `identity "${a.identityRef}" has no established session`)
    }
  }
  // Ownership claims must be grounded: a "deny"-expected subject that the model says is a different owner must
  // actually not be the declared owner.
  const subject = proposal.arms.find((a) => a.role === 'subject')
  if (subject?.expected.outcome === 'deny' && subject.identityRef && resource.ownerRef && subject.identityRef === resource.ownerRef) {
    return reject('ownership-mismatch', `the subject "${subject.identityRef}" is the declared owner of "${resource.ref}", so denial is not expected`)
  }
  if (!proposal.arms.some((a) => a.role === 'positive-control' || a.role === 'negative-control')) return reject('no-controls', 'a comparison needs at least one control arm')
  const plan: ComparisonPlanInput = {
    hypothesisId: proposal.hypothesisId,
    dimension: proposal.dimension,
    resourceRef: proposal.resourceRef,
    action: proposal.action,
    invariantRef: proposal.invariantRef,
    arms: proposal.arms,
    cleanupRequired: false,
    cleanup: null,
    stateProbeUrl: null,
    expectedTransition: proposal.expectedTransition,
    reason: proposal.reason,
    coverageSampled: false,
  }
  if (input.existingDedupeKeys.has(comparisonDedupeKey(plan.dimension, plan.action, plan.arms))) return reject('duplicate', 'a comparison with the same arms already exists')
  return { ok: true, plan }
}
