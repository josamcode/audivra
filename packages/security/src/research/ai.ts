import { toAgentJsonSchema, ResearchPlannerOutput, type AiTaskSpec } from '@audivra/contracts'
import type { z } from 'zod'
import type { ReasoningPrompt } from '../reasoning/ai.ts'

/*
 * Phase 6E AI task — the research planner. Given a bounded, structured slice of the engagement (objective,
 * top hypotheses/gaps, relevant graph neighbourhood, recent actions, eligible capabilities), it proposes a
 * small number of TYPED next actions referencing existing ids only, with concise rationale. It never supplies
 * a command, flags, credentials or budget; its priority is advisory. Every proposal is validated and ranked
 * deterministically, so the AI cannot bypass policy, repeat work, invent references or force an expensive
 * engine. Audivra works even when this task is unavailable.
 */

export const RESEARCH_TASKS = {
  planner: {
    spec: {
      taskType: 'security-plan',
      role: 'security-research-planner',
      effort: 'standard',
      budget: { wallClockMs: 6 * 60_000, toolCalls: 0, turns: 4 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.research-plan.v1',
      allowedCapabilities: [],
      trustedRefs: ['objective', 'coverage', 'hypotheses', 'gaps', 'recent-actions', 'capabilities'],
      untrustedRefs: ['graph'],
    },
    prompt: 'security-research-planner',
    schema: ResearchPlannerOutput,
  },
} as const satisfies Record<string, { spec: AiTaskSpec; prompt: ReasoningPrompt; schema: z.ZodType }>

export type ResearchTaskName = keyof typeof RESEARCH_TASKS

export function researchJsonSchema(task: ResearchTaskName): Record<string, unknown> {
  return toAgentJsonSchema(RESEARCH_TASKS[task].schema)
}
