import { and, eq } from 'drizzle-orm'
import type { ChangeAnalysis, ChangeReportItem, ClientBriefContent, ClientBriefItem } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { changeReports, clientBriefs } from '../schema.ts'

/** Stores the change interpretation for (audit, previous audit), replacing an earlier one for the same pair. */
export async function saveChangeReport(
  db: Db,
  input: { auditId: string; previousAuditId: string; analysis: ChangeAnalysis; promptVersion: string; agentRunId: string | null },
): Promise<void> {
  await db
    .insert(changeReports)
    .values({ id: newId('cr'), ...input })
    .onConflictDoUpdate({
      target: [changeReports.auditId, changeReports.previousAuditId],
      set: { analysis: input.analysis, promptVersion: input.promptVersion, agentRunId: input.agentRunId, createdAt: new Date() },
    })
}

export async function getChangeReport(db: Db, auditId: string, previousAuditId: string): Promise<ChangeReportItem | null> {
  const [row] = await db
    .select()
    .from(changeReports)
    .where(and(eq(changeReports.auditId, auditId), eq(changeReports.previousAuditId, previousAuditId)))
  if (!row) return null
  return {
    id: row.id,
    auditId: row.auditId,
    previousAuditId: row.previousAuditId,
    analysis: row.analysis,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Stores the client brief of an audit (one per audit; regeneration replaces it). */
export async function saveClientBrief(
  db: Db,
  input: { auditId: string; content: ClientBriefContent; promptVersion: string; agentRunId: string | null },
): Promise<void> {
  await db
    .insert(clientBriefs)
    .values({ id: newId('cb'), ...input })
    .onConflictDoUpdate({
      target: clientBriefs.auditId,
      set: { content: input.content, promptVersion: input.promptVersion, agentRunId: input.agentRunId, createdAt: new Date() },
    })
}

export async function getClientBrief(db: Db, auditId: string): Promise<ClientBriefItem | null> {
  const [row] = await db.select().from(clientBriefs).where(eq(clientBriefs.auditId, auditId))
  if (!row) return null
  return { id: row.id, auditId: row.auditId, content: row.content, promptVersion: row.promptVersion, createdAt: row.createdAt.toISOString() }
}
