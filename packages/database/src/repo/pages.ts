import { asc, eq, sql } from 'drizzle-orm'
import type { PageItem } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { findings, pages } from '../schema.ts'

export interface UpsertPageInput {
  url: string
  status: number | null
  title: string | null
  depth: number
  source: string
  inspectedInBrowser?: boolean
  pageType?: string | null
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
        pageType: item.pageType ?? null,
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
        pageType: sql`coalesce(excluded.page_type, ${pages.pageType})`,
      },
    })
}

/** Normalizes a URL for page matching: lower-case host, no trailing slash, no hash. */
function pageKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`
  } catch {
    return url
  }
}

export async function setPageTypes(db: Db, auditId: string, types: { url: string; pageType: string }[]): Promise<void> {
  const rows = await db.select({ id: pages.id, url: pages.url }).from(pages).where(eq(pages.auditId, auditId))
  const byKey = new Map(types.map((t) => [pageKey(t.url), t.pageType]))
  for (const row of rows) {
    const pageType = byKey.get(pageKey(row.url))
    if (pageType) await db.update(pages).set({ pageType }).where(eq(pages.id, row.id))
  }
}

export async function listPages(db: Db, auditId: string): Promise<PageItem[]> {
  const [rows, findingRows] = await Promise.all([
    db.select().from(pages).where(eq(pages.auditId, auditId)).orderBy(asc(pages.depth), asc(pages.url)),
    db.select({ affectedUrls: findings.affectedUrls }).from(findings).where(eq(findings.auditId, auditId)),
  ])
  const findingCounts = new Map<string, number>()
  for (const finding of findingRows) {
    for (const key of new Set(finding.affectedUrls.map(pageKey))) {
      findingCounts.set(key, (findingCounts.get(key) ?? 0) + 1)
    }
  }
  return rows.map((row) => ({
    url: row.url,
    status: row.status,
    title: row.title,
    depth: row.depth,
    source: row.source,
    inspectedInBrowser: row.inspectedInBrowser,
    pageType: row.pageType ?? null,
    lang: typeof row.data.lang === 'string' ? row.data.lang : null,
    dir: typeof row.data.dir === 'string' ? row.data.dir : null,
    findingCount: findingCounts.get(pageKey(row.url)) ?? 0,
  }))
}
