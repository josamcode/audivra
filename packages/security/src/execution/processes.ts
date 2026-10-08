import { runProcess, type RunProcessResult } from '@audivra/tool-runtime'
import type { CapabilityProcessOptions, CapabilityProcesses } from '../capabilities/types.ts'
import { ExecutionError } from './failures.ts'
import type { ExecutionWorkspace } from './workspace.ts'

/**
 * The only way a capability starts a process. Every process is registered in the ownership registry
 * under the execution id (PID + creation time), runs inside the execution workspace, receives the
 * execution's stop signal, and counts against the execution's process limit. Cancellation, timeout and
 * cleanup terminate exactly these processes — never anything matched by name or pattern.
 */
export class ExecutionProcesses implements CapabilityProcesses {
  #started = 0

  constructor(
    private readonly options: {
      executionId: string
      /** Recorded as the owning tool (the capability id). */
      tool: string
      workspace: ExecutionWorkspace
      maxProcesses: number
      signal: AbortSignal
    },
  ) {}

  get started(): number {
    return this.#started
  }

  async run(options: CapabilityProcessOptions): Promise<RunProcessResult> {
    const { executionId, tool, workspace, maxProcesses, signal } = this.options
    if (signal.aborted) throw new ExecutionError('executor-failed', 'runtime.stopping', 'The execution is stopping; no new process may start')
    if (this.#started >= maxProcesses) {
      throw new ExecutionError(
        'process-limit',
        'runtime.process-limit',
        maxProcesses === 0 ? `${tool} does not declare that it starts processes` : `${tool} may start at most ${maxProcesses} process${maxProcesses === 1 ? '' : 'es'}`,
      )
    }
    this.#started++
    return runProcess({
      command: options.command,
      args: options.args ?? [],
      cwd: workspace.area(options.cwd ?? 'tmp'),
      timeoutMs: options.timeoutMs,
      input: options.input,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      stdoutFile: options.stdoutFile ? workspace.resolve('outputs', options.stdoutFile) : undefined,
      stderrFile: options.stderrFile ? workspace.resolve('outputs', options.stderrFile) : undefined,
      signal,
      owner: { tool, securityExecutionId: executionId },
    })
  }
}
