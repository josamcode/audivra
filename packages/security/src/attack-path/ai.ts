import { toAgentJsonSchema, AttackPathExplanationOutput, AttackPathProposalOutput, type AiTaskSpec } from '@audivra/contracts'
import type { z } from 'zod'
import type { ReasoningPrompt } from '../reasoning/ai.ts'

/*
 * Phase 6B AI tasks, the Phase 4 way: a provider-independent spec, a role prompt and an output schema
 * AUDIVRA validates. Two bounded, structured-only tasks:
 *
 *   proposer  — may suggest a chain worth evaluating by referencing EXISTING finding ids and graph entity
 *               keys only. Every proposal is run through the same deterministic validator as a discovered
 *               path; it can never invent findings, entities, edges or evidence, nor promote an inferred step.
 *   explainer — authors a concise human-readable explanation of an already-validated path; it changes no
 *               step, state or confidence, and every fact traces to the structured path.
 */

export const ATTACK_PATH_TASKS = {
  proposer: {
    spec: {
      taskType: 'security-analyze-observations',
      role: 'security-attack-path-proposer',
      effort: 'standard',
      budget: { wallClockMs: 6 * 60_000, toolCalls: 0, turns: 4 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.attack-path-proposal.v1',
      allowedCapabilities: [],
      trustedRefs: ['findings', 'graph-entities', 'graph-edges'],
      untrustedRefs: [],
    },
    prompt: 'security-attack-path-proposer',
    schema: AttackPathProposalOutput,
  },
  explainer: {
    spec: {
      taskType: 'security-summarize',
      role: 'security-attack-path-explainer',
      effort: 'standard',
      budget: { wallClockMs: 4 * 60_000, toolCalls: 0, turns: 3 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.attack-path-explanation.v1',
      allowedCapabilities: [],
      trustedRefs: ['path', 'steps'],
      untrustedRefs: [],
    },
    prompt: 'security-attack-path-explainer',
    schema: AttackPathExplanationOutput,
  },
} as const satisfies Record<string, { spec: AiTaskSpec; prompt: ReasoningPrompt; schema: z.ZodType }>

export type AttackPathTaskName = keyof typeof ATTACK_PATH_TASKS

export function attackPathJsonSchema(task: AttackPathTaskName): Record<string, unknown> {
  return toAgentJsonSchema(ATTACK_PATH_TASKS[task].schema)
}
