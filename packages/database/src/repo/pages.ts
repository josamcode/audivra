import { asc, eq, sql } from 'drizzle-orm'
import type { PageItem } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { pages } from '../schema.ts'

export interface UpsertPageInput {
  url: string
  status: number | null
  title: string | null
  depth: number
  source: string
  inspectedInBrowser?: boolean
  data?: Record<string, unknown>
}

export async function upsertPages(db: Db, auditId: string, items: UpsertPageInput[]): Promise<void> {
  if (items.length === 0) return
  await db
    .insert(pages)
    .values(
      items.map((item) => ({
        id: newId('pg'),
        auditId,
        url: item.url,
        status: item.status,
        title: item.title,
        depth: item.depth,
        source: item.source,
        inspectedInBrowser: item.inspectedInBrowser ?? false,
        data: item.data ?? {},
      })),
    )
    .onConflictDoUpdate({
      target: [pages.auditId, pages.url],
      set: {
        status: sql`coalesce(excluded.status, ${pages.status})`,
        title: sql`coalesce(excluded.title, ${pages.title})`,
        data: sql`${pages.data} || excluded.data`,
        inspectedInBrowser: sql`${pages.inspectedInBrowser} or excluded.inspected_in_browser`,
      },
    })
}

export async function listPages(db: Db, auditId: string): Promise<PageItem[]> {
  const rows = await db
    .select()
    .from(pages)
    .where(eq(pages.auditId, auditId))
    .orderBy(asc(pages.depth), asc(pages.url))
  return rows.map((row) => ({
    url: row.url,
    status: row.status,
    title: row.title,
    depth: row.depth,
    source: row.source,
    inspectedInBrowser: row.inspectedInBrowser,
  }))
}
