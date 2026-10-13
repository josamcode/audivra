import type { Logger } from '@audivra/config'
import {
  CreateSessionInput,
  ReplaceCredentialInput,
  SetCredentialInput,
  sensitive,
  type CredentialMetadata,
  type CredentialSecret,
  type SecurityActor,
  type SecurityEventType,
  type SessionMaterial,
  type SessionMetadata,
  type SessionStatus,
  type SensitiveValue,
  type VaultHealth,
} from '@audivra/contracts'
import {
  createCredentialRow,
  createSessionRow,
  deleteCredentialRow,
  getCredentialRow,
  getCredentialRowByRef,
  getEngagementRow,
  getSessionRow,
  listCredentialRows,
  listSessionRows,
  newCredentialId,
  newSessionId,
  recordSecurityEvent,
  toCredentialMetadata,
  toSessionMetadata,
  updateCredentialRow,
  updateSessionRow,
  type CredentialRow,
  type Db,
  type SessionRow,
} from '@audivra/database'
import type { z } from 'zod'
import { assertConfigurationActor, LOCAL_USER, SecurityRequestError } from '../service.ts'
import { keyringHealth, loadKeyring, open, seal, VaultError, type Keyring } from './keyring.ts'

/*
 * The credential/session vault: the single trusted boundary between Audivra's domain/AI state and secret
 * material. Management (set/replace/revoke/delete) is a configuration action — only a person or Audivra,
 * never an agent — and returns SAFE METADATA; the secret is sealed immediately and never echoed. Resolution
 * (`resolveCredential…` / `resolveSessionMaterial`) is trusted server/worker code only and is NEVER exposed
 * over HTTP: it returns the secret wrapped in `SensitiveValue` so an accidental log or serialization prints
 * a placeholder, and nothing persists the plaintext. Revoked, expired or deleted credentials do not resolve;
 * a missing/invalid key fails safely without resetting anything.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/
const CREDENTIAL_ID = /^cred_[0-9a-z]{14}$/
const SESSION_ID = /^sess_[0-9a-z]{14}$/

/** A resolved credential — only trusted runtime code ever holds this; the secret is wrapped. */
export interface ResolvedCredential {
  id: string
  ref: string
  identityRef: string | null
  secret: SensitiveValue<CredentialSecret>
}

let cachedKeyring: Keyring | undefined

/** Process-wide keyring (loaded once, so the dev key is generated at most once). Tests pass one explicitly. */
export function defaultKeyring(log?: Logger): Keyring {
  return (cachedKeyring ??= loadKeyring({ log }))
}

/** For tests: forget the cached keyring so the next load re-reads configuration. */
export function resetKeyringCache(): void {
  cachedKeyring = undefined
}

export function createSecretVault(db: Db, options: { log?: Logger; keyring?: Keyring; now?: () => Date } = {}): SecretVault {
  return new SecretVault({ db, keyring: options.keyring ?? defaultKeyring(options.log), now: options.now })
}

export class SecretVault {
  readonly #db: Db
  readonly #keyring: Keyring
  readonly #now: () => Date

  constructor(options: { db: Db; keyring: Keyring; now?: () => Date }) {
    this.#db = options.db
    this.#keyring = options.keyring
    this.#now = options.now ?? (() => new Date())
  }

