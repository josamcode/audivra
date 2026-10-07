import { and, eq, sql } from 'drizzle-orm'
import {
  AUDIT_STAGES,
  type AuditError,
  type AuditStage,
  type AuditStep,
  type StepStatus,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { auditSteps } from '../schema.ts'

/** Stages that have a step row (everything except the terminal "done"). */
export const STEP_STAGES = AUDIT_STAGES.filter((s): s is Exclude<AuditStage, 'done'> => s !== 'done')

export async function initSteps(db: Db, auditId: string): Promise<void> {
  await db
    .insert(auditSteps)
    .values(STEP_STAGES.map((stage) => ({ auditId, stage, status: 'pending' as const })))
    .onConflictDoNothing()
}

export async function getStep(db: Db, auditId: string, stage: AuditStage) {
  const [row] = await db
    .select()
    .from(auditSteps)
    .where(and(eq(auditSteps.auditId, auditId), eq(auditSteps.stage, stage)))
  return row
}

export async function updateStep(
  db: Db,
  auditId: string,
  stage: AuditStage,
  status: StepStatus,
  extra: { message?: string | null; error?: AuditError | null } = {},
): Promise<void> {
  const now = new Date()
  // Audits created before a stage existed have no row for it yet.
  await initSteps(db, auditId)
  await db
    .update(auditSteps)
    .set({
      status,
      ...(status === 'running'
        ? { startedAt: now, finishedAt: null, attempts: sql`${auditSteps.attempts} + 1`, error: null }
        : {}),
      ...(status === 'completed' || status === 'failed' || status === 'skipped' ? { finishedAt: now } : {}),
      ...(extra.message !== undefined ? { message: extra.message } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
    })
    .where(and(eq(auditSteps.auditId, auditId), eq(auditSteps.stage, stage)))
}

export async function listSteps(db: Db, auditId: string): Promise<AuditStep[]> {
  const rows = await db.select().from(auditSteps).where(eq(auditSteps.auditId, auditId))
  const order = new Map<string, number>(STEP_STAGES.map((s, i) => [s, i]))
  return rows
    .sort((a, b) => (order.get(a.stage) ?? 0) - (order.get(b.stage) ?? 0))
    .map((row) => ({
      stage: row.stage,
      status: row.status,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      message: row.message,
      error: row.error ?? null,
    }))
}
