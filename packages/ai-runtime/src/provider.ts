import type { AgentRole, ProviderCapabilities, ProviderHealth } from '@audivra/contracts'

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
  /** Audit the run belongs to (process ownership + accounting). */
  auditId?: string
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
  /**
   * Safety ceilings on tool calls by kind (browser, terminal, file, read, evidence, web, other) and
   * `total`. Exceeding one stops the run; with `wrapUp` the agent is then asked for its result.
   */
  toolCallLimits?: Record<string, number>
  /**
   * Graceful termination: when the run hits its time budget, turn limit or a tool ceiling, the
   * session is resumed without tools and asked to return the structured output from its work so far.
   */
  wrapUp?: { prompt: string; maxTurns: number; timeoutMs: number }
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
  /**
   * completed | max-turns | timeout | tool-budget | cancelled | error, or `wrapped-up:<reason>` when a
   * ceiling was reached and the wrap-up turn still produced the structured output.
   */
  terminationReason: string
  /** Tool calls by kind: browser, terminal, file, read, evidence, web, output, other. */
  toolCalls: Record<string, number>
}

export interface ProviderAvailability {
  available: boolean
  version: string | null
  reason: string | null
}

/**
 * The stable Audivra seam every AI provider implements. `run()` subsumes start / resume (via
 * `resumeSessionId`) / cancel (via `signal`); `health()` and `capabilities()` let the router decide
 * eligibility before dispatch. Provider-specific command-line/session/format details live only inside the
 * adapter — never in the security or audit domains.
 */
export interface AgentProvider {
  readonly id: string
  /** Semver-ish adapter version, recorded in provenance so a change is attributable. */
  readonly adapterVersion: string
  isAvailable(): Promise<ProviderAvailability>
  /** Normalized health for the router and the System view. */
  health(): Promise<ProviderHealth>
  /** What this provider/model can do, so the router can match a task's requirements before dispatch. */
  capabilities(): ProviderCapabilities
  run(request: AgentRunRequest): Promise<AgentRunResult>
}
