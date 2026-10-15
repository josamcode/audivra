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
  key: string
  tenantRef: string | null
  roleRefs: string[]
  hasSession: boolean
}
export interface PlannerResource {
  ref: string
  key: string
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
export interface PlannerAction {
  ref: string
  verb: string
  endpointUrl: string | null
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  stateProbeUrl: string | null
  requiredRoleRefs: string[]
  requiredStateRef: string | null
  resultingStateRef: string | null
  actsOnRefs: string[]
}
export interface PlannerInput {
  environment: string
  identities: PlannerIdentity[]
  resources: PlannerResource[]
  invariants: PlannerInvariant[]
  actions: PlannerAction[]
  roles: { ref: string; permits: string[] }[]
  /** Open Phase-5 knowledge gaps by subject key, to prioritise the most uncertain boundaries. */
  openGaps: { kind: string; subjectKey: string }[]
  /** Dedupe keys of comparisons that already exist (not re-proposed). */
  existingDedupeKeys: Set<string>
}

export interface RankedPlan {
  plan: ComparisonPlanInput
  informationGain: number
  reason: string
}

/** How the candidate space was pruned — proof that the planner avoids a Cartesian explosion. */
export interface PruningStats {
  /** Raw possible identity × resource × (read + actions) combinations. */
  cartesian: number
  /** Candidate comparisons the planner actually considered (after graph/declaration filtering). */
  candidates: number
  proposed: number
  /** Why candidates were discarded. */
  discarded: Record<string, number>
}

const expected = (outcome: ExpectedBehavior['outcome'], basis: ExpectedBehavior['basis'], invariantRef: string | null, rationale: string): ExpectedBehavior => ({ outcome, basis, invariantRef, sourceRef: null, rationale })
const arm = (role: ComparisonArmPlan['role'], identityRef: string | null, resourceRef: string, url: string, exp: ExpectedBehavior, method: ComparisonArmPlan['method'] = 'GET'): ComparisonArmPlan => ({ role, identityRef, resourceRef, url, method, body: null, expected: exp })

class Candidates {
  readonly plans: RankedPlan[] = []
  readonly discarded: Record<string, number> = {}
  considered = 0
  constructor(
    private readonly existing: Set<string>,
    private readonly openGaps: { kind: string; subjectKey: string }[],
  ) {}
  discard(reason: string): void {
    this.discarded[reason] = (this.discarded[reason] ?? 0) + 1
  }
  add(plan: ComparisonPlanInput, resourceKey: string, baseGain: number, reason: string): void {
    this.considered++
    const key = comparisonDedupeKey(plan.dimension, plan.action, plan.arms)
    if (this.existing.has(key) || this.plans.some((p) => comparisonDedupeKey(p.plan.dimension, p.plan.action, p.plan.arms) === key)) {
      this.discard('duplicate')
      return
    }
    // Boost gain when an open Phase-5 gap on this resource would be answered by the comparison.
    const gapBoost = this.openGaps.some((g) => g.subjectKey === resourceKey) ? 0.15 : 0
    this.plans.push({ plan, informationGain: Math.min(1, baseGain + gapBoost), reason })
  }
}

/**
 * Proposes a bounded, ranked, deduplicated set of comparisons across all supported categories WITHOUT
 * enumerating identities × resources × actions: for each resource/action it picks one representative subject
 * and the needed controls, deduplicates against what already ran, and ranks by information gain (open
 * Phase-5 gaps and test-owned resources first). Returns pruning stats proving the candidate set stays small.
 */
export function proposeComparisons(input: PlannerInput, limit = 6): { plans: RankedPlan[]; stats: PruningStats } {
  const withSession = input.identities.filter((i) => i.hasSession)
  const invariantFor = (resourceRef: string, categories: string[]) => input.invariants.find((inv) => categories.includes(inv.category) && inv.resourceRefs.includes(resourceRef))
  const c = new Candidates(input.existingDedupeKeys, input.openGaps)
  const baseGain = (r: PlannerResource, hasPositive: boolean, hasNegative: boolean) =>
    Math.max(0, Math.min(0.9, 0.5 + (hasPositive ? 0.2 : 0) + (hasNegative ? 0.1 : 0) + (r.testData === 'test-owned' || r.testData === 'synthetic' ? 0.1 : r.testData === 'production-like' ? -0.2 : 0)))
  const base = (dimension: ComparisonDimension, resource: PlannerResource, action: string, invariantRef: string | null, arms: ComparisonArmPlan[], extra: Partial<ComparisonPlanInput> = {}): ComparisonPlanInput => ({
    hypothesisId: null,
    dimension,
    resourceRef: resource.ref,
    action,
    invariantRef,
    arms,
    cleanupRequired: false,
    cleanup: null,
    stateProbeUrl: null,
    expectedTransition: null,
    reason: `Representative ${dimension} comparison on ${resource.ref}`,
    coverageSampled: true,
    ...extra,
  })

  for (const resource of input.resources) {
    if (!resource.url) {
      c.discard('resource-no-url')
      continue
    }
    const url = resource.url
    const owner = resource.ownerRef ? withSession.find((i) => i.ref === resource.ownerRef) : undefined

    // Object boundary: a non-owner (same tenant) should be denied; the owner should be allowed.
    const nonOwner = withSession.find((i) => i.ref !== resource.ownerRef && (!resource.tenantRef || !i.tenantRef || i.tenantRef === resource.tenantRef))
    if (owner && nonOwner) {
      const inv = invariantFor(resource.ref, ['object-boundary', 'ownership'])
      c.add(
        base('object-boundary', resource, 'read', inv?.ref ?? null, [
          arm('subject', nonOwner.ref, resource.ref, url, expected('deny', inv ? 'declared' : 'ai-inferred', inv?.ref ?? null, `${nonOwner.ref} does not own ${resource.ref}`)),
          arm('positive-control', owner.ref, resource.ref, url, expected('allow', 'observed', inv?.ref ?? null, `${owner.ref} owns ${resource.ref}`)),
          arm('negative-control', null, resource.ref, url, expected('deny', 'observed', inv?.ref ?? null, 'anonymous access should be denied')),
        ]),
        resource.key,
        baseGain(resource, true, true),
        `Object boundary: can ${nonOwner.ref} read ${owner.ref}'s ${resource.ref}?`,
      )
    } else if (resource.ownerRef) c.discard('object-no-second-identity')

    // Tenant boundary: a cross-tenant identity should be denied a tenant-scoped resource.
    if (resource.tenantRef) {
      const crossTenant = withSession.find((i) => i.tenantRef && i.tenantRef !== resource.tenantRef)
      const sameTenant = withSession.find((i) => i.tenantRef === resource.tenantRef)
      if (crossTenant) {
        const inv = invariantFor(resource.ref, ['tenant-boundary'])
        const arms = [arm('subject', crossTenant.ref, resource.ref, url, expected('deny', inv ? 'declared' : 'ai-inferred', inv?.ref ?? null, `${crossTenant.ref} is in a different tenant`))]
        if (sameTenant) arms.push(arm('positive-control', sameTenant.ref, resource.ref, url, expected('allow', 'observed', inv?.ref ?? null, `${sameTenant.ref} is in the tenant`)))
        arms.push(arm('negative-control', null, resource.ref, url, expected('deny', 'observed', inv?.ref ?? null, 'anonymous access should be denied')))
        c.add(base('tenant-boundary', resource, 'read', inv?.ref ?? null, arms), resource.key, baseGain(resource, !!sameTenant, true), `Tenant boundary: can ${crossTenant.ref} (other tenant) read ${resource.ref}?`)
      } else c.discard('tenant-no-cross-tenant-identity')
    }

    // Field boundary: ONLY when a field-level policy is declared for the resource. Absent a declared
    // field-access invariant, a non-owner seeing the same fields as the owner is not a violation — two
    // roles may legitimately share full read access — so we never manufacture a finding from a bare
    // assumption. The open `field-visibility-unknown` gap still surfaces the question for a human.
    const fieldInv = owner && nonOwner ? invariantFor(resource.ref, ['field-access']) : undefined
    if (owner && nonOwner && fieldInv) {
      c.add(
        base('field-boundary', resource, 'read', fieldInv.ref, [
          arm('subject', nonOwner.ref, resource.ref, url, expected('limited', 'declared', fieldInv.ref, fieldInv.rule)),
          arm('positive-control', owner.ref, resource.ref, url, expected('allow', 'observed', fieldInv.ref, `${owner.ref} sees the full resource`)),
        ]),
        resource.key,
        baseGain(resource, true, false) - 0.1,
        `Field boundary: does ${nonOwner.ref} see the limited view required by ${fieldInv.ref} on ${resource.ref}?`,
      )
    } else if (owner && nonOwner) {
      c.discard('field-no-declared-policy')
    }

    // Session boundary: an anonymous request should be denied; an authenticated identity allowed.
    const anyAuthed = owner ?? withSession[0]
    if (anyAuthed) {
      c.add(
        base('session-boundary', resource, 'read', null, [
          arm('subject', null, resource.ref, url, expected('deny', 'ai-inferred', null, 'an anonymous request should be denied a protected resource')),
          arm('positive-control', anyAuthed.ref, resource.ref, url, expected('allow', 'observed', null, `${anyAuthed.ref} is authenticated`)),
        ]),
        resource.key,
        baseGain(resource, true, false) - 0.15,
        `Session boundary: is ${resource.ref} protected from anonymous access?`,
      )
    }
  }

  // Role / function-level and business-rule comparisons come from business actions with an endpoint.
  for (const action of input.actions) {
    if (!action.endpointUrl) {
      c.discard('action-no-endpoint')
      continue
    }
    const actsOn = action.actsOnRefs.map((ref) => input.resources.find((r) => r.ref === ref)).find((r): r is PlannerResource => !!r) ?? input.resources[0]
    if (!actsOn) {
      c.discard('action-no-resource')
      continue
    }
    const requiredRole = action.requiredRoleRefs[0] ?? null
    const safe = action.method === 'GET'
    if (requiredRole) {
      const privileged = withSession.find((i) => i.roleRefs.includes(requiredRole))
      const unprivileged = withSession.find((i) => !i.roleRefs.includes(requiredRole))
      if (privileged && unprivileged) {
        const dimension: ComparisonDimension = safe ? 'function-level' : 'role-boundary'
        c.add(
          base(
            dimension,
            actsOn,
            action.verb,
            null,
            [
              arm('subject', unprivileged.ref, actsOn.ref, action.endpointUrl, expected('deny', 'ai-inferred', null, `${unprivileged.ref} lacks the role ${requiredRole}`), action.method),
              arm('positive-control', privileged.ref, actsOn.ref, action.endpointUrl, expected('allow', 'observed', null, `${privileged.ref} holds ${requiredRole}`), action.method),
            ],
            safe ? {} : { cleanupRequired: true, cleanup: { identityRef: privileged.ref, url: `${action.endpointUrl.replace(/\/[^/]+$/, '')}/reset`, method: 'POST', body: null } },
          ),
          actsOn.key,
          baseGain(actsOn, true, false),
          `${dimension}: can ${unprivileged.ref} (no ${requiredRole}) perform ${action.verb}?`,
        )
      } else c.discard('role-no-contrast-identity')
    }
    // Business-rule / state transition: a permitted identity performs the action; state is read before/after.
    if (action.stateProbeUrl && (action.resultingStateRef || action.requiredStateRef)) {
      const actor = (requiredRole ? withSession.find((i) => i.roleRefs.includes(requiredRole)) : undefined) ?? (actsOn.ownerRef ? withSession.find((i) => i.ref === actsOn.ownerRef) : undefined) ?? withSession[0]
      if (actor) {
        const inv = invariantFor(actsOn.ref, ['state-transition', 'business-rule'])
        c.add(
          base('state-transition', actsOn, action.verb, inv?.ref ?? null, [arm('subject', actor.ref, actsOn.ref, action.endpointUrl, expected('allow', 'observed', inv?.ref ?? null, `${actor.ref} performs ${action.verb}`), action.method)], {
            stateProbeUrl: action.stateProbeUrl,
            expectedTransition: action.requiredStateRef && action.resultingStateRef ? `${action.requiredStateRef}→${action.resultingStateRef}` : null,
            cleanupRequired: true,
            cleanup: { identityRef: actor.ref, url: `${action.endpointUrl.replace(/\/[^/]+$/, '')}/reset`, method: 'POST', body: null },
          }),
          actsOn.key,
          baseGain(actsOn, false, false),
          `Business rule: does ${action.verb} move ${actsOn.ref} through its expected state transition?`,
        )
      } else c.discard('business-rule-no-actor')
    }
  }

  // The raw space a naive planner could enumerate: every (subject identity × control identity × target ×
  // boundary dimension). The planner considers only a small pruned fraction of this.
  const DIMENSIONS = 8
  const cartesian = input.identities.length * Math.max(1, input.identities.length - 1) * (input.resources.length + input.actions.length) * DIMENSIONS
  const plans = c.plans.sort((a, b) => b.informationGain - a.informationGain).slice(0, limit)
  const kept = new Set(plans)
  for (const p of c.plans) if (!kept.has(p)) c.discard('below-rank-cutoff')
  return { plans, stats: { cartesian, candidates: c.considered, proposed: plans.length, discarded: c.discarded } }
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
