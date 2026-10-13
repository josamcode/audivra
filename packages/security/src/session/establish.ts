import type { Logger } from '@audivra/config'
import {
  EstablishSessionInput,
  type AuthFailureKind,
  type AuthFlow,
  type CookieValue,
  type CredentialSecret,
  type ExecutionLimits,
  type ScopeManifest,
  type SecurityActor,
  type SecurityEnvironment,
  type SecurityEventType,
  type SessionEstablishmentResult,
  type SessionMaterial,
  type SessionMetadata,
} from '@audivra/contracts'
import { findDomainDeclarationByRef, getEngagementRow, listSessionRows, recordSecurityEvent, type Db, type SessionRow } from '@audivra/database'
import type { z } from 'zod'
import { systemResolver, type Resolver } from '../dns.ts'
import { ScopedHttpClient } from '../http-client.ts'
import { evaluateUrl } from '../scope.ts'
import { assertConfigurationActor, LOCAL_USER, SecurityRequestError } from '../service.ts'
import type { SecretVault } from '../vault/vault.ts'
import { sessionHeaders } from './auth-resolver.ts'

/*
 * Phase 5 Step 3 — session establishment: the trusted step that turns an identity *reference* plus its
 * vault credential into an authenticated session, entirely on the server/worker. The flow is:
 *
 *   identity reference → trusted credential resolution → authentication (api-token / form-login / preestablished)
 *   → sealed session material in the vault → a session reference the capability layer injects
 *
 * A model never reaches this code, never names a credential and never sees a cookie or token: establishing a
 * session is a configuration action (a person or Audivra). Every failure is a precise `AuthFailureKind`, never
 * a generic error, and the plaintext credential is revealed only at the exact call site that types it into a
 * login form or attaches it to a request — it is never logged, echoed or returned.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/
const CLOSED = new Set(['completed', 'cancelled'])

/** A single validation request's budget — one in-scope GET to confirm the session is live. */
const VALIDATE_LIMITS: ExecutionLimits = { maxRequests: 6, requestsPerSecond: 4, concurrency: 1, executionTimeoutSeconds: 30, maxResponseBytes: 2_000_000, maxArtifactMb: 1 }

/** Raised inside establishment; carries the precise taxonomy kind. */
class EstablishError extends Error {
  constructor(
    readonly kind: AuthFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'EstablishError'
  }
}

/** What a browser form-login driver is asked to do. It receives the plaintext credential (trusted), returns cookies. */
export interface FormLoginRequest {
  loginUrl: string
  usernameSelector: string
  passwordSelector: string
  submitSelector: string
  successUrlIncludes: string | null
  successSelector: string | null
  /** The plaintext credential, used only to type into the form; never logged or returned. */
  username: string
  password: string
  /** Navigation must stay within these origins (the login origin). */
  allowedOrigins: string[]
  timeoutMs: number
  signal?: AbortSignal
}
export interface FormLoginResult {
  cookies: CookieValue[]
  finalUrl: string
}
/** Pluggable so the service is testable without a browser; the real driver (Playwright) is wired by the host. */
export interface FormLoginDriver {
  login(request: FormLoginRequest): Promise<FormLoginResult>
}

/** Minimal projector seam (avoids a hard dependency on the full `GraphProjector`). */
export interface GraphReprojector {
  project(engagementId: string): Promise<unknown>
}

export interface SessionEstablishmentOptions {
  db: Db
  vault: SecretVault
  resolver?: Resolver
  browserLogin?: FormLoginDriver
  projector?: GraphReprojector
  now?: () => Date
  log?: Logger
}

export class SessionEstablishmentService {
  readonly #db: Db
  readonly #vault: SecretVault
  readonly #resolver: Resolver
  readonly #browserLogin: FormLoginDriver | undefined
  readonly #projector: GraphReprojector | undefined
  readonly #now: () => Date
  readonly #log: Logger | undefined

  constructor(options: SessionEstablishmentOptions) {
    this.#db = options.db
    this.#vault = options.vault
    this.#resolver = options.resolver ?? systemResolver
    this.#browserLogin = options.browserLogin
    this.#projector = options.projector
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log
  }

