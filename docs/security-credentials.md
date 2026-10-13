# Credential vault & session secret boundary (Phase 5 Step 2)

Audivra's domain and AI state reason about an identity's **reference** and whether a credential is
configured — never about credential material. The secret (a password, token, cookie set, …) is encrypted at
rest in the vault and resolved only by trusted server/worker code at execution time.

```
identity (Step 1 declaration, credentialRef)         domain / AI / graph / events / API
      │                                              reason about: "identity A has a credential configured"
      ▼
credential (sealed envelope in security_credentials) ── trusted runtime only ──► SecretVault.resolve() ──► SensitiveValue<secret>
```

This step only stores, references, redacts and safely resolves credentials/session material. **No
authenticated testing, login, session establishment, auth injection or planner work** — those are Step 3.

## Where it lives

| Concern | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-credentials.ts` (types, safe metadata, inputs, vault health) |
| Crypto / keyring | `packages/security/src/vault/keyring.ts` |
| Vault service | `packages/security/src/vault/vault.ts` (`SecretVault`, `createSecretVault`) |
| Schema + migration | `packages/database/src/schema.ts`, `migrations/0008_security_secrets.sql` (additive) |
| Repositories | `packages/database/src/repo/security-credentials.ts` |
| API | `apps/server/src/routes-credentials.ts` |
| Config | `AUDIVRA_SECRET_KEY`, `AUDIVRA_SECRET_KEY_FILE` (`@audivra/config`) |

## Vault architecture

`SecretVault` is the single trusted boundary between domain/AI state and secret material:

- **Management** (`setCredential`, `replaceCredential`, `revokeCredential`, `deleteCredential`,
  `createSession`, `revokeSession`) is a **configuration action** — only a person or Audivra; an agent is
  refused (`assertConfigurationActor`), so a model can never create or read a credential. It returns **safe
  metadata** (`configured: true`), never the secret.
- **Resolution** (`resolveCredentialByRef` / `resolveCredentialById` / `resolveSessionMaterial`) is trusted
  server/worker code and is **never exposed over HTTP**. It returns the secret wrapped in `SensitiveValue`,
  so an accidental log or `JSON.stringify` prints `[REDACTED]`; only `.reveal()` returns it, at the point of
  use. Nothing persists the plaintext.

## Encryption format & key strategy

- **AES-256-GCM** (authenticated encryption, Node `crypto`). The GCM tag detects tampering; the format
  version and key id are bound as **additional authenticated data**, so neither can be altered.
- Envelope (the only secret-bearing value stored): a versioned string
  **`av1.<keyId>.<iv>.<tag>.<ciphertext>`** (all base64). Opaque and useless without the key.
- **Key source — outside the database.** Priority: `AUDIVRA_SECRET_KEY_FILE` (a JSON keyring, for rotation),
  then `AUDIVRA_SECRET_KEY` (the active key, base64/hex 32 bytes — set from a real secrets source in
  production), then — only when neither is set (local development) — a persisted dev key at
  `.local-data/security/.vault-key.json` (git-ignored, mode 0600). The dev key is generated **once** and
  never regenerated on restart, so stored secrets stay recoverable.
- **Key id** is a non-secret fingerprint (first 12 hex of the key's SHA-256), stored with each value.
- **Missing/invalid key fails safely:** the keyring is `unavailable`/`misconfigured`, `seal`/`resolve`
  raise an explicit error, and nothing is reset. Non-secret Website-Audit and security data stay readable.
- **Rotation path:** a keyring can hold several keys (each by id). To rotate: add the new key as the
  `active` one in the keyring while keeping the old key for decryption; new values seal under the new key,
  old values still open under the old. A background re-seal (decrypt-with-old → encrypt-with-active) can
  then migrate rows at leisure. No complex KMS is required now, and the versioned envelope keeps future
  rotation possible.

## Identity integration

A credential has an opaque `ref` (unique per engagement); a Step-1 identity's `credentialRef` points at it,
and the vault resolves by `(engagement, ref)`. An identity may have no credential; a credential may be
replaced (the old ciphertext is overwritten and unrecoverable), revoked or deleted — none of which touches
the identity declaration. The **graph** keeps only `credentialConfigured: true/false` on an identity node,
never the secret or the reference (Step 1 invariant preserved).

## Session secret boundary

`security_sessions` holds session **metadata** (identity, environment, auth method, status, timestamps)
separately from optional **sealed material** (cookies/tokens, encrypted exactly like a credential; null
until a session is established in Step 3). Lifecycle: `pending → active → expired | revoked | invalid`.
Revoking a session drops its sealed material. Metadata exposes only `material: true/false`.

## Redaction / leakage guarantees

- Secrets never enter domain state: they are not in declarations, the graph, observations, evidence,
  events, snapshots or AI context — by construction, because only the vault ever holds them.
- `redactSensitive` was hardened so a **material-bearing key's whole subtree** is redacted (a cookie's
  `value`, a nested token), while structural containers that merely match a suffix (`authorization` =
  `{ state, authorizationIds }`, `sessionId`) keep their non-secret fields. Every security record passes
  through it before it is logged, stored, returned or shown to a model.
- `SensitiveValue` wraps every resolved secret; pino logging redacts `password/token/secret/cookie/…`
  paths; Fastify request-body logging is disabled; Zod validation errors carry the field path, never the
  value. A **canary leakage test** proves a distinctive marker reaches none of: API JSON, security events,
  graph rows/nodes, observations, evidence, declarations, AI context, or application logs.

## API

Management (the local user): `POST …/engagements/:id/credentials` (set), `PUT …/credentials/:id` (replace),
`POST …/credentials/:id/revoke`, `DELETE …/credentials/:id`. Reads: `GET …/engagements/:id/credentials`,
`GET …/credentials/:id` (metadata only), `GET …/engagements/:id/sessions`, `GET …/sessions/:id`,
`GET /api/security/vault` (health). A successful write answers with metadata (`configured: true`). There is
**no** endpoint that returns a plaintext secret. UI for the Security Identity area is deferred to the step
that builds that area (Step 1 added no Identities UI); the vault health and `credentialConfigured` are
already surfaced through existing views.

## Backup implications

Encrypted credential/session rows live in ordinary database backups and are useless without the separate
key, which Audivra never includes in DB backups or exports. Restore both the database and the configured
key to recover secrets; restoring the database alone leaves credentials unreadable (and safe).

## Limitations

- Node cannot guarantee plaintext is scrubbed from memory. The vault minimizes plaintext lifetime
  (decrypt only at the point of use, wrapped in `SensitiveValue`, never cached globally), but this is best
  effort, stated honestly.
- Credentials are immutable except through the explicit replace/revoke/delete operations; there is no edit
  of non-secret metadata in isolation yet.
- Session establishment, auth injection and refresh are Step 3; Step 2 only prepares the boundary.
- `redactSensitive` remains a safety net, not a vault — ordinary-looking text is not detected; secrets are
  protected by never leaving the vault, not by redaction alone.
