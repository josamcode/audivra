import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import { getConfig } from '@audivra/config'
import { AI_TASK_TYPES, type ProviderCapabilities, type ProviderHealth, type ProviderHealthState } from '@audivra/contracts'
import { browserEnv, probeVersion, registerOwned, runProcess, toolBinDirs } from '@audivra/tool-runtime'
import type { AgentProvider, AgentRunRequest, AgentRunResult, ProviderAvailability } from '../provider.ts'
import { describeToolUse } from './activity.ts'

type StreamMessage = {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  mcp_servers?: { name: string; status: string }[]
  message?: { content?: ContentBlock[]; model?: string }
  parent_tool_use_id?: string | null
  // result fields
  structured_output?: unknown
  result?: string
  is_error?: boolean
  num_turns?: number
  total_cost_usd?: number
  permission_denials?: unknown[]
  usage?: Record<string, unknown>
  modelUsage?: Record<string, unknown>
  terminal_reason?: string
  api_error_status?: number | null
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content?: unknown }
  | { type: 'thinking' | 'redacted_thinking'; [key: string]: unknown }

/** Removes thinking blocks before anything is written to disk: private reasoning is never persisted. */
function redactThinking(message: StreamMessage): StreamMessage {
  if (!message.message?.content) return message
  return {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking'),
    },
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join(' ')
  }
  return ''
}

/**
 * Runs agents through the locally installed, already-authenticated Claude Code CLI in
 * non-interactive print mode. Permissions stay enabled: only the listed tools are allowed and
 * everything else is denied without prompting (`--permission-mode dontAsk`).
 */
export class ClaudeCliProvider implements AgentProvider {
  readonly id = 'claude-code-cli'
  readonly adapterVersion = '1'

  constructor(private readonly bin = getConfig().CLAUDE_BIN) {}

