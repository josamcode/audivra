import type { AuditContext } from '@audivra/audit-core'
import type { AgentRole } from '@audivra/contracts'
import { recordEvent, startAgentRun, updateAgentRun } from '@audivra/database'
import { auditMcpServer, browserMcpServer } from '../mcp/servers.ts'
import type { PromptFile } from '../prompts.ts'
import type { AgentProvider, AgentRunResult, McpServerSpec } from '../provider.ts'

/** Permissions for agents that investigate the live site (auditor and revision pass). */
export const INVESTIGATOR_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'TodoWrite']
export const INVESTIGATOR_ALLOWED = [
  'Bash',
  'Read(./**)',
  'Write(./**)',
  'Edit(./**)',
  'Glob',
  'Grep',
  'WebFetch',
  'TodoWrite',
  'mcp__browser',
  'mcp__audit',
]

/**
 * Hard denials layered on top of the prompt's safety rules: no destructive commands, no data-changing
 * HTTP requests (form submissions), no active security scanners.
 */
export const INVESTIGATOR_DENIED = [
  'Bash(rm -rf /*)',
  'Bash(rm -rf ~*)',
  'Bash(rm -rf ..*)',
  'Bash(git push*)',
  'Bash(git commit*)',
  'Bash(npm publish*)',
  'Bash(pnpm publish*)',
  'Bash(npm install -g*)',
  'Bash(shutdown*)',
  'Bash(reboot*)',
  'Bash(curl * -X POST*)',
  'Bash(curl * -X PUT*)',
  'Bash(curl * -X PATCH*)',
  'Bash(curl * -X DELETE*)',
  'Bash(curl * -d *)',
  'Bash(curl * --data*)',
  'Bash(curl * -F *)',
  'Bash(curl * --form*)',
  'Bash(*nuclei*)',
  'Bash(*sqlmap*)',
  'Bash(*hydra*)',
  'Bash(*nikto*)',
  'Bash(*zap-full-scan*)',
  'Bash(*zap-api-scan*)',
  'Bash(*ffuf*)',
  'Bash(*gobuster*)',
  'Bash(*dirb*)',
  'Bash(*wfuzz*)',
  // Runs arbitrary code inside the browser server process (outside the workspace) — scripts in
  // ./scripts cover every legitimate need. Uploading local files to a site is never needed.
  'mcp__browser__browser_run_code_unsafe',
  'mcp__browser__browser_file_upload',
]

export const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep']
export const REVIEWER_ALLOWED = [
  'Read(./**)',
  'Glob',
  'Grep',
  'mcp__audit__list_evidence',
  'mcp__audit__get_evidence',
  'mcp__audit__log_activity',
]

export interface RoleRunOptions {
  role: AgentRole
  prompt: PromptFile
  userPrompt: string
  jsonSchema: Record<string, unknown>
  model?: string
  effort?: string
  maxTurns: number
  timeoutMs: number
  tools: string[]
  allowedTools: string[]
  disallowedTools?: string[]
  mcp: { browser: boolean; audit: boolean }
  resumeSessionId?: string
  toolCallLimits?: Record<string, number>
  wrapUp?: { prompt: string; maxTurns: number; timeoutMs: number }
}

export interface RoleRunOutcome {
  agentRunId: string
  result: AgentRunResult
}

/** Runs one agent role with full lifecycle persistence (AgentRun row, activity events, transcript, output file). */
export async function runRole(
  ctx: AuditContext,
  provider: AgentProvider,
  options: RoleRunOptions,
): Promise<RoleRunOutcome> {
  const agentRunId = await startAgentRun(ctx.db, {
    auditId: ctx.auditId,
    role: options.role,
    provider: provider.id,
    model: options.model ?? null,
    promptVersion: options.prompt.version,
  })
  await ctx.ws.writeText(`agent/${options.role}-prompt.md`, options.userPrompt)
  await recordEvent(ctx.db, {
    auditId: ctx.auditId,
    type: 'agent.started',
    message: `${roleLabel(options.role)} started${options.resumeSessionId ? ' (continuing the auditor session)' : ''}`,
    data: { role: options.role, agentRunId, promptVersion: options.prompt.version },
    agentRunId,
  })

  const mcpServers: Record<string, McpServerSpec> = {}
  if (options.mcp.browser) mcpServers.browser = browserMcpServer(ctx.ws.root)
  if (options.mcp.audit) {
    mcpServers.audit = auditMcpServer({
      auditId: ctx.auditId,
      workspaceRoot: ctx.ws.root,
      agentRunId,
      role: options.role,
    })
  }

  const result = await provider.run({
    role: options.role,
    auditId: ctx.auditId,
    cwd: ctx.ws.root,
    systemPromptFile: options.prompt.path,
    prompt: options.userPrompt,
    jsonSchema: options.jsonSchema,
    model: options.model,
    effort: options.effort,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs,
    tools: options.tools,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    mcpServers,
    resumeSessionId: options.resumeSessionId,
    toolCallLimits: options.toolCallLimits,
    wrapUp: options.wrapUp,
    signal: ctx.signal,
    transcriptFile: ctx.ws.abs(`agent/${options.role}-transcript.jsonl`),
    onStart: (info) => {
      void updateAgentRun(ctx.db, agentRunId, { sessionId: info.sessionId, model: info.model }).catch(
        () => undefined,
      )
    },
    onActivity: (activity) => {
      void recordEvent(ctx.db, {
        auditId: ctx.auditId,
        type: 'agent.activity',
        level: activity.level ?? 'info',
        message: activity.message,
        data: { role: options.role, kind: activity.kind, tool: activity.tool },
        agentRunId,
      }).catch((error: unknown) => ctx.log.warn({ err: error }, 'failed to record agent activity'))
    },
  })

  if (result.output !== null && result.output !== undefined) {
    await ctx.ws.writeJson(`agent/${options.role}-output.json`, result.output)
  }
  await updateAgentRun(ctx.db, agentRunId, {
    status: result.status,
    sessionId: result.sessionId,
    model: result.model,
    numTurns: result.numTurns,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    error: result.error,
    output: result.output ?? null,
    usage: result.usage,
    terminationReason: result.terminationReason,
    toolCalls: result.toolCalls,
    finishedAt: new Date(),
  })
  const minutes = Math.max(1, Math.round(result.durationMs / 60000))
  await recordEvent(ctx.db, {
    auditId: ctx.auditId,
    type: result.status === 'completed' ? 'agent.completed' : 'agent.failed',
    level: result.status === 'completed' ? 'info' : 'error',
    message:
      result.status === 'completed'
        ? `${roleLabel(options.role)} finished in ${minutes} min (${result.numTurns ?? '?'} turns)`
        : `${roleLabel(options.role)} ${result.status === 'cancelled' ? 'cancelled' : `failed: ${result.error}`}`,
    data: {
      role: options.role,
      agentRunId,
      status: result.status,
      model: result.model,
      terminationReason: result.terminationReason,
      toolCalls: result.toolCalls,
    },
    agentRunId,
  })
  return { agentRunId, result }
}

export function roleLabel(role: AgentRole): string {
  return {
    auditor: 'AI Auditor',
    reviewer: 'AI Reviewer',
    revision: 'Auditor verification pass',
    finalizer: 'Finalizer',
    planner: 'Artifact Planner',
    composer: 'Report Composer',
    journeys: 'Journey analysis',
    changes: 'Change intelligence',
    brief: 'Client brief',
  }[role]
}
