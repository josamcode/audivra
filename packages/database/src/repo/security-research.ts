import { and, asc, desc, eq, notInArray } from 'drizzle-orm'
import type {
  ActionCostClass,
  ActionRejection,
  ActionUsefulness,
  ResearchActionKind,
  ResearchActionOrigin,
  ResearchActionState,
  ResearchBudget,
  ResearchCoverageSnapshot,
  ResearchMode,
  ResearchObjective,
  ResearchRunState,
  ResearchStage,
  ResearchTermination,
  ResearchUsage,
  ResidualUncertainty,
  SecurityResearchAction,
  SecurityResearchRun,
} from '@audivra/contracts'
import { newId } from '../ids.ts'
import { securityResearchActions, securityResearchRuns } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Phase 6E persistence. Two tables: the research run (all loop state, so a restart resumes deterministically)
 * and its actions (proposed/executed, with fingerprints for repetition prevention and producedRefs pointing
 * at the authoritative systems). The repo stores what the orchestrator computed; it never decides anything.
 */

export type ResearchRunRow = typeof securityResearchRuns.$inferSelect
export type ResearchActionRow = typeof securityResearchActions.$inferSelect

export const newResearchRunId = () => newId('rsr')
export const newResearchActionId = () => newId('rac')

export const TERMINAL_RESEARCH_STATES: readonly ResearchRunState[] = ['stopped', 'failed']

