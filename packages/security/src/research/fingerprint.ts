import { createHash } from 'node:crypto'
import type { ComparisonPlanInput, ResearchActionKind } from '@audivra/contracts'

/*
 * Phase 6E — a stable action fingerprint for repetition prevention. Two actions with the same kind, asset,
 * identity, hypothesis/candidate and meaningful input share a fingerprint; the orchestrator will not repeat
 * one unless new evidence materially changes the situation.
 */

export function comparisonPlanFingerprint(plan: ComparisonPlanInput): string {
  const arms = plan.arms
    .map((a) => `${a.role}:${a.identityRef ?? 'anon'}:${a.resourceRef}:${a.method}:${a.expected.outcome}`)
    .sort()
    .join('|')
  return `${plan.dimension}:${plan.resourceRef}:${plan.action}:${arms}`
}

export function actionFingerprint(kind: ResearchActionKind, parts: { objectiveRef?: string | null; capabilityId?: string | null; input?: string }): string {
  const basis = `${kind}|${parts.objectiveRef ?? ''}|${parts.capabilityId ?? ''}|${parts.input ?? ''}`
  return `af:${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`
}