  health(): VaultHealth {
    return keyringHealth(this.#keyring)
  }

  // ── Credential management (configuration: people and Audivra only; returns metadata, never the secret) ──

  async setCredential(engagementId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<CredentialMetadata> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(SetCredentialInput, input)
    const engagement = await this.#openEngagement(engagementId)
    if (await getCredentialRowByRef(this.#db, engagementId, data.ref)) throw new SecurityRequestError(409, `A credential "${data.ref}" already exists; replace it instead`)
    const { sealed, keyId } = this.#seal(data.secret)
    const row = await createCredentialRow(this.#db, {
      id: newCredentialId(),
      engagementId,
      identityRef: data.identityRef ?? null,
      ref: data.ref,
      type: data.secret.type,
      label: data.label ?? data.ref,
      sealed,
      keyId,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    })
    await this.#event(engagement.id, engagement.configVersion, 'credential.created', `Credential "${row.ref}" stored (${row.type})`, row, actor)
    return toCredentialMetadata(row)
  }

  async replaceCredential(credentialId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<CredentialMetadata> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(ReplaceCredentialInput, input)
    const existing = await this.#credentialRow(credentialId)
    const engagement = await this.#openEngagement(existing.engagementId)
    const { sealed, keyId } = this.#seal(data.secret)
    // Replacing overwrites the old ciphertext (the previous secret becomes unrecoverable) and reactivates it.
    const row = await updateCredentialRow(this.#db, credentialId, { sealed, keyId, status: 'active', revokedAt: null, ...(data.label ? { label: data.label } : {}), ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt ? new Date(data.expiresAt) : null } : {}) })
    await this.#event(engagement.id, engagement.configVersion, 'credential.replaced', `Credential "${existing.ref}" replaced`, row ?? existing, actor)
    return toCredentialMetadata(row ?? existing)
  }

  async revokeCredential(credentialId: string, actor: SecurityActor = LOCAL_USER): Promise<CredentialMetadata> {
    assertConfigurationActor(actor)
    const existing = await this.#credentialRow(credentialId)
    const engagement = await this.#openEngagement(existing.engagementId)
    const row = existing.status === 'revoked' ? existing : (await updateCredentialRow(this.#db, credentialId, { status: 'revoked', revokedAt: this.#now() })) ?? existing
    if (existing.status !== 'revoked') await this.#event(engagement.id, engagement.configVersion, 'credential.revoked', `Credential "${existing.ref}" revoked`, row, actor)
    return toCredentialMetadata(row)
  }

  async deleteCredential(credentialId: string, actor: SecurityActor = LOCAL_USER): Promise<{ deleted: boolean }> {
    assertConfigurationActor(actor)
    const existing = await this.#credentialRow(credentialId)
    const engagement = await this.#openEngagement(existing.engagementId)
    const deleted = await deleteCredentialRow(this.#db, credentialId)
    if (deleted) await this.#event(engagement.id, engagement.configVersion, 'credential.deleted', `Credential "${existing.ref}" deleted`, existing, actor, 'warn')
    return { deleted }
  }

  async credential(credentialId: string): Promise<CredentialMetadata> {
    return toCredentialMetadata(await this.#credentialRow(credentialId))
  }

  async listCredentials(engagementId: string, identityRef?: string): Promise<CredentialMetadata[]> {
    await this.#engagement(engagementId)
    return (await listCredentialRows(this.#db, engagementId, { identityRef })).map(toCredentialMetadata)
  }

  // ── Trusted resolution (server/worker only — never exposed over HTTP) ─────────────────────────────────

  /** Resolves a credential by its reference for a specific engagement. Null when absent/revoked/expired. */
  async resolveCredentialByRef(engagementId: string, ref: string): Promise<ResolvedCredential | null> {
    const row = await getCredentialRowByRef(this.#db, engagementId, ref)
    return row ? this.#resolveRow(row) : null
  }

  async resolveCredentialById(credentialId: string): Promise<ResolvedCredential | null> {
    const row = CREDENTIAL_ID.test(credentialId) ? await getCredentialRow(this.#db, credentialId) : undefined
    return row ? this.#resolveRow(row) : null
  }

  #resolveRow(row: CredentialRow): ResolvedCredential | null {
    if (row.status === 'revoked') return null
    if (row.expiresAt && row.expiresAt.getTime() <= this.#now().getTime()) return null
    const secret = JSON.parse(open(this.#keyring, row.sealed)) as CredentialSecret
    return { id: row.id, ref: row.ref, identityRef: row.identityRef, secret: sensitive(secret, `credential:${row.ref}`) }
  }

  // ── Sessions (metadata separate from sealed material; establishment is Step 3) ───────────────────────

  async createSession(engagementId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SessionMetadata> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(CreateSessionInput, input)
    const engagement = await this.#openEngagement(engagementId)
    const sealed = data.material ? this.#seal(data.material) : null
    const row = await createSessionRow(this.#db, {
      id: newSessionId(),
      engagementId,
      identityRef: data.identityRef,
      environment: data.environment,
      authMethod: data.authMethod,
      status: data.status,
      sealed: sealed?.sealed ?? null,
      keyId: sealed?.keyId ?? null,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    })
    await this.#event(engagement.id, engagement.configVersion, 'session.created', `Session for "${row.identityRef}" created (${row.status})`, { id: row.id, ref: row.identityRef, identityRef: row.identityRef }, actor)
    return toSessionMetadata(row)
  }

  async revokeSession(sessionId: string, actor: SecurityActor = LOCAL_USER): Promise<SessionMetadata> {
    assertConfigurationActor(actor)
    const existing = await this.#sessionRow(sessionId)
    const engagement = await this.#openEngagement(existing.engagementId)
    // Revoking also drops the sealed material, so it can never be resolved again.
    const row = (await updateSessionRow(this.#db, sessionId, { status: 'revoked', revokedAt: this.#now(), sealed: null, keyId: null })) ?? existing
    await this.#event(engagement.id, engagement.configVersion, 'session.revoked', `Session for "${existing.identityRef}" revoked`, { id: existing.id, ref: existing.identityRef, identityRef: existing.identityRef }, actor, 'warn')
    return toSessionMetadata(row)
  }

  /** Trusted: stores sealed session material (Step 3 login flow). */
  async storeSessionMaterial(sessionId: string, material: SessionMaterial, status: SessionStatus = 'active'): Promise<SessionMetadata> {
    const existing = await this.#sessionRow(sessionId)
    const { sealed, keyId } = this.#seal(material)
    const row = (await updateSessionRow(this.#db, sessionId, { sealed, keyId, status, refreshedAt: this.#now() })) ?? existing
    return toSessionMetadata(row)
  }

  /** Trusted: resolves sealed session material. Null when absent/revoked. */
  async resolveSessionMaterial(sessionId: string): Promise<SensitiveValue<SessionMaterial> | null> {
    const row = SESSION_ID.test(sessionId) ? await getSessionRow(this.#db, sessionId) : undefined
    if (!row || row.status === 'revoked' || !row.sealed) return null
    if (row.expiresAt && row.expiresAt.getTime() <= this.#now().getTime()) return null
    return sensitive(JSON.parse(open(this.#keyring, row.sealed)) as SessionMaterial, `session:${row.id}`)
  }

  async session(sessionId: string): Promise<SessionMetadata> {
    return toSessionMetadata(await this.#sessionRow(sessionId))
  }

  async listSessions(engagementId: string, identityRef?: string): Promise<SessionMetadata[]> {
    await this.#engagement(engagementId)
    return (await listSessionRows(this.#db, engagementId, { identityRef })).map(toSessionMetadata)
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  #seal(value: unknown): { sealed: string; keyId: string } {
    if (this.#keyring.state !== 'ready' || !this.#keyring.activeKeyId) throw new SecurityRequestError(409, `The credential vault is ${this.#keyring.state} (${this.#keyring.detail ?? 'no key'})`)
    try {
      return { sealed: seal(this.#keyring, JSON.stringify(value)), keyId: this.#keyring.activeKeyId }
    } catch (error) {
      if (error instanceof VaultError) throw new SecurityRequestError(409, `The credential vault is unavailable: ${error.message}`)
      throw error
    }
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }

  async #openEngagement(id: string) {
    const row = await this.#engagement(id)
    if (row.status === 'completed' || row.status === 'cancelled') throw new SecurityRequestError(409, `The engagement is ${row.status} and can no longer be changed`)
    return row
  }

  async #credentialRow(id: string): Promise<CredentialRow> {
    const row = CREDENTIAL_ID.test(id) ? await getCredentialRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Credential not found')
    return row
  }

  async #sessionRow(id: string): Promise<SessionRow> {
    const row = SESSION_ID.test(id) ? await getSessionRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Session not found')
    return row
  }

  async #event(engagementId: string, configVersion: number, type: SecurityEventType, message: string, subject: { id?: string; ref: string; identityRef?: string | null; type?: string }, actor: SecurityActor, level: 'info' | 'warn' = 'info') {
    await recordSecurityEvent(this.#db, { engagementId, type, level, message, actor, configVersion, data: { credentialId: subject.id ?? null, ref: subject.ref, identityRef: subject.identityRef ?? null, type: subject.type ?? null } })
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    // Zod issues carry the field path and message, never the submitted value — no secret leaks into the error.
    throw new SecurityRequestError(400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '))
  }
  return parsed.data
}
