import { and, asc, desc, eq } from 'drizzle-orm'
import type { CredentialMetadata, CredentialStatus, CredentialType, SecurityEnvironment, SessionMetadata, SessionStatus } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { securityCredentials, securitySessions } from '../schema.ts'

/*
 * Persistence for the credential/session secret boundary. Rows carry only an opaque AES-256-GCM envelope
 * (`sealed`) plus safe metadata. The full row (with `sealed`) is returned only to the trusted vault, which
 * opens it; everything the API/events/UI see goes through `toCredentialMetadata` / `toSessionMetadata`,
 * which never include `sealed` or `keyId` material beyond a non-secret fingerprint.
 */

export type CredentialRow = typeof securityCredentials.$inferSelect
export type SessionRow = typeof securitySessions.$inferSelect

export const newCredentialId = () => newId('cred')
export const newSessionId = () => newId('sess')

// ── Credentials ──────────────────────────────────────────────────────────────────────────────────────

export interface CreateCredentialRecord {
  id: string
  engagementId: string
  identityRef: string | null
  ref: string
  type: CredentialType
  label: string
  sealed: string
  keyId: string
  expiresAt: Date | null
}

export function toCredentialMetadata(row: CredentialRow): CredentialMetadata {
  return {
    id: row.id,
    engagementId: row.engagementId,
    identityRef: row.identityRef,
    ref: row.ref,
    type: row.type,
    label: row.label,
    status: row.status,
    configured: true,
    keyId: row.keyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  }
}

export async function createCredentialRow(db: Db, input: CreateCredentialRecord): Promise<CredentialRow> {
  const [row] = await db.insert(securityCredentials).values({ ...input, label: input.label.slice(0, 200) }).returning()
  if (!row) throw new Error('Failed to store credential')
  return row
}

export async function getCredentialRow(db: Db, id: string): Promise<CredentialRow | undefined> {
  const [row] = await db.select().from(securityCredentials).where(eq(securityCredentials.id, id))
  return row
}

export async function getCredentialRowByRef(db: Db, engagementId: string, ref: string): Promise<CredentialRow | undefined> {
  const [row] = await db.select().from(securityCredentials).where(and(eq(securityCredentials.engagementId, engagementId), eq(securityCredentials.ref, ref)))
  return row
}

export async function listCredentialRows(db: Db, engagementId: string, options: { identityRef?: string } = {}): Promise<CredentialRow[]> {
  return db
    .select()
    .from(securityCredentials)
    .where(and(eq(securityCredentials.engagementId, engagementId), options.identityRef ? eq(securityCredentials.identityRef, options.identityRef) : undefined))
    .orderBy(asc(securityCredentials.ref))
}

export interface CredentialPatch {
  sealed?: string
  keyId?: string
  label?: string
  status?: CredentialStatus
  expiresAt?: Date | null
  revokedAt?: Date | null
}

export async function updateCredentialRow(db: Db, id: string, patch: CredentialPatch): Promise<CredentialRow | undefined> {
  const [row] = await db
    .update(securityCredentials)
    .set({ ...patch, ...(patch.label ? { label: patch.label.slice(0, 200) } : {}), updatedAt: new Date() })
    .where(eq(securityCredentials.id, id))
    .returning()
  return row
}

export async function deleteCredentialRow(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(securityCredentials).where(eq(securityCredentials.id, id)).returning({ id: securityCredentials.id })
  return rows.length > 0
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────────

export interface CreateSessionRecord {
  id: string
  engagementId: string
  identityRef: string
  environment: SecurityEnvironment
  authMethod: string
  status: SessionStatus
  sealed: string | null
  keyId: string | null
  expiresAt: Date | null
}

export function toSessionMetadata(row: SessionRow): SessionMetadata {
  return {
    id: row.id,
    engagementId: row.engagementId,
    identityRef: row.identityRef,
    environment: row.environment,
    authMethod: row.authMethod,
    status: row.status,
    material: row.sealed !== null,
    keyId: row.keyId,
    createdAt: row.createdAt.toISOString(),
    refreshedAt: row.refreshedAt ? row.refreshedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  }
}

export async function createSessionRow(db: Db, input: CreateSessionRecord): Promise<SessionRow> {
  const [row] = await db.insert(securitySessions).values(input).returning()
  if (!row) throw new Error('Failed to create session')
  return row
}

export async function getSessionRow(db: Db, id: string): Promise<SessionRow | undefined> {
  const [row] = await db.select().from(securitySessions).where(eq(securitySessions.id, id))
  return row
}

export async function listSessionRows(db: Db, engagementId: string, options: { identityRef?: string } = {}): Promise<SessionRow[]> {
  return db
    .select()
    .from(securitySessions)
    .where(and(eq(securitySessions.engagementId, engagementId), options.identityRef ? eq(securitySessions.identityRef, options.identityRef) : undefined))
    .orderBy(desc(securitySessions.createdAt))
}

export interface SessionPatch {
  status?: SessionStatus
  sealed?: string | null
  keyId?: string | null
  refreshedAt?: Date | null
  expiresAt?: Date | null
  revokedAt?: Date | null
}

export async function updateSessionRow(db: Db, id: string, patch: SessionPatch): Promise<SessionRow | undefined> {
  const [row] = await db.update(securitySessions).set({ ...patch, updatedAt: new Date() }).where(eq(securitySessions.id, id)).returning()
  return row
}
