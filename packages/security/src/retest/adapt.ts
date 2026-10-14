import { randomUUID } from 'node:crypto'
import type { ComparisonPlanInput, RetestAdaptation, RetestAdaptationOutput } from '@audivra/contracts'
import { RetestAdaptationOutput as RetestAdaptationOutputSchema } from '@audivra/contracts'
import { jsonSection, type ReasoningAi } from '../reasoning/ai.ts'
import { RETEST_TASKS, retestJsonSchema } from './ai.ts'

/*
 * Phase 6C — the bounded semantic adaptation. Audivra asks the AI (through the Phase 3C router) only when a
 * deterministic replay could not run against the current target. The proposal is validated to the letter:
 * every referenced entity key must already exist in the current graph, and only the current endpoint/resource
 * may move. The expectation, invariant, identity and dimension are never touched — those changes mean the
 * issue CHANGED or is NEW, which is classified elsewhere, not silently retested as the same claim.
 */

export interface AdaptationContext {
  /** Current graph node keys in the target assessment (the only entities an adaptation may reference). */
  graphEntityKeys: Set<string>
  /** Current declared resource refs in the target assessment. */
  declaredResourceRefs: Set<string>
}

/** Ask the AI to propose an adaptation. Returns null when the AI is absent, fails, or proposes nothing valid. */
export async function proposeAdaptation(
  ai: ReasoningAi | undefined,
  engagementId: string,
  repro: ComparisonPlanInput,
  blockerReason: string,
  ctx: AdaptationContext,
  signal: AbortSignal | undefined,
): Promise<RetestAdaptation | null> {
  if (!ai) return null
  const task = RETEST_TASKS.adapter
  const subject = repro.arms.find((a) => a.role === 'subject') ?? repro.arms[0]
  const trusted = [
    jsonSection('retest-case', {
      dimension: repro.dimension,
      securityProperty: `${subject?.expected.outcome ?? 'unknown'} expected for ${subject?.identityRef ?? 'anonymous'} on ${repro.resourceRef}`,
      invariantRef: repro.invariantRef,
      currentUrl: subject?.url ?? null,
      currentResourceRef: repro.resourceRef,
      whyBlocked: blockerReason,
    }),
    jsonSection('graph-entities', [...ctx.graphEntityKeys].slice(0, 200)),
  ]
  let out
  try {
    out = await ai.run({
      spec: task.spec,
      prompt: task.prompt,
      context: { trusted, untrusted: [] },
      instruction:
        'The deterministic replay could not run because the application changed. Propose at most ONE adaptation that relocates the SAME test to its current location: a new URL, and/or an equivalent current resource. You MUST NOT change the security property, the expected outcome, the invariant, the identity or the tenant boundary. Reference only entity keys that already exist. If you cannot adapt without changing what is being tested, set adaptable=false.',
      jsonSchema: retestJsonSchema('adapter'),
      engagementId,
      runId: `retest-adapt-${randomUUID().slice(0, 8)}`,
      signal: signal ?? AbortSignal.timeout(task.spec.budget.wallClockMs),
    })
  } catch {
    return null
  }
  if (out.outcome !== 'succeeded') return null
  const parsed = RetestAdaptationOutputSchema.safeParse(out.output)
  if (!parsed.success) return null
  return validateAdaptation(parsed.data, repro, ctx, out.selection.providerId ?? null)
}

/**
 * Validate an AI adaptation proposal. An adaptation is accepted ONLY when it changes location (url/resource)
 * and every referenced entity already exists; anything that would change the tested property/identity is
 * rejected (returns null → the retest stays blocked/cannot-reproduce).
 */
export function validateAdaptation(proposal: RetestAdaptationOutput, repro: ComparisonPlanInput, ctx: AdaptationContext, providerId: string | null): RetestAdaptation | null {
  if (!proposal.adaptable || !proposal.kind) return null
  // Every referenced entity must already exist (never invent target state).
  for (const key of proposal.referencedEntityKeys) if (!ctx.graphEntityKeys.has(key)) return null
  // A substituted resource must be a currently-declared resource.
  if (proposal.newResourceRef && !ctx.declaredResourceRefs.has(proposal.newResourceRef)) return null
  // At least one concrete relocation must be present.
  if (!proposal.newUrl && !proposal.newResourceRef) return null

  const subject = repro.arms.find((a) => a.role === 'subject') ?? repro.arms[0]
  const before = proposal.newResourceRef ? `resource ${repro.resourceRef}` : `url ${subject?.url ?? ''}`
  const after = proposal.newResourceRef ? `resource ${proposal.newResourceRef}` : `url ${proposal.newUrl}`
  return {
    kind: proposal.kind,
    before,
    after,
    reason: proposal.reason,
    referencedEntityKeys: proposal.referencedEntityKeys,
    validated: true,
    providerId,
  }
}

/**
 * Apply a validated adaptation to the reproduction plan: swap the subject (and any arm sharing the old
 * endpoint/resource) to the new location, keeping every expectation, identity, role and control arm intact.
 */
export function applyAdaptation(repro: ComparisonPlanInput, adaptation: RetestAdaptation, newUrl: string | null, newResourceRef: string | null): ComparisonPlanInput {
  const oldUrl = repro.arms.find((a) => a.role === 'subject')?.url
  const arms = repro.arms.map((arm) => {
    let url = arm.url
    let resourceRef = arm.resourceRef
    if (newUrl && arm.url === oldUrl) url = newUrl
    if (newResourceRef && arm.resourceRef === repro.resourceRef) resourceRef = newResourceRef
    return { ...arm, url, resourceRef }
  })
  return {
    ...repro,
    resourceRef: newResourceRef ?? repro.resourceRef,
    arms,
    reason: `${repro.reason} (adapted: ${adaptation.kind})`,
  }
}