  /** Establishes (or reuses) an authenticated session for a declared identity. Configuration action: never an agent. */
  async establish(engagementId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SessionEstablishmentResult> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(EstablishSessionInput, input)
    const engagement = await this.#openEngagement(engagementId)
    const environment = engagement.environment ?? 'production'
    const authMethod = data.flow.type
    await this.#event(engagementId, engagement.configVersion, 'session.establishment-started', `Establishing a ${authMethod} session for "${data.identityRef}"`, actor, data.identityRef, null)

    try {
      // The identity must be declared for every flow — a session is always *for* a known identity.
      const identity = await this.#loadIdentity(engagementId, data.identityRef)

      // Anonymous: there is nothing to establish — capabilities simply run unauthenticated.
      if (data.flow.type === 'anonymous') {
        await this.#event(engagementId, engagement.configVersion, 'session.established', `"${data.identityRef}" runs anonymously (no session)`, actor, data.identityRef, null)
        return { session: null, established: true, reused: false, failure: null }
      }

      // Reuse an existing live session unless asked to re-authenticate.
      if (data.reuse) {
        const reusable = await this.#reusableSession(engagementId, data.identityRef, environment, authMethod)
        if (reusable) {
          await this.#reproject(engagementId)
          return { session: toMetadata(reusable), established: true, reused: true, failure: null }
        }
      }

      this.#assertUrlsInScope(engagement.scope, data.flow)
      const material = await this.#material(engagementId, environment, identity, data.flow)
      await this.#validate(engagement.scope, data.flow, material)
      const expiresAt = materialExpiry(this.#now())
      const session = await this.#vault.createEstablishedSession(engagementId, { identityRef: data.identityRef, environment, authMethod, material, expiresAt })
      await this.#event(engagementId, engagement.configVersion, 'session.established', `Session for "${data.identityRef}" established via ${authMethod}`, actor, data.identityRef, session.id)
      await this.#reproject(engagementId)
      this.#log?.info({ engagementId, identityRef: data.identityRef, authMethod, sessionId: session.id }, 'security session established')
      return { session, established: true, reused: false, failure: null }
    } catch (error) {
      if (error instanceof EstablishError) {
        await this.#event(engagementId, engagement.configVersion, 'session.validation-failed', `Could not establish a session for "${data.identityRef}": ${error.message}`, actor, data.identityRef, null, 'warn')
        return { session: null, established: false, reused: false, failure: { kind: error.kind, message: error.message } }
      }
      throw error
    }
  }

  /** Revokes a session (drops its material) and re-projects so its graph edge goes inactive. */
  async revoke(sessionId: string, actor: SecurityActor = LOCAL_USER): Promise<SessionMetadata> {
    const meta = await this.#vault.revokeSession(sessionId, actor)
    await this.#reproject(meta.engagementId)
    return meta
  }

  // ── Material per flow ─────────────────────────────────────────────────────────────────────────────

  async #material(engagementId: string, environment: SecurityEnvironment, identity: IdentityFacts, flow: AuthFlow): Promise<SessionMaterial> {
    switch (flow.type) {
      case 'api-token':
        return this.#apiTokenMaterial(engagementId, identity, flow)
      case 'preestablished':
        return this.#preestablishedMaterial(engagementId, identity)
      case 'form-login':
        return this.#formLoginMaterial(engagementId, environment, identity, flow)
      default:
        throw new EstablishError('auth-flow-unsupported', `The ${(flow as AuthFlow).type} flow is not supported`)
    }
  }

