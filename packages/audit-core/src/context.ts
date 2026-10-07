import type { Logger } from '@audivra/config'
import type { EventType, EvidenceItem } from '@audivra/contracts'
import {
  createEvidence,
  finishToolRun,
  recordEvent,
  startToolRun,
  type CreateEvidenceInput,
  type Db,
} from '@audivra/database'
import type { Workspace } from './workspace.ts'

export class CancelledError extends Error {
  constructor() {
    super('Audit was cancelled')
    this.name = 'CancelledError'
  }
}

export interface ToolRunOutcome<T> {
  result: T
  artifacts?: string[]
  /** Small structured summary persisted with the tool run. */
  summary?: Record<string, unknown>
  /** Command line for display/debugging. */
  command?: string
}

/** Everything a pipeline stage needs: persistence, events, evidence, workspace and cancellation. */
export class AuditContext {
  constructor(
    readonly auditId: string,
    readonly db: Db,
    readonly log: Logger,
    readonly ws: Workspace,
    readonly signal: AbortSignal,
  ) {}

  throwIfCancelled(): void {
    if (this.signal.aborted) throw new CancelledError()
  }

  async event(
    type: EventType,
    message: string,
    data?: Record<string, unknown> | null,
    level: 'info' | 'warn' | 'error' = 'info',
  ): Promise<void> {
    try {
      await recordEvent(this.db, { auditId: this.auditId, type, message, data, level })
    } catch (error) {
      this.log.warn({ err: error, type }, 'failed to record event')
    }
  }

  async evidence(input: Omit<CreateEvidenceInput, 'auditId'>): Promise<EvidenceItem> {
    const item = await createEvidence(this.db, { ...input, auditId: this.auditId })
    await this.event('evidence.created', `${item.ref} · ${item.title}`, { ref: item.ref, type: item.type })
    return item
  }

  /**
   * Runs a tool step with a persisted tool_run record and lifecycle events.
   * Returns null (and records a failed run) instead of throwing, so optional tools never break the audit.
   */
  async toolRun<T>(
    tool: string,
    purpose: string,
    url: string | null,
    fn: (toolRunId: string) => Promise<ToolRunOutcome<T>>,
  ): Promise<{ toolRunId: string; result: T } | null> {
    this.throwIfCancelled()
    const started = Date.now()
    const toolRunId = await startToolRun(this.db, { auditId: this.auditId, tool, purpose, url })
    await this.event('tool.started', `${tool}: ${purpose}`, { tool, toolRunId, url })
    try {
      const outcome = await fn(toolRunId)
      await finishToolRun(this.db, toolRunId, {
        status: 'completed',
        durationMs: Date.now() - started,
        artifactPaths: outcome.artifacts ?? [],
        result: outcome.summary ?? null,
      })
      await this.event('tool.completed', `${tool} completed: ${purpose}`, {
        tool,
        toolRunId,
        url,
        durationMs: Date.now() - started,
      })
      return { toolRunId, result: outcome.result }
    } catch (error) {
      if (error instanceof CancelledError || this.signal.aborted) {
        await finishToolRun(this.db, toolRunId, {
          status: 'failed',
          error: 'Cancelled',
          durationMs: Date.now() - started,
        })
        throw error instanceof CancelledError ? error : new CancelledError()
      }
      const message = error instanceof Error ? error.message : String(error)
      this.log.warn({ err: error, tool, url }, 'tool run failed')
      await finishToolRun(this.db, toolRunId, {
        status: 'failed',
        error: message,
        durationMs: Date.now() - started,
      })
      await this.event(
        'tool.failed',
        `${tool} failed: ${message.slice(0, 300)}`,
        { tool, toolRunId, url },
        'warn',
      )
      return null
    }
  }

  async skippedTool(tool: string, purpose: string, reason: string): Promise<void> {
    const toolRunId = await startToolRun(this.db, { auditId: this.auditId, tool, purpose })
    await finishToolRun(this.db, toolRunId, { status: 'skipped', error: reason })
    await this.event('tool.skipped', `${tool} skipped: ${reason}`, { tool, toolRunId }, 'warn')
  }
}