export function toResearchRun(row: ResearchRunRow): SecurityResearchRun {
  return {
    id: row.id,
    engagementId: row.engagementId,
    parentRunId: row.parentRunId ?? null,
    mode: row.mode,
    objective: row.objective,
    objectiveNote: row.objectiveNote ?? null,
    objectiveDetail: row.objectiveDetail,
    state: row.state,
    stage: row.stage,
    iteration: row.iteration,
    budget: row.budget,
    usage: row.usage,
    coverageBefore: row.coverageBefore,
    coverageAfter: row.coverageAfter ?? null,
    residual: row.residual,
    terminationReason: row.terminationReason ?? null,
    lastDecision: row.lastDecision,
    startingGraphRevision: row.startingGraphRevision ?? null,
    providerAvailable: row.providerAvailable,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toResearchAction(row: ResearchActionRow): SecurityResearchAction {
  return {
    id: row.id,
    runId: row.runId,
    engagementId: row.engagementId,
    iteration: row.iteration,
    kind: row.kind,
    origin: row.origin,
    state: row.state,
    objectiveRef: row.objectiveRef ?? null,
    capabilityId: row.capabilityId ?? null,
    inputRef: row.inputRef,
    fingerprint: row.fingerprint,
    costClass: row.costClass,
    expectedInformationGain: row.expectedInformationGain,
    rank: row.rank,
    reason: row.reason,
    rejection: row.rejection ?? null,
    usefulness: row.usefulness ?? null,
    outcome: row.outcome,
    producedRefs: row.producedRefs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface CreateResearchRunRecord {
  id: string
  engagementId: string
  parentRunId: string | null
  mode: ResearchMode
  objective: ResearchObjective
  objectiveNote: string | null
  objectiveDetail: Record<string, unknown>
  state: ResearchRunState
  stage: ResearchStage
  budget: ResearchBudget
  usage: ResearchUsage
  coverageBefore: ResearchCoverageSnapshot
  residual: ResidualUncertainty
  providerAvailable: boolean
  startingGraphRevision: number | null
}

export interface ResearchRunPatch {
  state?: ResearchRunState
  stage?: ResearchStage
  iteration?: number
  usage?: ResearchUsage
  coverageAfter?: ResearchCoverageSnapshot | null
  residual?: ResidualUncertainty
  terminationReason?: ResearchTermination | null
  lastDecision?: string
  providerAvailable?: boolean
  startedAt?: Date | null
  finishedAt?: Date | null
}

export async function insertResearchRun(db: DbOrTx, input: CreateResearchRunRecord): Promise<ResearchRunRow> {
  const [row] = await db.insert(securityResearchRuns).values(input).returning()
  if (!row) throw new Error('Failed to record research run')
  return row
}

export async function updateResearchRun(db: DbOrTx, id: string, patch: ResearchRunPatch): Promise<ResearchRunRow | undefined> {
  const [row] = await db
    .update(securityResearchRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securityResearchRuns.id, id))
    .returning()
  return row
}

export async function getResearchRunRow(db: DbOrTx, id: string): Promise<ResearchRunRow | undefined> {
  const [row] = await db.select().from(securityResearchRuns).where(eq(securityResearchRuns.id, id))
  return row
}

export async function listResearchRunRows(db: DbOrTx, engagementId: string, limit = 200): Promise<ResearchRunRow[]> {
  return db.select().from(securityResearchRuns).where(eq(securityResearchRuns.engagementId, engagementId)).orderBy(desc(securityResearchRuns.createdAt)).limit(Math.min(limit, 500))
}

export async function listResearchRunsForEngagement(db: DbOrTx, engagementId: string, limit = 200): Promise<SecurityResearchRun[]> {
  return (await listResearchRunRows(db, engagementId, limit)).map(toResearchRun)
}

/** Non-terminal runs across all engagements that are not paused — the worker reconciles these on startup. */
export async function listResumableResearchRuns(db: DbOrTx, limit = 100): Promise<SecurityResearchRun[]> {
  const rows = await db
    .select()
    .from(securityResearchRuns)
    .where(notInArray(securityResearchRuns.state, [...TERMINAL_RESEARCH_STATES, 'paused']))
    .orderBy(asc(securityResearchRuns.createdAt))
    .limit(Math.min(limit, 500))
  return rows.map(toResearchRun)
}

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────

export interface CreateResearchActionRecord {
  id: string
  runId: string
  engagementId: string
  iteration: number
  kind: ResearchActionKind
  origin: ResearchActionOrigin
  state: ResearchActionState
  objectiveRef: string | null
  capabilityId: string | null
  inputRef: Record<string, unknown>
  fingerprint: string
  costClass: ActionCostClass
  expectedInformationGain: number
  rank: number
  reason: string
}

export interface ResearchActionPatch {
  state?: ResearchActionState
  rank?: number
  rejection?: ActionRejection | null
  usefulness?: ActionUsefulness | null
  outcome?: string
  producedRefs?: string[]
}

export async function insertResearchAction(db: DbOrTx, input: CreateResearchActionRecord): Promise<ResearchActionRow> {
  const [row] = await db
    .insert(securityResearchActions)
    .values({ ...input, reason: input.reason.slice(0, 2000) })
    .returning()
  if (!row) throw new Error('Failed to record research action')
  return row
}

export async function updateResearchAction(db: DbOrTx, id: string, patch: ResearchActionPatch): Promise<ResearchActionRow | undefined> {
  const [row] = await db
    .update(securityResearchActions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securityResearchActions.id, id))
    .returning()
  return row
}

export async function listResearchActionRows(db: DbOrTx, runId: string, limit = 2000): Promise<ResearchActionRow[]> {
  return db.select().from(securityResearchActions).where(eq(securityResearchActions.runId, runId)).orderBy(asc(securityResearchActions.iteration), asc(securityResearchActions.createdAt)).limit(Math.min(limit, 5000))
}

export async function listResearchActions(db: DbOrTx, runId: string, limit = 2000): Promise<SecurityResearchAction[]> {
  return (await listResearchActionRows(db, runId, limit)).map(toResearchAction)
}

/** Completed/blocked actions for a run — used for repetition prevention and failed-action memory. */
export async function listRunActionHistory(db: DbOrTx, runId: string): Promise<SecurityResearchAction[]> {
  const rows = await db
    .select()
    .from(securityResearchActions)
    .where(and(eq(securityResearchActions.runId, runId), notInArray(securityResearchActions.state, ['proposed', 'policy-allowed', 'queued'])))
    .limit(5000)
  return rows.map(toResearchAction)
}
