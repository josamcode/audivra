import { toAgentJsonSchema, FindingProseOutput, FindingReviewOutput, FindingVerifierOutput, type AiTaskSpec } from '@audivra/contracts'
import type { z } from 'zod'
import type { ReasoningPrompt } from '../reasoning/ai.ts'

/*
 * Phase 6A — the AI tasks of the verification boundary, defined the Phase 4 way: a provider-independent
 * `AiTaskSpec`, a role prompt and an output schema AUDIVRA validates. Three cautious, structured-only tasks:
 *
 *   verifier  — an INDEPENDENT reviewer that reasons about a candidate's evidence and returns confirm /
 *               disprove / alternative / needs-evidence. It can never fabricate evidence; AUDIVRA already
 *               decided whether the required evidence exists, and a provider failure is `blocked`, not verified.
 *   prose     — authors the human-facing title/impact/remediation; every factual reference is re-checked
 *               against stored state before persistence, and it can never change severity or confidence.
 *   reviewer  — an optional second stage that may only make a finding MORE cautious (lower severity, flag a
 *               duplicate or ask for caution); AUDIVRA ignores any attempt to strengthen it.
 */

export const VERIFICATION_TASKS = {
  verifier: {
    spec: {
      taskType: 'security-verify-claim',
      role: 'security-finding-verifier',
      effort: 'standard',
      budget: { wallClockMs: 6 * 60_000, toolCalls: 0, turns: 4 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.finding-verifier-output.v1',
      allowedCapabilities: [],
      trustedRefs: ['candidate', 'requirements', 'check-results'],
      untrustedRefs: ['evidence'],
    },
    prompt: 'security-finding-verifier',
    schema: FindingVerifierOutput,
  },
  prose: {
    spec: {
      taskType: 'security-summarize',
      role: 'security-finding-prose',
      effort: 'standard',
      budget: { wallClockMs: 5 * 60_000, toolCalls: 0, turns: 3 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.finding-prose-output.v1',
      allowedCapabilities: [],
      trustedRefs: ['finding', 'severity', 'affected-entities'],
      untrustedRefs: ['evidence'],
    },
    prompt: 'security-finding-prose',
    schema: FindingProseOutput,
  },
  reviewer: {
    spec: {
      taskType: 'security-verify-claim',
      role: 'security-finding-reviewer',
      effort: 'standard',
      budget: { wallClockMs: 5 * 60_000, toolCalls: 0, turns: 3 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.finding-review-output.v1',
      allowedCapabilities: [],
      trustedRefs: ['finding', 'severity', 'check-results'],
      untrustedRefs: ['evidence'],
    },
    prompt: 'security-finding-reviewer',
    schema: FindingReviewOutput,
  },
} as const satisfies Record<string, { spec: AiTaskSpec; prompt: ReasoningPrompt; schema: z.ZodType }>

export type VerificationTaskName = keyof typeof VERIFICATION_TASKS

export function verificationJsonSchema(task: VerificationTaskName): Record<string, unknown> {
  return toAgentJsonSchema(VERIFICATION_TASKS[task].schema)
}
