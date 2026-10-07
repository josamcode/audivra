import { AuditContext, CancelledError, RequiredCapabilityError, Workspace } from '@audivra/audit-core'
import { AiStageError } from '@audivra/ai-runtime'
import type { Logger } from '@audivra/config'
import type { AuditError, AuditStage, FailureKind } from '@audivra/contracts'
import {
  failInterruptedRuns,
  getAuditRow,
  getStep,
  recordEvent,
  updateAudit,
  updateStep,
  type AuditRow,
  type Db,
} from '@audivra/database'

export type StageOutcome =
  | { kind: 'next'; message?: string }
  /** Stage could not do its job but the audit continues (e.g. reviewer failed). */
  | { kind: 'degraded'; message: string; error: AuditError }
  | { kind: 'done' }

export interface StageDefinition {
  stage: Exclude<AuditStage, 'done'>
  label: string
  run(ctx: AuditContext, audit: AuditRow): Promise<StageOutcome>
}

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled'])

export function classifyError(error: unknown, stage: AuditStage): AuditError {
  const message = error instanceof Error ? error.message : String(error)
  let kind: FailureKind = 'internal'
  if (error instanceof CancelledError) kind = 'cancelled'
  else if (error instanceof AiStageError) kind = error.cancelled ? 'cancelled' : 'ai'
  else if (error instanceof RequiredCapabilityError) kind = 'required-capability'
  else if (/browser|chromium|playwright/i.test(message)) kind = 'browser'
  return { kind, message: message.slice(0, 1000), stage }
}

/**
 * Executes one durable pipeline stage for an audit: guards against terminal/cancelled audits,
 * tracks step status, watches for cancellation and converts failures into honest audit state.
 * Returns the outcome so the caller can enqueue the next stage.
 */
export async function executeStage(
  db: Db,
  log: Logger,
  auditId: string,
  definition: StageDefinition,
): Promise<StageOutcome | null> {
  const audit = await getAuditRow(db, auditId)
  if (!audit) {
    log.warn({ auditId }, 'stage job for unknown audit; ignoring')
    return null
  }
  if (TERMINAL.has(audit.status)) {
    log.info(
      { auditId, stage: definition.stage, status: audit.status },
      'audit already finished; skipping stage',
    )
    return null
  }
  const step = await getStep(db, auditId, definition.stage)
  if (step?.status === 'completed' || step?.status === 'skipped') {
    log.info({ auditId, stage: definition.stage }, 'stage already done; continuing pipeline')
    return { kind: 'next' }
  }
  if (audit.cancelRequested) {
    await markCancelled(db, auditId, definition.stage)
    return null
  }

  const controller = new AbortController()
  const watcher = setInterval(() => {
    void getAuditRow(db, auditId)
      .then((row) => {
        if (row?.cancelRequested && !controller.signal.aborted) controller.abort()
      })
      .catch(() => undefined)
  }, 3000)

  const ws = new Workspace(auditId)
  await ws.init()
  const stageLog = log.child({ auditId, stage: definition.stage })
  const ctx = new AuditContext(auditId, db, stageLog, ws, controller.signal)

  await updateAudit(db, auditId, {
    status: 'running',
    stage: definition.stage,
    ...(audit.startedAt ? {} : { startedAt: new Date() }),
  })
  const interrupted = await failInterruptedRuns(db, auditId)
  if (interrupted) {
    await ctx.event(
      'stage.started',
      `Resuming after an interruption (${interrupted} unfinished run(s) closed)`,
      { stage: definition.stage },
      'warn',
    )
  }
  await updateStep(db, auditId, definition.stage, 'running')
  if (!audit.startedAt) await ctx.event('audit.started', `Audit started for ${audit.normalizedUrl}`)
  await ctx.event('stage.started', `${definition.label} started`, { stage: definition.stage })
  stageLog.info('stage started')

  try {
    const outcome = await definition.run(ctx, audit)
    if (outcome.kind === 'degraded') {
      await updateStep(db, auditId, definition.stage, 'failed', {
        message: outcome.message,
        error: outcome.error,
      })
      await ctx.event(
        'stage.failed',
        `${definition.label}: ${outcome.message}`,
        { stage: definition.stage, kind: outcome.error.kind },
        'error',
      )
    } else {
      await updateStep(db, auditId, definition.stage, 'completed', {
        message: outcome.kind === 'next' ? (outcome.message ?? null) : null,
      })
      await ctx.event('stage.completed', `${definition.label} completed`, { stage: definition.stage })
    }
    stageLog.info({ outcome: outcome.kind }, 'stage finished')
    return outcome
  } catch (error) {
    const auditError = classifyError(error, definition.stage)
    if (auditError.kind === 'cancelled' || controller.signal.aborted) {
      await markCancelled(db, auditId, definition.stage)
      return null
    }
    stageLog.error({ err: error }, 'stage failed')
    await updateStep(db, auditId, definition.stage, 'failed', {
      message: auditError.message,
      error: auditError,
    })
    await ctx.event(
      'stage.failed',
      `${definition.label} failed: ${auditError.message}`,
      { stage: definition.stage, kind: auditError.kind },
      'error',
    )
    // Baseline failures are fatal; failures after the baseline keep everything collected (partial).
    const fatal = definition.stage === 'preparing' || definition.stage === 'baseline'
    await updateAudit(db, auditId, {
      status: fatal ? 'failed' : 'partial',
      error: auditError,
      finishedAt: new Date(),
    })
    await recordEvent(db, {
      auditId,
      type: 'audit.failed',
      level: 'error',
      message: fatal
        ? `Audit failed during ${definition.label.toLowerCase()}`
        : `Audit finished partially: ${definition.label.toLowerCase()} failed; collected evidence is preserved`,
      data: { stage: definition.stage, kind: auditError.kind },
    })
    return null
  } finally {
    clearInterval(watcher)
  }
}

export async function markCancelled(db: Db, auditId: string, stage: AuditStage): Promise<void> {
  await updateStep(db, auditId, stage, 'failed', {
    message: 'Cancelled',
    error: { kind: 'cancelled', message: 'Cancelled by user', stage },
  })
  await updateAudit(db, auditId, {
    status: 'cancelled',
    finishedAt: new Date(),
    error: { kind: 'cancelled', message: 'Cancelled by user', stage },
  })
  await recordEvent(db, {
    auditId,
    type: 'audit.cancelled',
    level: 'warn',
    message: 'Audit cancelled',
    data: { stage },
  })
}
