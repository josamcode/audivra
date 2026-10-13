import { z } from 'zod'
import { SecurityEnvironment } from './security-classes.ts'

/*
 * Phase 5 Step 2 — the credential/session secret boundary. Audivra's domain and AI state reason about an
 * identity's *reference* and whether a credential is configured, never about credential material. The secret
 * (a password, token, cookie set, …) is encrypted at rest in the vault and resolved only by trusted
 * server/worker code at execution time. These contracts define the SAFE surface (metadata, inputs); the
 * secret payload type is used only when sealing/opening inside the vault and never appears in a domain
 * object, API response, event, graph node, evidence, log or export.
 */

// ── Credential types and their secret payloads ───────────────────────────────────────────────────────

export const CREDENTIAL_TYPES = ['username-password', 'api-token', 'bearer-token', 'session-cookie-set', 'custom-header-secret'] as const
export const CredentialType = z.enum(CREDENTIAL_TYPES)
export type CredentialType = z.infer<typeof CredentialType>

export const CookieValue = z.strictObject({
  name: z.string().min(1).max(256),
  value: z.string().max(8192),
  domain: z.string().max(256).optional(),
  path: z.string().max(1024).optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
})
export type CookieValue = z.infer<typeof CookieValue>

/**
 * The secret material of a credential, by type. THIS NEVER LEAVES THE VAULT: it is the plaintext that is
 * sealed on write and returned (wrapped) only to trusted runtime code on `resolve()`. Never serialize it
 * into any persisted or model-facing state.
 */
export const CredentialSecret = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('username-password'), username: z.string().min(1).max(1024), password: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('api-token'), token: z.string().min(1).max(8192), headerName: z.string().min(1).max(128).default('X-API-Key') }),
  z.strictObject({ type: z.literal('bearer-token'), token: z.string().min(1).max(8192) }),
  z.strictObject({ type: z.literal('session-cookie-set'), cookies: z.array(CookieValue).min(1).max(50) }),
  z.strictObject({ type: z.literal('custom-header-secret'), headerName: z.string().min(1).max(128), value: z.string().min(1).max(8192) }),
])
export type CredentialSecret = z.infer<typeof CredentialSecret>

// ── Safe metadata (what the API, events and UI ever see) ─────────────────────────────────────────────

export const CREDENTIAL_STATUSES = ['active', 'revoked'] as const
export const CredentialStatus = z.enum(CREDENTIAL_STATUSES)
export type CredentialStatus = z.infer<typeof CredentialStatus>

export const CredentialMetadata = z.object({
  id: z.string(),
  engagementId: z.string(),
  /** The identity declaration handle this credential is for (null: not bound to a specific identity). */
  identityRef: z.string().nullable(),
  /** The opaque reference an identity's `credentialRef` points to. */
  ref: z.string(),
  type: CredentialType,
  label: z.string(),
  status: CredentialStatus,
  /** Always true for a stored credential — a convenience the UI/graph can show without the secret. */
  configured: z.literal(true),
  /** Fingerprint of the key that sealed it (non-secret), for rotation visibility. */
  keyId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
})
export type CredentialMetadata = z.infer<typeof CredentialMetadata>

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────────

const refField = z
  .string()
  .trim()
  .min(1)
  .max(120)
const expiresField = z.string().datetime().nullable().optional()

/** Store a credential. `secret` is sealed immediately and never echoed back. */
export const SetCredentialInput = z.strictObject({
  ref: refField,
  identityRef: refField.nullable().optional(),
  label: z.string().trim().min(1).max(200).optional(),
  expiresAt: expiresField,
  secret: CredentialSecret,
})
export type SetCredentialInput = z.infer<typeof SetCredentialInput>

/** Replace the secret of an existing credential (and optionally its label/expiry). */
export const ReplaceCredentialInput = z.strictObject({
  label: z.string().trim().min(1).max(200).optional(),
  expiresAt: expiresField,
  secret: CredentialSecret,
})
export type ReplaceCredentialInput = z.infer<typeof ReplaceCredentialInput>

// ── Sessions (metadata separate from sealed material; establishment is Step 3) ───────────────────────

export const SESSION_STATUSES = ['pending', 'active', 'expired', 'revoked', 'invalid'] as const
export const SessionStatus = z.enum(SESSION_STATUSES)
export type SessionStatus = z.infer<typeof SessionStatus>

/**
 * Sealed session material (cookies/tokens/headers). Like `CredentialSecret`, this NEVER leaves the vault:
 * it is sealed on write and returned (wrapped) only to trusted runtime code. Establishment is Step 3.
 */
export const SessionMaterial = z.strictObject({
  cookies: z.array(CookieValue).max(100).optional(),
  bearerToken: z.string().max(8192).optional(),
  headers: z.record(z.string().max(128), z.string().max(8192)).optional(),
})
export type SessionMaterial = z.infer<typeof SessionMaterial>

export const CreateSessionInput = z.strictObject({
  identityRef: refField,
  environment: SecurityEnvironment,
  authMethod: z.string().trim().min(1).max(60),
  status: SessionStatus.default('pending'),
  expiresAt: expiresField,
  /** Optional sealed material to store with the session (otherwise metadata only). */
  material: SessionMaterial.optional(),
})
export type CreateSessionInput = z.infer<typeof CreateSessionInput>

export const SessionMetadata = z.object({
  id: z.string(),
  engagementId: z.string(),
  identityRef: z.string(),
  environment: SecurityEnvironment,
  authMethod: z.string(),
  status: SessionStatus,
  /** Whether sealed session material (cookies/tokens) is held in the vault for this session. */
  material: z.boolean(),
  keyId: z.string().nullable(),
  createdAt: z.string(),
  refreshedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
export type SessionMetadata = z.infer<typeof SessionMetadata>

// ── Vault health (for the System view / degraded operation) ──────────────────────────────────────────

export const VAULT_STATES = ['ready', 'unavailable', 'misconfigured'] as const
export const VaultState = z.enum(VAULT_STATES)
export type VaultState = z.infer<typeof VaultState>

export const VaultHealth = z.object({
  state: VaultState,
  /** Active key fingerprint (non-secret), or null when no key is available. */
  activeKeyId: z.string().nullable(),
  /** Key fingerprints available for decryption (for rotation visibility). */
  keyIds: z.array(z.string()),
  /** Where the key came from: env | key-file | dev-file. */
  source: z.enum(['env', 'key-file', 'dev-file', 'none']),
  detail: z.string().nullable(),
})
export type VaultHealth = z.infer<typeof VaultHealth>
