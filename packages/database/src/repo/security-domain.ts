import { and, asc, eq } from 'drizzle-orm'
import { domainSourceMapping, redactSensitive, type DomainDeclarationKind, type DomainSource, type SecurityActor, type SecurityDomainDeclaration } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { securityDomainDeclarations } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Persistence for Phase 5 domain declarations (the source of truth the domain projector reads). The spec is
 * redacted at this boundary like every other security record, so a secret that accidentally reaches a
 * declaration is scrubbed before it is stored. One row per (engagement, kind, ref); Step 1 declarations are
 * immutable (create + list) — lifecycle (edit/retire) arrives with the identity lifecycle in a later step.
 */

export type DomainDeclarationRow = typeof securityDomainDeclarations.$inferSelect

export const newDomainDeclarationId = () => newId('dom')

export interface CreateDomainDeclarationRecord {
  id: string
  engagementId: string
  kind: DomainDeclarationKind
  ref: string
  key: string
  label: string
  source: DomainSource
  confidence: number
  spec: Record<string, unknown>
  createdBy: SecurityActor
  version?: number
}

export function toDomainDeclaration(row: DomainDeclarationRow): SecurityDomainDeclaration {
  return {
    id: row.id,
    engagementId: row.engagementId,
    kind: row.kind,
    ref: row.ref,
    key: row.key,
    label: row.label,
    source: row.source,
    basis: domainSourceMapping(row.source).basis,
    confidence: row.confidence,
    status: row.status,
    version: row.version,
    supersededBy: row.supersededBy ?? null,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    spec: row.spec,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface DomainDeclarationPatch {
  status?: SecurityDomainDeclaration['status']
  supersededBy?: string | null
  retiredAt?: Date | null
  label?: string
  spec?: Record<string, unknown>
  source?: DomainSource
  confidence?: number
}

export async function patchDomainDeclaration(db: Db, id: string, patch: DomainDeclarationPatch): Promise<DomainDeclarationRow | undefined> {
  const spec = patch.spec ? redactSensitive({ spec: patch.spec }).value.spec : undefined
  const [row] = await db
    .update(securityDomainDeclarations)
    .set({ ...patch, ...(spec ? { spec } : {}), updatedAt: new Date() })
    .where(eq(securityDomainDeclarations.id, id))
    .returning()
  return row
}

export async function createDomainDeclaration(db: Db, input: CreateDomainDeclarationRecord): Promise<DomainDeclarationRow> {
  const spec = redactSensitive({ spec: input.spec }).value.spec
  const [row] = await db
    .insert(securityDomainDeclarations)
    .values({ ...input, label: input.label.slice(0, 200), spec })
    .returning()
  if (!row) throw new Error('Failed to record domain declaration')
  return row
}

export async function findDomainDeclarationByRef(db: Db, engagementId: string, kind: DomainDeclarationKind, ref: string): Promise<DomainDeclarationRow | undefined> {
  // The active version of a handle (resolution and uniqueness always use the current version, never history).
  const [row] = await db
    .select()
    .from(securityDomainDeclarations)
    .where(and(eq(securityDomainDeclarations.engagementId, engagementId), eq(securityDomainDeclarations.kind, kind), eq(securityDomainDeclarations.ref, ref), eq(securityDomainDeclarations.status, 'active')))
  return row
}

export async function getDomainDeclarationRow(db: Db, id: string): Promise<DomainDeclarationRow | undefined> {
  const [row] = await db.select().from(securityDomainDeclarations).where(eq(securityDomainDeclarations.id, id))
  return row
}

export async function listDomainDeclarationRows(db: Db, engagementId: string, options: { kind?: DomainDeclarationKind; status?: SecurityDomainDeclaration['status'] | 'all'; limit?: number } = {}): Promise<DomainDeclarationRow[]> {
  const status = options.status ?? 'active'
  return db
    .select()
    .from(securityDomainDeclarations)
    .where(and(eq(securityDomainDeclarations.engagementId, engagementId), options.kind ? eq(securityDomainDeclarations.kind, options.kind) : undefined, status === 'all' ? undefined : eq(securityDomainDeclarations.status, status)))
    .orderBy(asc(securityDomainDeclarations.kind), asc(securityDomainDeclarations.ref), asc(securityDomainDeclarations.version))
    .limit(Math.min(options.limit ?? 1000, 2000))
}

/** What the domain projector reads (inside the graph lock, so one projection sees a consistent set). */
export interface DomainDeclarationForGraph {
  id: string
  kind: DomainDeclarationKind
  ref: string
  key: string
  label: string
  source: DomainSource
  confidence: number
  spec: Record<string, unknown>
  firstAt: string
  lastAt: string
}

export async function listDomainDeclarationsForGraph(db: DbOrTx, engagementId: string, limit = 5000): Promise<DomainDeclarationForGraph[]> {
  const rows = await db
    .select()
    .from(securityDomainDeclarations)
    .where(and(eq(securityDomainDeclarations.engagementId, engagementId), eq(securityDomainDeclarations.status, 'active')))
    .orderBy(asc(securityDomainDeclarations.kind), asc(securityDomainDeclarations.ref))
    .limit(limit)
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    ref: row.ref,
    key: row.key,
    label: row.label,
    source: row.source,
    confidence: row.confidence,
    spec: row.spec,
    firstAt: row.createdAt.toISOString(),
    lastAt: row.updatedAt.toISOString(),
  }))
}
