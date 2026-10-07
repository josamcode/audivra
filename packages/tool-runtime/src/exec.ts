import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import { registerOwned } from './processes.ts'

export interface RunProcessOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  /** Hard timeout; the process tree is killed when exceeded. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Optional stdin content. */
  input?: string
  /** When set, stdout/stderr are also streamed to these files (useful for large outputs). */
  stdoutFile?: string
  stderrFile?: string
  /** Called for each stdout line as it arrives. */
  onStdoutLine?: (line: string) => void
  /** Max bytes of stdout/stderr kept in memory. */
  maxBuffer?: number
  /** Set false for long-running streaming processes; output is then only delivered via callbacks/files. */
  buffer?: boolean
  /**
   * Ownership metadata. Processes with an owner are persisted in the ownership registry; others
   * (short probes) are tracked in memory only. Either way only this process tree can be terminated.
   */
  owner?: { tool: string; auditId?: string | null; containerName?: string | null }
}

export interface RunProcessResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  cancelled: boolean
  failed: boolean
  errorMessage: string | null
}

/**
 * Runs an external process without blocking the event loop, with timeout, cancellation,
 * output capture and optional streaming. Never throws for non-zero exits: callers inspect `failed`.
 */
export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const started = Date.now()
  const args = options.args ?? []
  const display = [options.command, ...args].join(' ')

  for (const file of [options.stdoutFile, options.stderrFile]) {
    if (file) await mkdir(path.dirname(file), { recursive: true })
  }

  const subprocess = execa(options.command, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: true,
    input: options.input,
    stdin: options.input === undefined ? 'ignore' : undefined,
    reject: false,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    buffer: options.buffer ?? true,
    windowsHide: true,
    stripFinalNewline: true,
    lines: false,
  })

  if (options.stdoutFile) subprocess.stdout?.pipe(createWriteStream(options.stdoutFile))
  if (options.stderrFile) subprocess.stderr?.pipe(createWriteStream(options.stderrFile))
  if (options.onStdoutLine && subprocess.stdout) {
    let pending = ''
    subprocess.stdout.setEncoding('utf8')
    subprocess.stdout.on('data', (chunk: string) => {
      pending += chunk
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '')
        pending = pending.slice(index + 1)
        if (line) options.onStdoutLine?.(line)
        index = pending.indexOf('\n')
      }
    })
    subprocess.stdout.on('end', () => {
      if (pending.trim()) options.onStdoutLine?.(pending.trim())
    })
  }

  const handle = registerOwned(subprocess.pid, {
    tool: options.owner?.tool ?? path.basename(options.command),
    auditId: options.owner?.auditId ?? null,
    containerName: options.owner?.containerName ?? null,
    cwd: options.cwd ?? process.cwd(),
    command: display,
    persist: Boolean(options.owner),
  })
  // Timeouts and cancellation terminate this process's tree only (execa alone would leave
  // grandchildren running on Windows).
  let timedOut = false
  let cancelled = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        void handle?.kill()
      }, options.timeoutMs)
    : null
  const onAbort = () => {
    cancelled = true
    void handle?.kill()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  const result = await subprocess
  if (timer) clearTimeout(timer)
  options.signal?.removeEventListener('abort', onAbort)
  handle?.finish(result.exitCode ?? null)
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return {
    command: display,
    exitCode: result.exitCode ?? null,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    timedOut,
    cancelled,
    failed: Boolean(result.failed) || timedOut || cancelled,
    errorMessage: timedOut
      ? `Timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`
      : cancelled
        ? 'Cancelled'
        : result.failed
          ? (result.shortMessage ?? result.message ?? 'Process failed')
          : null,
  }
}

/** Resolves a command's version string, or null when the command is unavailable. */
export async function probeVersion(
  command: string,
  args: string[] = ['--version'],
  timeoutMs = 15000,
): Promise<string | null> {
  try {
    const result = await runProcess({ command, args, timeoutMs })
    if (result.failed && !result.stdout) return null
    const text = (result.stdout || result.stderr).trim()
    const match = text.match(/\d+\.\d+(?:\.\d+)?(?:[-.][\w.]+)?/)
    return match ? match[0] : text.split('\n')[0]?.slice(0, 60) || null
  } catch {
    return null
  }
}