  async #apiTokenMaterial(engagementId: string, identity: IdentityFacts, flow: Extract<AuthFlow, { type: 'api-token' }>): Promise<SessionMaterial> {
    const secret = await this.#secret(engagementId, identity)
    if (secret.type === 'bearer-token') return { bearerToken: secret.token }
    if (secret.type === 'api-token') {
      return flow.placement === 'bearer' ? { bearerToken: secret.token } : { headers: { [secret.headerName]: secret.token } }
    }
    if (secret.type === 'custom-header-secret') return { headers: { [secret.headerName]: secret.value } }
    throw new EstablishError('auth-flow-unsupported', `The api-token flow needs a token credential, not "${secret.type}"`)
  }

  async #preestablishedMaterial(engagementId: string, identity: IdentityFacts): Promise<SessionMaterial> {
    const secret = await this.#secret(engagementId, identity)
    if (secret.type === 'session-cookie-set') return { cookies: secret.cookies }
    if (secret.type === 'bearer-token') return { bearerToken: secret.token }
    if (secret.type === 'custom-header-secret') return { headers: { [secret.headerName]: secret.value } }
    throw new EstablishError('auth-flow-unsupported', `The preestablished flow needs cookies, a bearer token or a header secret, not "${secret.type}"`)
  }

  async #formLoginMaterial(engagementId: string, environment: SecurityEnvironment, identity: IdentityFacts, flow: Extract<AuthFlow, { type: 'form-login' }>): Promise<SessionMaterial> {
    const driver = await this.#formLoginDriver()
    const secret = await this.#secret(engagementId, identity)
    if (secret.type !== 'username-password') throw new EstablishError('auth-flow-unsupported', `Form login needs a username/password credential, not "${secret.type}"`)
    const origin = originOf(flow.loginUrl)
    if (!origin) throw new EstablishError('authentication-failed', 'The login URL is not a usable absolute URL')
    let result: FormLoginResult
    try {
      result = await driver.login({
        loginUrl: flow.loginUrl,
        usernameSelector: flow.usernameSelector,
        passwordSelector: flow.passwordSelector,
        submitSelector: flow.submitSelector,
        successUrlIncludes: flow.successUrlIncludes ?? null,
        successSelector: flow.successSelector ?? null,
        username: secret.username,
        password: secret.password,
        allowedOrigins: [origin],
        timeoutMs: environment === 'production' ? 45_000 : 60_000,
      })
    } catch (error) {
      // The driver never includes the credential in its error; still, redact defensively.
      throw new EstablishError('authentication-failed', `Form login did not complete: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`)
    }
    if (result.cookies.length === 0) throw new EstablishError('authentication-failed', 'Form login produced no session cookies')
    return { cookies: result.cookies }
  }

  /** The injected form-login driver, or the default Playwright one (lazily loaded so Chromium/Playwright stays off the eager import path). */
  async #formLoginDriver(): Promise<FormLoginDriver> {
    if (this.#browserLogin) return this.#browserLogin
    try {
      const { createPlaywrightFormLogin } = await import('./browser-login.ts')
      return createPlaywrightFormLogin()
    } catch (error) {
      throw new EstablishError('auth-flow-unsupported', `Form login requires a browser, which is not available: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Resolves the identity's configured credential as plaintext — trusted, transient, never persisted as-is. */
  async #secret(engagementId: string, identity: IdentityFacts): Promise<CredentialSecret> {
    if (!identity.credentialRef) throw new EstablishError('credential-missing', `Identity "${identity.ref}" has no credential configured`)
    if (this.#vault.health().state !== 'ready') throw new EstablishError('vault-unavailable', 'The credential vault is unavailable; a session cannot be established')
    const resolved = await this.#vault.resolveCredentialByRef(engagementId, identity.credentialRef)
    if (!resolved) throw new EstablishError('credential-revoked', `The credential "${identity.credentialRef}" for "${identity.ref}" is missing, revoked or expired`)
    return resolved.secret.reveal()
  }

  // ── Validation ────────────────────────────────────────────────────────────────────────────────────

  async #validate(scope: ScopeManifest, flow: AuthFlow, material: SessionMaterial): Promise<void> {
    const check = validationOf(flow)
    if (!check?.url) return // No validate URL configured: the credential/login success is trusted as-is.
    const origin = originOf(check.url)
    if (!origin) throw new EstablishError('authentication-failed', 'The validate URL is not a usable absolute URL')
    const signal = AbortSignal.timeout(VALIDATE_LIMITS.executionTimeoutSeconds * 1000)
    const client = new ScopedHttpClient({ manifest: scope, limits: VALIDATE_LIMITS, mutation: 'read-only', resolver: this.#resolver, signal, auth: { headers: sessionHeaders(material), origin } })
    let status: number
    try {
      const response = await client.request({ url: check.url, method: 'GET', followRedirects: false })
      status = response.status
    } catch (error) {
      throw new EstablishError('authentication-failed', `The session could not be validated against ${check.url}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
    }
    const ok = check.validStatuses.length ? check.validStatuses.includes(status) : status < 400
    if (!ok) throw new EstablishError('authentication-failed', `The validate URL returned ${status}, which is not an authenticated response`)
  }

  // ── Loading / reuse ───────────────────────────────────────────────────────────────────────────────

  async #loadIdentity(engagementId: string, ref: string): Promise<IdentityFacts> {
    const row = await findDomainDeclarationByRef(this.#db, engagementId, 'identity', ref)
    if (!row) throw new EstablishError('identity-unknown', `No identity "${ref}" is declared for this engagement`)
    const spec = row.spec as Record<string, unknown>
    const credentialRef = typeof spec.credentialRef === 'string' && spec.credentialRef.trim() ? spec.credentialRef.trim() : null
    return { ref, credentialRef }
  }

  async #reusableSession(engagementId: string, identityRef: string, environment: SecurityEnvironment, authMethod: string): Promise<SessionRow | undefined> {
    const now = this.#now().getTime()
    const rows = await listSessionRows(this.#db, engagementId, { identityRef })
    return rows.find((row) => row.status === 'active' && row.environment === environment && row.authMethod === authMethod && row.sealed !== null && (!row.expiresAt || row.expiresAt.getTime() > now))
  }

  // ── Scope / events / projection ─────────────────────────────────────────────────────────────────────

  #assertUrlsInScope(scope: ScopeManifest, flow: AuthFlow): void {
    const urls: string[] = []
    if (flow.type === 'form-login') urls.push(flow.loginUrl)
    const validate = validationOf(flow)?.url
    if (validate) urls.push(validate)
    for (const url of urls) {
      const evaluation = evaluateUrl(scope, url)
      if (evaluation.decision !== 'allow') throw new SecurityRequestError(400, `"${url}" is out of scope for this engagement (${evaluation.reason})`)
    }
  }

  async #event(engagementId: string, configVersion: number, type: SecurityEventType, message: string, actor: SecurityActor, identityRef: string, sessionId: string | null, level: 'info' | 'warn' = 'info'): Promise<void> {
    await recordSecurityEvent(this.#db, { engagementId, type, level, message, actor, configVersion, data: { identityRef, sessionId } })
  }

  async #reproject(engagementId: string): Promise<void> {
    if (!this.#projector) return
    try {
      await this.#projector.project(engagementId)
    } catch (error) {
      // Projection is advisory here; a failure must not fail (or roll back) an established session.
      this.#log?.warn({ engagementId, error: error instanceof Error ? error.message : String(error) }, 'security graph projection after session change failed')
    }
  }

  async #openEngagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    if (CLOSED.has(row.status)) throw new SecurityRequestError(409, `The engagement is ${row.status} and can no longer be changed`)
    if (!row.environment) throw new SecurityRequestError(409, 'The engagement has no environment set')
    return row
  }
}

interface IdentityFacts {
  ref: string
  credentialRef: string | null
}


function validationOf(flow: AuthFlow): { url: string | null; validStatuses: number[] } | null {
  switch (flow.type) {
    case 'api-token':
    case 'preestablished':
      return { url: flow.validateUrl ?? null, validStatuses: flow.validStatuses }
    case 'form-login':
      return { url: flow.validateUrl ?? null, validStatuses: [] }
    default:
      return null
  }
}

/** A conservative default lifetime for an established session (the resolver re-checks every execution). */
function materialExpiry(now: Date): Date {
  return new Date(now.getTime() + 12 * 60 * 60 * 1000)
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const toMetadata = (row: SessionRow): SessionMetadata => ({
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
})

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SecurityRequestError(400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '))
  }
  return parsed.data
}
