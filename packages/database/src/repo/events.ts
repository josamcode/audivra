import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { ActivityEvent, EventType } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { auditEvents } from '../schema.ts'

export const EVENTS_CHANNEL = 'audivra_events'

export interface RecordEventInput {
  auditId: string
  type: EventType
  message: string
  level?: 'info' | 'warn' | 'error'
  data?: Record<string, unknown> | null
  agentRunId?: string | null
}

type EventRow = typeof auditEvents.$inferSelect

export function toActivityEvent(row: EventRow): ActivityEvent {
  return {
    id: row.id,
    auditId: row.auditId,
    type: row.type,
    level: row.level,
    message: row.message,
    data: row.data ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Persists an activity event and notifies live listeners (the API server relays it over SSE). */
export async function recordEvent(db: Db, input: RecordEventInput): Promise<ActivityEvent> {
  const [row] = await db
    .insert(auditEvents)
    .values({
      auditId: input.auditId,
      type: input.type,
      message: input.message.slice(0, 2000),
      level: input.level ?? 'info',
      data: input.data ?? null,
      agentRunId: input.agentRunId ?? null,
    })
    .returning()
  if (!row) throw new Error('Failed to record event')
  await db.execute(
    sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({ auditId: row.auditId, id: row.id })})`,
  )
  return toActivityEvent(row)
}

export async function listEvents(
  db: Db,
  auditId: string,
  options: { afterId?: number; limit?: number } = {},
): Promise<ActivityEvent[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.auditId, auditId),
        options.afterId !== undefined ? gt(auditEvents.id, options.afterId) : undefined,
      ),
    )
    .orderBy(asc(auditEvents.id))
    .limit(options.limit ?? 5000)
  return rows.map(toActivityEvent)
}
