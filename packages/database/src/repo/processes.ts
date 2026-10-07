import { and, desc, eq, ne } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { ownedProcesses } from '../schema.ts'

export type OwnedProcessRow = typeof ownedProcesses.$inferSelect

export interface OwnedProcessRecord {
  id: string
  pid: number
  processStartedAt: Date | null
  image: string | null
  tool: string
  auditId: string | null
  ownerId: string
  parentPid: number
  command: string
  cwd: string | null
  containerName: string | null
}

/** Persistence for the process-ownership registry (tool-runtime keeps the live in-memory view). */
export const processStore = {
  async insert(db: Db, record: OwnedProcessRecord): Promise<void> {
    await db
      .insert(ownedProcesses)
      .values({ ...record, command: record.command.slice(0, 2000), status: 'running' })
      .onConflictDoNothing()
  },

  async finish(
    db: Db,
    id: string,
    status: 'exited' | 'killed' | 'reaped' | 'gone',
    exitCode: number | null,
  ): Promise<void> {
    await db.update(ownedProcesses).set({ status, exitCode, endedAt: new Date() }).where(eq(ownedProcesses.id, id))
  },

  /** Records still marked running that were started by a different (earlier) owner instance. */
  async listStale(db: Db, currentOwnerId: string): Promise<OwnedProcessRow[]> {
    return db
      .select()
      .from(ownedProcesses)
      .where(and(eq(ownedProcesses.status, 'running'), ne(ownedProcesses.ownerId, currentOwnerId)))
  },

  async listRecent(db: Db, limit = 100): Promise<OwnedProcessRow[]> {
    return db.select().from(ownedProcesses).orderBy(desc(ownedProcesses.startedAt)).limit(limit)
  },

  async listRunningForAudit(db: Db, auditId: string): Promise<OwnedProcessRow[]> {
    return db
      .select()
      .from(ownedProcesses)
      .where(and(eq(ownedProcesses.status, 'running'), eq(ownedProcesses.auditId, auditId)))
  },
}
