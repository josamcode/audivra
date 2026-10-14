import { asc, desc, eq, notInArray } from 'drizzle-orm'
import type {
  SpecialistCompletion,
  SpecialistEngineId,
  SpecialistImport,
  SpecialistMode,
  SpecialistRun,
  SpecialistRunState,
  SpecialistTarget,
} from '@audivra/contracts'
import { newId } from '../ids.ts'
import { securitySpecialistRuns } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Phase 6D persistence for durable specialist runs. One row per run: reference-only (engine, pinned version,
 * Audivra-constructed mode/targets, owning execution id, provider PROFILE id + model — never a secret), the
 * lifecycle state, bounded artifact refs, and the imports that record how each native result mapped into
 * Audivra. The repo never decides anything; it stores what the specialist service computed.
 */

export type SpecialistRunRow = typeof securitySpecialistRuns.$inferSelect

export const newSpecialistRunId = () => newId('spr')

/** Terminal states — a run here is finished and must not be re-run or re-ingested blindly (idempotent recovery). */
export const TERMINAL_SPECIALIST_STATES: readonly SpecialistRunState[] = ['completed', 'partial', 'budget-stopped', 'cancelled', 'failed', 'unavailable']

export function toSpecialistRun(row: SpecialistRunRow): SpecialistRun {
  return {
    id: row.id,
    engagementId: row.engagementId,
    engine: row.engine,
    engineVersion: row.engineVersion ?? null,
    adapterVersion: row.adapterVersion,
    mode: row.mode,
    executionId: row.executionId ?? null,
    targets: row.targets,
    providerProfileId: row.providerProfileId ?? null,
    providerModel: row.providerModel ?? null,
    state: row.state,
    completion: row.completion ?? null,
    stateReason: row.stateReason,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    terminationReason: row.terminationReason ?? null,
    artifactRefs: row.artifactRefs,
    costUsd: row.costUsd ?? null,
    turns: row.turns ?? null,
    imported: row.imported,
    imports: row.imports,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface CreateSpecialistRunRecord {
  id: string
  engagementId: string
  engine: SpecialistEngineId
  adapterVersion: string
  mode: SpecialistMode
  executionId: string | null
  targets: SpecialistTarget[]
  providerProfileId: string | null
  providerModel: string | null
  state: SpecialistRunState
  stateReason: string
}

export interface SpecialistRunPatch {
  executionId?: string | null
  state?: SpecialistRunState
  completion?: SpecialistCompletion | null
  stateReason?: string
  engineVersion?: string | null
  startedAt?: Date | null
  finishedAt?: Date | null
  terminationReason?: string | null
  artifactRefs?: string[]
  costUsd?: number | null
  turns?: number | null
  imported?: { vulnerabilities: number; observations: number; merged: number; gaps: number; outOfScope: number }
  imports?: SpecialistImport[]
}

export async function insertSpecialistRun(db: DbOrTx, input: CreateSpecialistRunRecord): Promise<SpecialistRunRow> {
  const [row] = await db.insert(securitySpecialistRuns).values(input).returning()
  if (!row) throw new Error('Failed to record specialist run')
  return row
}

export async function updateSpecialistRun(db: DbOrTx, id: string, patch: SpecialistRunPatch): Promise<SpecialistRunRow | undefined> {
  const [row] = await db
    .update(securitySpecialistRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securitySpecialistRuns.id, id))
    .returning()
  return row
}

export async function getSpecialistRunRow(db: DbOrTx, id: string): Promise<SpecialistRunRow | undefined> {
  const [row] = await db.select().from(securitySpecialistRuns).where(eq(securitySpecialistRuns.id, id))
  return row
}

export async function findSpecialistRunByExecution(db: DbOrTx, executionId: string): Promise<SpecialistRunRow | undefined> {
  const [row] = await db.select().from(securitySpecialistRuns).where(eq(securitySpecialistRuns.executionId, executionId))
  return row
}

export async function listSpecialistRunRows(db: DbOrTx, engagementId: string, limit = 500): Promise<SpecialistRunRow[]> {
  return db
    .select()
    .from(securitySpecialistRuns)
    .where(eq(securitySpecialistRuns.engagementId, engagementId))
    .orderBy(desc(securitySpecialistRuns.createdAt))
    .limit(Math.min(limit, 2000))
}

export async function listSpecialistRunsForEngagement(db: DbOrTx, engagementId: string, limit = 500): Promise<SpecialistRun[]> {
  return (await listSpecialistRunRows(db, engagementId, limit)).map(toSpecialistRun)
}

/** Non-terminal runs across all engagements — the specialist worker reconciles these on startup. */
export async function listNonTerminalSpecialistRuns(db: DbOrTx, limit = 200): Promise<SpecialistRun[]> {
  const rows = await db
    .select()
    .from(securitySpecialistRuns)
    .where(notInArray(securitySpecialistRuns.state, [...TERMINAL_SPECIALIST_STATES]))
    .orderBy(asc(securitySpecialistRuns.createdAt))
    .limit(Math.min(limit, 1000))
  return rows.map(toSpecialistRun)
}
