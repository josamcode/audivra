import type { AgentRole } from '@audivra/contracts'

/** A concise, user-facing description of something the agent did (never its reasoning). */
export interface AgentActivity {
  kind: 'browser' | 'terminal' | 'file' | 'evidence' | 'search' | 'other'
  tool: string
  message: string
  level?: 'info' | 'warn'
}

export interface McpServerSpec {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface AgentRunRequest {
  role: AgentRole
  /** Working directory (the audit workspace). */
  cwd: string
  /** Role prompt file (appended to the provider's agent system prompt). */
  systemPromptFile: string
  /** The task prompt (sent on stdin). */
  prompt: string
  /** JSON Schema the final structured output must satisfy. */
  jsonSchema: Record<string, unknown>
  model?: string
  effort?: string
  maxTurns?: number
  timeoutMs: number
  /** Built-in tools made available to the agent. */
  tools: string[]
  /** Permission allow rules (tools not allowed are denied, never prompted). */
  allowedTools: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerSpec>
  /** Continue an earlier session (used for the focused revision pass). */
  resumeSessionId?: string
  env?: Record<string, string>
  signal: AbortSignal
  /** Raw event log for debugging (thinking content is never written). */
  transcriptFile?: string
  onActivity?: (activity: AgentActivity) => void
  onStart?: (info: {
    sessionId: string | null
    model: string | null
    mcpServers: { name: string; status: string }[]
  }) => void
}

export interface AgentRunResult {
  status: 'completed' | 'failed' | 'cancelled'
  output: unknown
  sessionId: string | null
  model: string | null
  numTurns: number | null
  costUsd: number | null
  durationMs: number
  error: string | null
  permissionDenials: unknown[]
  usage: Record<string, unknown> | null
}

export interface ProviderAvailability {
  available: boolean
  version: string | null
  reason: string | null
}

/** Seam for AI providers. Only Claude (via the local Claude Code CLI) is implemented in the MVP. */
export interface AgentProvider {
  readonly id: string
  isAvailable(): Promise<ProviderAvailability>
  run(request: AgentRunRequest): Promise<AgentRunResult>
}
