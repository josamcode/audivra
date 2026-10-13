import type { AuthFailureKind, SecurityEnvironment, SecurityExecutionSnapshot, SessionMaterial } from '@audivra/contracts'
import { getSessionRow, type Db } from '@audivra/database'
import type { SecretVault } from '../vault/vault.ts'

/*
 * The identity-aware execution auth boundary (Phase 5 Step 3). At DECISION time it validates a referenced
 * session without touching any secret; at EXECUTION time, trusted runtime code resolves the actual auth
 * material (cookies/token) from the vault and returns the exact headers to inject — bound to the session's
 * origin, never persisted, never handed to a model. A revoked, expired, invalid or missing session fails
 * with a precise `AuthFailureKind`, never a generic error.
 */

export class AuthResolutionError extends Error {
  constructor(
    readonly kind: AuthFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'AuthResolutionError'
  }
}

export interface ValidatedIdentity {
  identityRef: string | null
  sessionRef: string | null
  authMethod: string | null
}

/** The broker and runtime depend on this interface, not the vault directly. */
export interface ExecutionAuthResolver {
  validate(input: { engagementId: string; environment: SecurityEnvironment; identityRef: string | null; sessionRef: string | null }): Promise<ValidatedIdentity>
  resolve(snapshot: SecurityExecutionSnapshot): Promise<{ headers: Record<string, string>; origin: string } | null>
}

const SESSION_ID = /^sess_[0-9a-z]{14}$/

/** Turns sealed session material into the request headers to inject. */
export function sessionHeaders(material: SessionMaterial): Record<string, string> {
  const headers: Record<string, string> = {}
  if (material.cookies?.length) headers.cookie = material.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  if (material.bearerToken) headers.authorization = `Bearer ${material.bearerToken}`
  for (const [name, value] of Object.entries(material.headers ?? {})) headers[name.toLowerCase()] = value
  return headers
}

export class VaultAuthResolver implements ExecutionAuthResolver {
  readonly #db: Db
  readonly #vault: SecretVault
  readonly #now: () => Date

  constructor(options: { db: Db; vault: SecretVault; now?: () => Date }) {
    this.#db = options.db
    this.#vault = options.vault
    this.#now = options.now ?? (() => new Date())
  }

  async validate(input: { engagementId: string; environment: SecurityEnvironment; identityRef: string | null; sessionRef: string | null }): Promise<ValidatedIdentity> {
    if (!input.sessionRef) {
      // Identity without an established session: reference it, but there is nothing to inject yet.
      if (!input.identityRef) throw new AuthResolutionError('identity-unknown', 'No identity or session referenced')
      return { identityRef: input.identityRef, sessionRef: null, authMethod: null }
    }
    const row = SESSION_ID.test(input.sessionRef) ? await getSessionRow(this.#db, input.sessionRef) : undefined
    if (!row || row.engagementId !== input.engagementId) throw new AuthResolutionError('session-invalid', 'The referenced session does not belong to this engagement')
    if (input.identityRef && row.identityRef !== input.identityRef) throw new AuthResolutionError('session-invalid', 'The session belongs to a different identity')
    if (row.environment !== input.environment) throw new AuthResolutionError('session-invalid', `The session was established for the ${row.environment} environment, not ${input.environment}`)
    if (row.status === 'revoked') throw new AuthResolutionError('session-invalid', 'The session has been revoked')
    if (row.status === 'invalid') throw new AuthResolutionError('session-invalid', 'The session is marked invalid')
    if (row.status === 'expired' || (row.expiresAt && row.expiresAt.getTime() <= this.#now().getTime())) throw new AuthResolutionError('session-expired', 'The session has expired; re-establish it')
    if (row.status !== 'active') throw new AuthResolutionError('session-invalid', `The session is ${row.status}, not active`)
    return { identityRef: row.identityRef, sessionRef: row.id, authMethod: row.authMethod }
  }

  async resolve(snapshot: SecurityExecutionSnapshot): Promise<{ headers: Record<string, string>; origin: string } | null> {
    const identity = snapshot.identity
    if (!identity?.sessionRef) return null // anonymous, or identity with no session → nothing to inject
    if (this.#vault.health().state !== 'ready') throw new AuthResolutionError('vault-unavailable', 'The credential vault is unavailable; identity-aware execution cannot resolve its session')
    // Re-validate at the trusted boundary (the session may have been revoked/expired since the decision).
    await this.validate({ engagementId: snapshot.engagement.id, environment: snapshot.environment, identityRef: identity.identityRef, sessionRef: identity.sessionRef })
    const material = await this.#vault.resolveSessionMaterial(identity.sessionRef)
    if (!material) throw new AuthResolutionError('session-invalid', 'The session has no resolvable material')
    const origin = originOf(snapshot)
    if (!origin) throw new AuthResolutionError('session-invalid', 'The execution has no in-scope origin to attach the session to')
    return { headers: sessionHeaders(material.reveal()), origin }
  }
}

function originOf(snapshot: SecurityExecutionSnapshot): string | null {
  for (const target of snapshot.allowedTargets) {
    try {
      return new URL(target).origin
    } catch {
      /* skip */
    }
  }
  return null
}
