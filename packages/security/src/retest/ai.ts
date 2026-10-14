import { toAgentJsonSchema, RetestAdaptationOutput, type AiTaskSpec } from '@audivra/contracts'
import type { z } from 'zod'
import type { ReasoningPrompt } from '../reasoning/ai.ts'

/*
 * Phase 6C AI task — a single, tightly-bounded adapter. When deterministic replay cannot run because the
 * application changed (an endpoint moved, a selector/route renamed, an equivalent resource exists elsewhere),
 * the adapter may propose a NEW LOCATION for the SAME test, referencing only current graph entities. It may
 * never change the security property, the expected invariant, the identity/tenant boundary or the finding
 * claim — Audivra validates and applies only a url/resource/selector change. If the AI is unavailable or its
 * proposal is invalid, the retest simply stays blocked/cannot-reproduce; no provider failure yields a fix.
 */

export const RETEST_TASKS = {
  adapter: {
    spec: {
      taskType: 'security-plan',
      role: 'security-retest-adapter',
      effort: 'standard',
      budget: { wallClockMs: 5 * 60_000, toolCalls: 0, turns: 3 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.retest-adaptation.v1',
      allowedCapabilities: [],
      trustedRefs: ['retest-case', 'graph-entities'],
      untrustedRefs: [],
    },
    prompt: 'security-retest-adapter',
    schema: RetestAdaptationOutput,
  },
} as const satisfies Record<string, { spec: AiTaskSpec; prompt: ReasoningPrompt; schema: z.ZodType }>

export type RetestTaskName = keyof typeof RETEST_TASKS

export function retestJsonSchema(task: RetestTaskName): Record<string, unknown> {
  return toAgentJsonSchema(RETEST_TASKS[task].schema)
}
