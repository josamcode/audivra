import { and, asc, eq } from 'drizzle-orm'
import type { AgentRole, AgentRunItem, AgentRunStatus, ToolRunItem, ToolRunStatus } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { agentRuns, toolRuns } from '../schema.ts'

export interface StartToolRunInput {
  auditId: string
  tool: string
  purpose: string
  url?: string | null
  command?: string | null
  via?: string | null
}

export async function startToolRun(db: Db, input: StartToolRunInput): Promise<string> {
  const id = newId('tr')
  await db.insert(toolRuns).values({
    id,
    auditId: input.auditId,
    tool: input.tool,
    purpose: input.purpose,
    status: 'running',
    url: input.url ?? null,
    command: input.command ?? null,
    via: input.via ?? null,
  })
  return id
}

export interface FinishToolRunInput {
  status: Exclude<ToolRunStatus, 'running'>
  exitCode?: number | null
  durationMs?: number | null
  error?: string | null
  artifactPaths?: string[]
  result?: Record<string, unknown> | null
}

export async function finishToolRun(db: Db, id: string, input: FinishToolRunInput): Promise<void> {
  await db
    .update(toolRuns)
    .set({
      status: input.status,
      exitCode: input.exitCode ?? null,
      durationMs: input.durationMs ?? null,
      error: input.error ? input.error.slice(0, 4000) : null,
      artifactPaths: input.artifactPaths ?? [],
      result: input.result ?? null,
      finishedAt: new Date(),
    })
    .where(eq(toolRuns.id, id))
}

export async function listToolRuns(db: Db, auditId: string): Promise<ToolRunItem[]> {
  const rows = await db
    .select()
    .from(toolRuns)
    .where(eq(toolRuns.auditId, auditId))
    .orderBy(asc(toolRuns.startedAt))
  return rows.map((row) => ({
    id: row.id,
    tool: row.tool,
    purpose: row.purpose,
    status: row.status,
    url: row.url,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    error: row.error,
    artifactPaths: row.artifactPaths,
    via: row.via ?? null,
  }))
}

export interface StartAgentRunInput {
  auditId: string
  role: AgentRole
  provider: string
  model: string | null
  promptVersion: string
}

export async function startAgentRun(db: Db, input: StartAgentRunInput): Promise<string> {
  const id = newId('ar')
  await db.insert(agentRuns).values({ id, ...input, status: 'running' })
  return id
}

export async function updateAgentRun(
  db: Db,
  id: string,
  patch: Partial<{
    status: AgentRunStatus
    sessionId: string | null
    model: string | null
    numTurns: number | null
    costUsd: number | null
    durationMs: number | null
    error: string | null
    output: unknown
    validation: Record<string, unknown> | null
    usage: Record<string, unknown> | null
    terminationReason: string | null
    toolCalls: Record<string, number> | null
    finishedAt: Date | null
  }>,
): Promise<void> {
  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, id))
}

export async function getAgentRun(db: Db, id: string) {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id))
  return row
}

export async function listAgentRunRows(db: Db, auditId: string) {
  return db.select().from(agentRuns).where(eq(agentRuns.auditId, auditId)).orderBy(asc(agentRuns.startedAt))
}

/**
 * Marks agent/tool runs still flagged as running as failed. Called when a stage (re)starts: only one
 * worker runs a given audit stage at a time, so anything still "running" was interrupted (crash/restart).
 */
export async function failInterruptedRuns(db: Db, auditId: string): Promise<number> {
  const now = new Date()
  const agents = await db
    .update(agentRuns)
    .set({ status: 'failed', error: 'Interrupted (worker restarted)', finishedAt: now })
    .where(and(eq(agentRuns.auditId, auditId), eq(agentRuns.status, 'running')))
    .returning({ id: agentRuns.id })
  const tools = await db
    .update(toolRuns)
    .set({ status: 'failed', error: 'Interrupted (worker restarted)', finishedAt: now })
    .where(and(eq(toolRuns.auditId, auditId), eq(toolRuns.status, 'running')))
    .returning({ id: toolRuns.id })
  return agents.length + tools.length
}

export async function listAgentRuns(db: Db, auditId: string): Promise<AgentRunItem[]> {
  const rows = await listAgentRunRows(db, auditId)
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    numTurns: row.numTurns,
    costUsd: row.costUsd,
    durationMs: row.durationMs,
    terminationReason: row.terminationReason ?? null,
    toolCalls: row.toolCalls ?? null,
    error: row.error,
    validation: row.validation ?? null,
    output: row.output ?? null,
  }))
}
