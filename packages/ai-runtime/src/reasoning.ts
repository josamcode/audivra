import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { engagementWorkspaceDir } from '@audivra/config'
import type { AiTaskOutcome, AiTaskSpec } from '@audivra/contracts'
import { buildAiContext, type AiContextSection } from './context.ts'
import { loadPrompt, type PromptName } from './prompts.ts'
import type { ProviderRouter, RouterEvent } from './router.ts'

/*
 * Structured security-reasoning tasks (Phase 4) on the Phase 3C platform: the security domain hands over an
 * `AiTaskSpec`, a trust-separated context and a JSON schema; this adapter renders the context with the
 * fenced trust boundary, loads the versioned role prompt, and runs it through the deterministic
 * `ProviderRouter` — capability/health selection, bounded transient fallback, a refusal recorded and never
 * rerouted. No session is resumed: every call rebuilds its context from stored state, so a lost session or
 * a different provider loses nothing. Tools are off; the model only returns structured output, which the
 * security domain validates before anything is stored.
 *
 * The shape matches `ReasoningAi` in @audivra/security (structurally; this package does not import it).
 */

export interface ReasoningTaskRequest {
  spec: AiTaskSpec
  prompt: 'security-researcher' | 'security-verifier' | 'security-planner' | 'security-comparison-planner' | 'security-finding-verifier' | 'security-finding-reviewer' | 'security-finding-prose'
  context: { trusted: AiContextSection[]; untrusted: AiContextSection[] }
  instruction: string
  jsonSchema: Record<string, unknown>
  engagementId: string
  runId: string
  signal: AbortSignal
}

export interface ReasoningTaskResult extends AiTaskOutcome {
  promptVersion: string | null
}

export interface ReasoningAiAdapter {
  run(task: ReasoningTaskRequest): Promise<ReasoningTaskResult>
}

export function createReasoningAi(router: ProviderRouter, options: { workspaceRoot?: (engagementId: string) => string; onEvent?: (event: RouterEvent, task: ReasoningTaskRequest) => void } = {}): ReasoningAiAdapter {
  const root = options.workspaceRoot ?? engagementWorkspaceDir
  return {
    async run(task) {
      const prompt = loadPrompt(`${task.prompt}-system` as PromptName)
      const cwd = path.join(root(task.engagementId), 'reasoning', task.runId)
      await mkdir(cwd, { recursive: true })
      const userPrompt = `${buildAiContext(task.context)}\n\n## Task\n${task.instruction}\n\nReturn only the structured output.`
      const outcome = await router.run(
        task.spec,
        (provider) =>
          provider.run({
            role: task.spec.role,
            cwd,
            systemPromptFile: prompt.path,
            prompt: userPrompt,
            jsonSchema: task.jsonSchema,
            maxTurns: task.spec.budget.turns,
            timeoutMs: task.spec.budget.wallClockMs,
            tools: [],
            allowedTools: [],
            signal: task.signal,
          }),
        { promptVersion: prompt.version, onEvent: options.onEvent ? (event) => options.onEvent!(event, task) : undefined },
      )
      return { ...outcome, promptVersion: prompt.version }
    },
  }
}
