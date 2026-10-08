import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import {
  redact,
  redactSensitive,
  type AuthorizationMethod,
  type AuthorizationStatus,
  type AuthorizationSubject,
  type EngagementStatus,
  type EvidenceSource,
  type EvidenceType,
  type PolicyDecision,
  type ScopeManifest,
  type SecurityActor,
  type SecurityEnvironment,
  type SecurityEventItem,
  type SecurityEventType,
  type SecurityEvidenceItem,
  type SecurityEvidenceProvenance,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newAuditId, newId } from '../ids.ts'
import { audits, evidence, securityAuthorizations, securityEngagements, securityEvents } from '../schema.ts'

/*
 * Persistence for security engagements. Domain rules (readiness, policy, scope) live in
 * @audivra/security; this module stores rows and applies redaction at the persistence boundary, so a
 * secret that reaches an event, decision or evidence record is replaced before it is written.
 */

export type EngagementRow = typeof securityEngagements.$inferSelect
export type AuthorizationRow = typeof securityAuthorizations.$inferSelect

export interface CreateEngagementRecordInput {
  name: string
  description: string | null
  targetUrl: string
  siteKey: string
  environment: SecurityEnvironment | null
  status: EngagementStatus
  policyProfileKey: string
  policyProfileVersion: number
  scope: ScopeManifest
  scopeHash: string
  createdBy: string
}

/** Engagement IDs appear in URLs and directory names, like audit IDs. */
export async function createEngagementRecord(db: Db, input: CreateEngagementRecordInput): Promise<EngagementRow> {
  const [row] = await db
    .insert(securityEngagements)
    .values({ id: newAuditId(), ...input })
    .returning()
  if (!row) throw new Error('Failed to create security engagement')
  return row
}

export async function getEngagementRow(db: Db, id: string): Promise<EngagementRow | undefined> {
  const [row] = await db.select().from(securityEngagements).where(eq(securityEngagements.id, id))
  return row
}

export async function listEngagementRows(db: Db, limit = 200): Promise<EngagementRow[]> {
  return db.select().from(securityEngagements).orderBy(desc(securityEngagements.updatedAt)).limit(limit)
}

export type EngagementPatch = Partial<
  Pick<EngagementRow, 'name' | 'description' | 'environment' | 'status' | 'policyProfileKey' | 'policyProfileVersion' | 'scope' | 'scopeHash'>
> & { bumpScopeVersion?: boolean; bumpConfigVersion?: boolean }

/**
 * Applies a patch. Configuration changes bump `config_version` (and `scope_version` for scope changes)
 * atomically. With `expected`, the update only applies to that exact version (optimistic concurrency);
 * null is returned when it has moved on.
 */
