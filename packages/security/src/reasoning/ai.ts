import { toAgentJsonSchema, ComparisonPlannerOutput, PlannerOutput, ResearcherOutput, VerifierOutput, type AiTaskOutcome, type AiTaskSpec } from '@audivra/contracts'
import type { z } from 'zod'

/*
 * The reasoning engine's only view of AI: a port. The security domain describes WHAT reasoning it needs (an
 * `AiTaskSpec`, a trust-separated context, a JSON schema) and receives a normalized `AiTaskOutcome`. Which
 * provider runs it, how it is selected, retried or refused is the Phase 3C router's job, wired in by the
 * worker (`@audivra/ai-runtime`'s `createReasoningAi`). Nothing here knows about a specific provider, and
 * a provider never writes Audivra state: every output is validated before anything is persisted.
 */

export interface ReasoningContextSection {
  label: string
  content: string
}

export type ReasoningPrompt =
  | 'security-researcher'
  | 'security-verifier'
  | 'security-planner'
  | 'security-comparison-planner'
  | 'security-finding-verifier'
  | 'security-finding-reviewer'
  | 'security-finding-prose'
  | 'security-attack-path-proposer'
  | 'security-attack-path-explainer'
  | 'security-retest-adapter'

export interface ReasoningAiTask {
  spec: AiTaskSpec
  prompt: ReasoningPrompt
  /** TRUSTED (Audivra-owned) and UNTRUSTED (target/tool-derived) material, rendered with a fenced boundary. */
  context: { trusted: ReasoningContextSection[]; untrusted: ReasoningContextSection[] }
  /** The task request itself (trusted). */
  instruction: string
  jsonSchema: Record<string, unknown>
  engagementId: string
  runId: string
  signal: AbortSignal
}

export interface ReasoningAiResult extends AiTaskOutcome {
  /** Version of the role prompt used (recorded with the hypotheses it produced). */
  promptVersion: string | null
}

export interface ReasoningAi {
  run(task: ReasoningAiTask): Promise<ReasoningAiResult>
}

/** Provider-independent task specs. Context is rebuilt from stored state on every call (no session resume). */
export const REASONING_TASKS = {
  researcher: {
    spec: {
      taskType: 'security-analyze-observations',
      role: 'security-researcher',
      effort: 'standard',
      budget: { wallClockMs: 8 * 60_000, toolCalls: 0, turns: 4 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.researcher-output.v1',
      allowedCapabilities: [],
      trustedRefs: ['engagement', 'scope', 'capabilities', 'hypotheses', 'gaps'],
      untrustedRefs: ['graph', 'observations'],
    },
    prompt: 'security-researcher',
    schema: ResearcherOutput,
  },
  verifier: {
    spec: {
      taskType: 'security-verify-claim',
      role: 'security-verifier',
      effort: 'standard',
      budget: { wallClockMs: 6 * 60_000, toolCalls: 0, turns: 4 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.verifier-output.v1',
      allowedCapabilities: [],
      trustedRefs: ['hypotheses'],
      untrustedRefs: ['observations'],
    },
    prompt: 'security-verifier',
    schema: VerifierOutput,
  },
  planner: {
    spec: {
      taskType: 'security-plan',
      role: 'security-planner',
      effort: 'standard',
      budget: { wallClockMs: 6 * 60_000, toolCalls: 0, turns: 4 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.planner-output.v1',
      allowedCapabilities: [],
      trustedRefs: ['hypotheses', 'capabilities', 'scope'],
      untrustedRefs: ['graph'],
    },
    prompt: 'security-planner',
    schema: PlannerOutput,
  },
  comparisonPlanner: {
    spec: {
      taskType: 'security-plan',
      role: 'security-comparison-planner',
      effort: 'standard',
      budget: { wallClockMs: 6 * 60_000, toolCalls: 0, turns: 4 },
      requirements: { structuredOutput: true, toolUse: false, sessionResume: false },
      outputSchemaId: 'audivra.security.comparison-planner-output.v1',
      allowedCapabilities: [],
      trustedRefs: ['identities', 'resources', 'roles', 'actions', 'invariants', 'gaps', 'comparisons'],
      untrustedRefs: [],
    },
    prompt: 'security-comparison-planner',
    schema: ComparisonPlannerOutput,
  },
} as const satisfies Record<string, { spec: AiTaskSpec; prompt: ReasoningPrompt; schema: z.ZodType }>

export type ReasoningTaskName = keyof typeof REASONING_TASKS

export function reasoningJsonSchema(task: ReasoningTaskName): Record<string, unknown> {
  return toAgentJsonSchema(REASONING_TASKS[task].schema)
}

/** Renders a value as a fenced JSON block (the shape a deterministic test provider can read back). */
export function jsonSection(label: string, value: unknown): ReasoningContextSection {
  return { label: `${label} (JSON)`, content: `\`\`\`json\n${JSON.stringify(value, null, 1)}\n\`\`\`` }
}

/** Reads a JSON section back out of a rendered prompt (used by deterministic test providers). */
export function readJsonSection<T = unknown>(prompt: string, label: string): T | null {
  const marker = `### ${label} (JSON)\n\`\`\`json\n`
  const start = prompt.indexOf(marker)
  if (start < 0) return null
  const end = prompt.indexOf('\n```', start + marker.length)
  if (end < 0) return null
  try {
    return JSON.parse(prompt.slice(start + marker.length, end)) as T
  } catch {
    return null
  }
}
