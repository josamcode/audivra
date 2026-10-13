# Identity-aware execution & session establishment (Phase 5 Step 3)

Audivra can run a capability **as a declared identity**: it establishes an authenticated session on the
server using that identity's vault credential, then the trusted runtime injects the session's material into
the capability's scoped HTTP client. The AI never receives a raw credential, never names one, and never
performs the authentication — establishing a session is a configuration action (a person or Audivra).

```
identity reference ─► trusted credential resolution ─► authentication / session establishment
   (Step 1)                 (vault, Step 2)              (api-token / form-login / preestablished)
                                                               │
                                                               ▼
                                                   sealed session material (vault)
                                                               │  session reference
                                                               ▼
   capability request (identityRef + sessionRef) ─► broker validates the session (no secret touched)
                                                               │
                                                               ▼
   trusted runtime resolves material ─► injects it SAME-ORIGIN only ─► capability runs ─►
       evidence & observations tagged with identity/session ─► graph AUTHENTICATES_AS
```

This step adds authentication, session establishment, identity-aware execution and the identity UI. It does
**not** add differential-authorization analysis, business-logic comparison or planning — those are Step 4.

## Where it lives

| Concern | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-credentials.ts` (`AuthFlow`, `EstablishSessionInput`, `AuthFailureKind`, `SessionEstablishmentResult`, `IdentityCoverageItem`) |
| Capability identity metadata | `packages/contracts/src/security.ts` (`SecurityCapabilityMetadata.identity`, `capabilityIdentity()`) |
| Decision-time validation | `packages/security/src/session/auth-resolver.ts` (`VaultAuthResolver`, `ExecutionAuthResolver`, `sessionHeaders`) |
| Establishment | `packages/security/src/session/establish.ts` (`SessionEstablishmentService`) |
| Browser login driver | `packages/security/src/session/browser-login.ts` (Playwright, lazily loaded) |
| Identity-aware capability | `packages/security/src/capabilities/identity-http.ts` (`discovery.identity-http`) |
| Same-origin injection | `packages/security/src/http-client.ts` (`auth` option) |
| Graph projection | `packages/security/src/graph/project-domain.ts` (`projectSessionsInto`, `AUTHENTICATES_AS`) |
| Coverage | `packages/security/src/session/coverage.ts` (`identityCoverage`) |
| API | `apps/server/src/routes-credentials.ts` (establish / revoke / coverage) |
| Worker / durable broker | `apps/worker/src/security-executions.ts`, `packages/security/src/execution/submit.ts` |
| UI | `apps/web/src/features/security/identities-tab.tsx` |

No new migration: sessions already have their table and encrypted material column from Step 2 (`migrations/0008_security_secrets.sql`). This step only establishes/validates/resolves them.

## Authentication flows

`AuthFlow` is a reviewed, typed definition — never target-controlled text, never AI-authored. The secret
material comes from the vault via the identity's `credentialRef`; only non-secret flow configuration lives in
the flow.

| Flow | Credential | What establishment does |
| --- | --- | --- |
| `anonymous` | — | No session; the capability runs unauthenticated (unchanged behaviour). |
| `api-token` | `bearer-token` / `api-token` / `custom-header-secret` | Builds the `authorization: Bearer …` or the named header; optional `validateUrl` confirms it. |
| `preestablished` | `session-cookie-set` (or bearer/header) | Uses stored cookies/token directly; optional `validateUrl` confirms it. |
| `form-login` | `username-password` | Headless Chromium loads `loginUrl`, types the credential into the declared selectors, waits for the success signal, extracts the cookies. |

A successful establishment seals the resulting material (cookies / token / headers) in the vault as an
**active** session and emits `session.established`. Any failure returns a precise `AuthFailureKind`
(`credential-missing`, `credential-revoked`, `authentication-failed`, `session-invalid`, `session-expired`,
`auth-flow-unsupported`, `vault-unavailable`, `identity-unknown`) and emits `session.validation-failed` —
never a generic error, never a stored session.

## The secret boundary during execution

- A capability declares its identity needs with `metadata.identity` (`supportsIdentity`, `requiresIdentity`,
  `supportsAnonymous`, `requiresSession`). Omitted ⇒ anonymous-only, so every existing capability is
  unchanged. `capabilityIdentity()` returns the effective policy.
- At **decision** time the broker validates the referenced `sessionRef`/`identityRef` against the engagement
  and the session's status/expiry **without touching any secret** (`VaultAuthResolver.validate`). A session
  that does not belong to the engagement/identity/environment, or that is revoked/expired/invalid, is refused
  with a precise `identity.<kind>` check; a reference on a capability that does not support identity is
  refused (`identity.not-supported`).
- At **execution** time the trusted runtime resolves the material (`VaultAuthResolver.resolve`) and hands the
  scoped HTTP client an `auth` block. The client attaches those headers **only to requests whose origin
  matches the session's origin** — a session's cookies/token never leak to another host, even across an
  in-scope redirect. The capability code never sees the material, and nothing it is given carries a secret.
- Evidence and observations are stamped with `identityRef`/`sessionRef` by the handle layer (from the trusted
  snapshot), so later analysis knows which identity saw what. The secret value itself never reaches evidence,
  observations, events, the graph, the AI context or the logs (proved by the canary test).

## Graph: `AUTHENTICATES_AS`

Established sessions project into the graph as `session` nodes and `AUTHENTICATES_AS` edges
(`session → identity`) with `user-declaration` provenance. The edge's `active` attribute and the node's
`status` reflect the live lifecycle: a revoked or expired session keeps its edge (it *did* authenticate) but
with `active:false`. The projection is a deterministic, idempotent function of the stored sessions — a
session for an undeclared identity produces no edge (`UNKNOWN != FALSE`).

## API

| Method & path | Purpose |
| --- | --- |
| `POST /api/security/engagements/:id/sessions/establish` | Establish (or reuse) a session — body is `EstablishSessionInput`; returns `SessionEstablishmentResult`. |
| `POST /api/security/sessions/:sessionId/revoke` | Revoke a session (drops its material; the graph edge goes inactive). |
| `GET /api/security/engagements/:id/identities/coverage` | Per-identity coverage (credential/session/observed), no secrets. |

There is deliberately **no** endpoint that returns session material. Establishment and resolution run only in
trusted server/worker code, and every response is redacted.

## Degraded operation

If the vault is unavailable, establishment fails with `vault-unavailable` and identity-aware execution refuses
safely — anonymous capabilities keep running unchanged. A session established with a given key still resolves
after a worker restart with the same key.

## Tests

- Unit (`packages/security/test/identity-execution.test.ts`): `sessionHeaders`, `capabilityIdentity`, session
  graph projection, strictly same-origin injection, and the broker's identity decisions.
- Integration (`apps/server/test/security-identity.integration.test.ts`): the full lifecycle (establish →
  authenticate → tagged evidence/observations → `AUTHENTICATES_AS` → revoke → refuse), A/B isolation with
  concurrency, anonymous unchanged, worker restart, vault-unavailable degradation, reuse, precise failure
  kinds, the form-login flow (injected driver, plus a real headless-browser run when Chromium is present), the
  canary no-leak assertion, and the coverage API.