export async function updateEngagementRecord(
  db: Db,
  id: string,
  patch: EngagementPatch,
  expected?: { configVersion?: number; scopeVersion?: number },
): Promise<EngagementRow | null> {
  const { bumpScopeVersion, bumpConfigVersion, ...values } = patch
  const [row] = await db
    .update(securityEngagements)
    .set({
      ...values,
      ...(bumpScopeVersion ? { scopeVersion: sql`${securityEngagements.scopeVersion} + 1` } : {}),
      ...(bumpConfigVersion ? { configVersion: sql`${securityEngagements.configVersion} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(securityEngagements.id, id),
        expected?.configVersion !== undefined ? eq(securityEngagements.configVersion, expected.configVersion) : undefined,
        expected?.scopeVersion !== undefined ? eq(securityEngagements.scopeVersion, expected.scopeVersion) : undefined,
      ),
    )
    .returning()
  return row ?? null
}

/** Website Audits of the same site (benchmark runs excluded). */
export async function siteAuditStats(db: Db, siteKey: string): Promise<{ count: number; latestAuditId: string | null }> {
  const [stats] = await db
    .select({ count: count() })
    .from(audits)
    .where(and(eq(audits.siteKey, siteKey), eq(audits.benchmark, false)))
  const [latest] = await db
    .select({ id: audits.id })
    .from(audits)
    .where(and(eq(audits.siteKey, siteKey), eq(audits.benchmark, false)))
    .orderBy(desc(audits.createdAt))
    .limit(1)
  return { count: stats?.count ?? 0, latestAuditId: latest?.id ?? null }
}

// ── Authorizations ──────────────────────────────────────────────────────────────────────────────────

export interface CreateAuthorizationInput {
  engagementId: string
  method: AuthorizationMethod
  status: AuthorizationStatus
  subject: AuthorizationSubject
  reason?: string | null
  challenge?: string | null
  reference?: string | null
  metadata?: Record<string, unknown>
  verifiedAt?: Date | null
  expiresAt?: Date | null
  createdBy: string
}

export async function insertAuthorization(db: Db, input: CreateAuthorizationInput): Promise<AuthorizationRow> {
  const [row] = await db
    .insert(securityAuthorizations)
    .values({
      id: newId('sa'),
      ...input,
      reason: input.reason ? redact(input.reason).slice(0, 1000) : null,
      metadata: redact(input.metadata ?? {}),
    })
    .returning()
  if (!row) throw new Error('Failed to record authorization')
  return row
}

export async function revokeAuthorization(db: Db, engagementId: string, id: string, reason: string): Promise<AuthorizationRow | null> {
  const now = new Date()
  const [row] = await db
    .update(securityAuthorizations)
    .set({ status: 'revoked', revokedAt: now, updatedAt: now, reason: redact(reason).slice(0, 1000) })
    .where(and(eq(securityAuthorizations.id, id), eq(securityAuthorizations.engagementId, engagementId)))
    .returning()
  return row ?? null
}

export async function listAuthorizationRows(db: Db, engagementIds: string[]): Promise<AuthorizationRow[]> {
  if (engagementIds.length === 0) return []
  return db
    .select()
    .from(securityAuthorizations)
    .where(inArray(securityAuthorizations.engagementId, engagementIds))
    .orderBy(asc(securityAuthorizations.createdAt))
}

// ── Append-only security events ─────────────────────────────────────────────────────────────────────

export interface RecordSecurityEventInput {
  engagementId: string
  type: SecurityEventType
  message: string
  level?: 'info' | 'warn' | 'error'
  actor: SecurityActor
  executionId?: string | null
  capabilityId?: string | null
  configVersion: number
  decision?: PolicyDecision | null
  data?: Record<string, unknown> | null
}

type SecurityEventRow = typeof securityEvents.$inferSelect

function toSecurityEventItem(row: SecurityEventRow): SecurityEventItem {
  return {
    id: row.id,
    engagementId: row.engagementId,
    type: row.type,
    level: row.level,
    message: row.message,
    actor: row.actor,
    executionId: row.executionId,
    capabilityId: row.capabilityId,
    configVersion: row.configVersion,
    decision: row.decision ?? null,
    data: row.data ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Appends one event. Message, decision and data are redacted before they are written. */
export async function recordSecurityEvent(db: Db, input: RecordSecurityEventInput): Promise<SecurityEventItem> {
  const [row] = await db
    .insert(securityEvents)
    .values({
      engagementId: input.engagementId,
      type: input.type,
      level: input.level ?? 'info',
      message: redact(input.message).slice(0, 2000),
      actor: input.actor,
      executionId: input.executionId ?? null,
      capabilityId: input.capabilityId ?? null,
      configVersion: input.configVersion,
      decision: input.decision ? redact(input.decision) : null,
      data: input.data ? redact(input.data) : null,
    })
    .returning()
  if (!row) throw new Error('Failed to record security event')
  return toSecurityEventItem(row)
}

export async function listSecurityEvents(
  db: Db,
  engagementId: string,
  options: { afterId?: number; executionId?: string; limit?: number } = {},
): Promise<SecurityEventItem[]> {
  const rows = await db
    .select()
    .from(securityEvents)
    .where(
      and(
        eq(securityEvents.engagementId, engagementId),
        options.afterId !== undefined ? gt(securityEvents.id, options.afterId) : undefined,
        options.executionId ? eq(securityEvents.executionId, options.executionId) : undefined,
      ),
    )
    .orderBy(asc(securityEvents.id))
    .limit(options.limit ?? 2000)
  return rows.map(toSecurityEventItem)
}

// ── Security evidence (the shared evidence table, engagement-owned rows) ────────────────────────────

export interface CreateSecurityEvidenceInput {
  engagementId: string
  source: EvidenceSource
  type: EvidenceType
  title: string
  summary: string
  url?: string | null
  artifactPath?: string | null
  metadata?: Record<string, unknown>
  provenance: Omit<SecurityEvidenceProvenance, 'redactions' | 'recordedAt'>
}

type EvidenceRow = typeof evidence.$inferSelect

function toSecurityEvidenceItem(row: EvidenceRow): SecurityEvidenceItem {
  return {
    id: row.id,
    ref: row.ref,
    engagementId: row.engagementId!,
    source: row.source,
    type: row.type,
    title: row.title,
    summary: row.summary,
    url: row.url,
    artifactPath: row.artifactPath,
    metadata: row.metadata,
    provenance: row.securityProvenance!,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Records evidence produced by an allowed capability execution, with the next per-engagement reference
 * (EV-1, EV-2, …). Content is redacted first; the number of replaced values is kept in the provenance.
 */
export async function createSecurityEvidence(db: Db, input: CreateSecurityEvidenceInput): Promise<SecurityEvidenceItem> {
  const content = redactSensitive({ title: input.title, summary: input.summary, url: input.url ?? null, metadata: input.metadata ?? {} })
  const provenance: SecurityEvidenceProvenance = {
    ...input.provenance,
    redactions: content.redactions,
    sensitivity: content.redactions > 0 ? 'sensitive' : input.provenance.sensitivity,
    recordedAt: new Date().toISOString(),
  }
  return db.transaction(async (tx) => {
    const [seq] = await tx
      .update(securityEngagements)
      .set({ evidenceSeq: sql`${securityEngagements.evidenceSeq} + 1` })
      .where(eq(securityEngagements.id, input.engagementId))
      .returning({ value: securityEngagements.evidenceSeq })
    if (!seq) throw new Error(`Security engagement ${input.engagementId} not found`)
    const [row] = await tx
      .insert(evidence)
      .values({
        id: newId('ev'),
        auditId: null,
        engagementId: input.engagementId,
        securityExecutionId: provenance.executionId,
        securityProvenance: provenance,
        ref: `EV-${seq.value}`,
        source: input.source,
        type: input.type,
        title: content.value.title.slice(0, 300),
        summary: content.value.summary.slice(0, 4000),
        url: content.value.url,
        artifactPath: input.artifactPath ?? null,
        metadata: content.value.metadata,
      })
      .returning()
    if (!row) throw new Error('Failed to create security evidence')
    return toSecurityEvidenceItem(row)
  })
}

export async function listSecurityEvidence(db: Db, engagementId: string, executionId?: string): Promise<SecurityEvidenceItem[]> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.engagementId, engagementId), executionId ? eq(evidence.securityExecutionId, executionId) : undefined))
    .orderBy(asc(evidence.createdAt), asc(evidence.id))
  return rows.map(toSecurityEvidenceItem)
}