  async isAvailable(): Promise<ProviderAvailability> {
    const version = await probeVersion(this.bin, ['--version'])
    if (!version) return { available: false, version: null, reason: 'Claude Code CLI not found on PATH' }
    const auth = await runProcess({ command: this.bin, args: ['auth', 'status'], timeoutMs: 20000 })
    try {
      const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean }
      if (!parsed.loggedIn)
        return { available: false, version, reason: 'Claude Code is not logged in (run `claude auth login`)' }
    } catch {
      // Older CLIs may not support `auth status`; assume usable and let the run report problems.
    }
    return { available: true, version, reason: null }
  }

  /** Normalized health: `disabled` when AI is turned off, else derived from availability. */
  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    if (getConfig().AUDIVRA_AI === 'off') return { providerId: this.id, state: 'disabled', version: null, detail: 'AI disabled (AUDIVRA_AI=off)', checkedAt }
    const availability = await this.isAvailable()
    let state: ProviderHealthState = 'ready'
    if (!availability.available) state = /logged in|auth/i.test(availability.reason ?? '') ? 'auth-required' : 'unavailable'
    return { providerId: this.id, state, version: availability.version, detail: availability.reason, checkedAt }
  }

  /** The local Claude Code CLI supports Audivra's full capability surface. */
  capabilities(): ProviderCapabilities {
    return {
      providerId: this.id,
      structuredOutput: true,
      toolUse: true,
      sessionResume: true,
      browserTools: true,
      maxContextTokens: 200_000,
      effortLevels: ['low', 'standard', 'high'],
      taskTypes: [...AI_TASK_TYPES],
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const first = await this.runOnce(request)
    const reason = first.terminationReason
    const wrapUp = request.wrapUp
    if (!wrapUp || !first.sessionId || request.signal.aborted || !WRAP_UP_REASONS[reason]) return first

    // Bounded autonomy: a ceiling was reached. Resume the same session once, without tools, and ask for
    // the structured result from the work done so far — a runaway run ends gracefully, not empty-handed.
    request.onActivity?.({
      kind: 'other',
      tool: 'runtime',
      level: 'warn',
      message: `Reached the ${WRAP_UP_REASONS[reason]} — asking for the result from the work done so far`,
    })
    const second = await this.runOnce({
      ...request,
      prompt: `${WRAP_UP_PREFIX[reason]} ${wrapUp.prompt}`,
      resumeSessionId: first.sessionId,
      tools: [],
      allowedTools: [],
      disallowedTools: undefined,
      mcpServers: undefined,
      maxTurns: wrapUp.maxTurns,
      timeoutMs: wrapUp.timeoutMs,
      toolCallLimits: undefined,
      wrapUp: undefined,
    })
    const toolCalls = { ...first.toolCalls }
    for (const [kind, count] of Object.entries(second.toolCalls)) toolCalls[kind] = (toolCalls[kind] ?? 0) + count
    const sum = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0))
    const merged = {
      ...second,
      sessionId: second.sessionId ?? first.sessionId,
      model: second.model ?? first.model,
      numTurns: sum(first.numTurns, second.numTurns),
      costUsd: sum(first.costUsd, second.costUsd),
      durationMs: first.durationMs + second.durationMs,
      permissionDenials: [...first.permissionDenials, ...second.permissionDenials],
      usage: { main: first.usage, wrapUp: second.usage },
      toolCalls,
    }
    if (second.status === 'completed') return { ...merged, terminationReason: `wrapped-up:${reason}` }
    return {
      ...merged,
      status: second.status === 'cancelled' ? 'cancelled' : 'failed',
      output: null,
      error: `${first.error ?? reason}; the wrap-up turn also failed: ${second.error ?? 'unknown error'}`,
      terminationReason: second.status === 'cancelled' ? 'cancelled' : reason,
    }
  }

  private async runOnce(request: AgentRunRequest): Promise<AgentRunResult> {
    const started = Date.now()
    const agentDir = path.join(request.cwd, 'agent')
    await mkdir(agentDir, { recursive: true })

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt-file',
      request.systemPromptFile,
      '--json-schema',
      JSON.stringify(request.jsonSchema),
      '--permission-mode',
      'dontAsk',
      '--tools',
      request.tools.join(','),
      '--disable-slash-commands',
      '--no-chrome',
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
    ]
    if (request.allowedTools.length) args.push('--allowedTools', ...request.allowedTools)
    if (request.disallowedTools?.length) args.push('--disallowedTools', ...request.disallowedTools)
    if (request.mcpServers && Object.keys(request.mcpServers).length) {
      const mcpFile = path.join(agentDir, `mcp-${request.role}.json`)
      await writeFile(mcpFile, JSON.stringify({ mcpServers: request.mcpServers }, null, 2), 'utf8')
      args.push('--mcp-config', mcpFile)
    }
    if (request.model) args.push('--model', request.model)
    if (request.effort) args.push('--effort', request.effort)
    if (request.maxTurns) args.push('--max-turns', String(request.maxTurns))
    if (request.resumeSessionId) args.push('--resume', request.resumeSessionId)

    let transcript: WriteStream | null = null
    if (request.transcriptFile) {
      await mkdir(path.dirname(request.transcriptFile), { recursive: true })
      transcript = createWriteStream(request.transcriptFile, { flags: 'a' })
    }

    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    const env: Record<string, string> = {
      ...browserEnv(),
      ...request.env,
      [pathKey]: [...toolBinDirs(), process.env[pathKey] ?? ''].join(path.delimiter),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }

    let sessionId: string | null = null
    let model: string | null = null
    let final: StreamMessage | null = null
    let stderr = ''
    const toolNames = new Map<string, string>()
    const toolCalls: Record<string, number> = {}

    const child = execa(this.bin, args, {
      cwd: request.cwd,
      env,
      extendEnv: true,
      input: request.prompt,
      buffer: false,
      reject: false,
      windowsHide: true,
      stripFinalNewline: false,
    })

    // Registered in the ownership registry: cancellation and timeouts terminate only this process
    // tree (the CLI and the MCP servers/shells it started), never anything else on the machine.
    const owned = registerOwned(child.pid, {
      tool: `claude:${request.role}`,
      auditId: request.auditId ?? null,
      cwd: request.cwd,
      command: `${this.bin} -p (${request.role})`,
    })
    let killedBy: 'timeout' | 'cancel' | 'tool-budget' | null = null
    let budgetDetail = ''
    const kill = (reason: 'timeout' | 'cancel' | 'tool-budget') => {
      if (killedBy) return
      killedBy = reason
      void owned?.kill()
    }
    const timer = setTimeout(() => kill('timeout'), request.timeoutMs)
    const onAbort = () => kill('cancel')
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) kill('cancel')

    let pending = ''
    const handleLine = (line: string) => {
      if (!line.trim()) return
      let message: StreamMessage
      try {
        message = JSON.parse(line) as StreamMessage
      } catch {
        return
      }
      transcript?.write(`${JSON.stringify(redactThinking(message))}\n`)
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id ?? sessionId
        model = message.model ?? model
        request.onStart?.({ sessionId, model, mcpServers: message.mcp_servers ?? [] })
        for (const server of message.mcp_servers ?? []) {
          if (server.status !== 'connected') {
            request.onActivity?.({
              kind: 'other',
              tool: 'mcp',
              level: 'warn',
              message: `MCP server "${server.name}" is ${server.status}`,
            })
          }
        }
        return
      }
      if (message.type === 'assistant' && message.message?.content) {
        if (message.message.model) model = message.message.model
        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue
          toolNames.set(block.id, block.name)
          const kind = toolCallKind(block.name)
          toolCalls[kind] = (toolCalls[kind] ?? 0) + 1
          const activity = describeToolUse(block.name, block.input ?? {}, request.cwd)
          if (activity) request.onActivity?.(activity)
          const limits = request.toolCallLimits
          if (limits && !killedBy && kind !== 'output') {
            const total = Object.entries(toolCalls).reduce((n, [k, c]) => (k === 'output' ? n : n + c), 0)
            if (limits[kind] !== undefined && toolCalls[kind]! > limits[kind]!) budgetDetail = `${limits[kind]} ${kind} calls`
            else if (limits.total !== undefined && total > limits.total) budgetDetail = `${limits.total} tool calls`
            if (budgetDetail) kill('tool-budget')
          }
        }
        return
      }
      if (message.type === 'user' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type !== 'tool_result' || !block.is_error) continue
          const text = resultText(block.content)
          if (/permission|denied|not allowed/i.test(text)) {
            request.onActivity?.({
              kind: 'other',
              tool: toolNames.get(block.tool_use_id) ?? 'tool',
              level: 'warn',
              message: `Blocked by safety policy: ${text.slice(0, 160)}`,
            })
          }
        }
        return
      }
      if (message.type === 'result') final = message
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk
      let index = pending.indexOf('\n')
      while (index >= 0) {
        handleLine(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })

    const exit = await child
    owned?.finish(exit.exitCode ?? null)
    if (pending.trim()) handleLine(pending)
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
    await new Promise<void>((resolve) => (transcript ? transcript.end(resolve) : resolve()))

    const result = final as StreamMessage | null
    const base = {
      sessionId: result?.session_id ?? sessionId,
      model,
      numTurns: result?.num_turns ?? null,
      costUsd: result?.total_cost_usd ?? null,
      durationMs: Date.now() - started,
      permissionDenials: result?.permission_denials ?? [],
      usage: result ? { usage: result.usage ?? null, modelUsage: result.modelUsage ?? null } : null,
      toolCalls,
    }
    if (killedBy === 'cancel') {
      return { ...base, status: 'cancelled', output: null, error: 'Cancelled', terminationReason: 'cancelled' }
    }
    if (killedBy === 'timeout') {
      return {
        ...base,
        status: 'failed',
        output: null,
        error: `Timed out after ${Math.round(request.timeoutMs / 60000)} minutes`,
        terminationReason: 'timeout',
      }
    }
    if (killedBy === 'tool-budget') {
      return {
        ...base,
        status: 'failed',
        output: null,
        error: `Stopped at the safety ceiling of ${budgetDetail}`,
        terminationReason: 'tool-budget',
      }
    }
    if (!result) {
      const detail =
        stderr.trim().split('\n').slice(-5).join(' ') || exit.shortMessage || `exit code ${exit.exitCode}`
      return {
        ...base,
        status: 'failed',
        output: null,
        error: `Claude CLI ended without a result: ${detail.slice(0, 600)}`,
        terminationReason: 'error',
      }
    }
    if (result.is_error || result.subtype !== 'success') {
      const reason =
        result.subtype === 'error_max_turns'
          ? 'Reached the maximum number of turns before producing a result'
          : `${result.subtype ?? 'error'}${result.api_error_status ? ` (API ${result.api_error_status})` : ''}: ${(result.result ?? '').slice(0, 400)}`
      return {
        ...base,
        status: 'failed',
        output: result.structured_output ?? null,
        error: reason,
        terminationReason: result.subtype === 'error_max_turns' ? 'max-turns' : 'error',
      }
    }
    if (result.structured_output === undefined || result.structured_output === null) {
      return { ...base, status: 'failed', output: null, error: 'Run finished without structured output', terminationReason: 'error' }
    }
    return { ...base, status: 'completed', output: result.structured_output, error: null, terminationReason: 'completed' }
  }
}

/** Termination reasons that trigger the wrap-up turn, with how they are described to the user. */
const WRAP_UP_REASONS: Record<string, string> = {
  timeout: 'time budget',
  'max-turns': 'turn limit',
  'tool-budget': 'tool-call ceiling',
}

const WRAP_UP_PREFIX: Record<string, string> = {
  timeout: 'Your time budget for this run is used up and your tools have been switched off.',
  'max-turns': 'You have reached the turn limit for this run and your tools have been switched off.',
  'tool-budget': 'You have reached the tool-call ceiling for this run and your tools have been switched off.',
}

/** Tool-call accounting by kind (shown on Runs; also used to spot wasted effort). */
export function toolCallKind(name: string): string {
  if (name.startsWith('mcp__browser__')) return 'browser'
  if (name.startsWith('mcp__audit__')) return 'evidence'
  if (name === 'Bash' || name === 'PowerShell') return 'terminal'
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') return 'file'
  if (name === 'Read' || name === 'Glob' || name === 'Grep') return 'read'
  if (name === 'WebFetch' || name === 'WebSearch') return 'web'
  if (name === 'StructuredOutput') return 'output'
  return 'other'
}
