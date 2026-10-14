import type { ResearchBudget, ResearchMode, ResearchUsage } from '@audivra/contracts'

/*
 * Phase 6E — safe default budgets per mode. Autonomy and execution power are separate dimensions: a larger
 * budget never grants new authority (the broker/policy still decide every action). The model never supplies
 * raw budget values; a user may only narrow within these ceilings.
 */

const DEFAULTS: Record<ResearchMode, ResearchBudget> = {
  'propose-only': { wallClockMs: 5 * 60_000, maxIterations: 1, maxActions: 8, maxAiCalls: 2, maxSpecialistRuns: 0, maxExpensiveActions: 0 },
  investigate: { wallClockMs: 20 * 60_000, maxIterations: 12, maxActions: 24, maxAiCalls: 12, maxSpecialistRuns: 1, maxExpensiveActions: 2 },
  'deep-authorized': { wallClockMs: 45 * 60_000, maxIterations: 24, maxActions: 48, maxAiCalls: 24, maxSpecialistRuns: 2, maxExpensiveActions: 4 },
}

export function defaultBudget(mode: ResearchMode, overrides?: Partial<ResearchBudget>): ResearchBudget {
  const base = DEFAULTS[mode]
  if (!overrides) return base
  // Only allow narrowing within the mode's ceilings (a user cannot grant a bigger budget than the mode's).
  const clamp = (key: keyof ResearchBudget) => Math.min(overrides[key] ?? base[key], base[key])
  return { wallClockMs: clamp('wallClockMs'), maxIterations: clamp('maxIterations'), maxActions: clamp('maxActions'), maxAiCalls: clamp('maxAiCalls'), maxSpecialistRuns: clamp('maxSpecialistRuns'), maxExpensiveActions: clamp('maxExpensiveActions') }
}

export const zeroUsage = (): ResearchUsage => ({ iterations: 0, actions: 0, aiCalls: 0, specialistRuns: 0, expensiveActions: 0, elapsedMs: 0 })

/** Whether the budget is exhausted — returns the first exhausted dimension, or null. */
export function budgetExhausted(budget: ResearchBudget, usage: ResearchUsage): 'budget-exhausted' | 'action-limit' | 'time-limit' | null {
  if (usage.elapsedMs >= budget.wallClockMs) return 'time-limit'
  if (usage.actions >= budget.maxActions) return 'action-limit'
  if (usage.iterations >= budget.maxIterations) return 'budget-exhausted'
  return null
}
