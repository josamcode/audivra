# Security engagements (Phase 1: the control plane)

Audivra is growing from website auditing toward authorized security testing. Phase 1 is the
deterministic control plane that every later security capability depends on:

```
Engagement → Authorization → Scope → Environment policy → Capability → Decision → Execution boundary → Evidence + audit trail
```

> **Phase 1 does not yet provide autonomous active security testing.** It defines, verifies and
> enforces *who may assess what, where and how*. The only capability is a passive, read-only
> observation (`discovery.http-observe`) that exists to prove the pipeline end to end against local
> fixtures. There is no "run a test" action in the UI or the API.
>
> **Phase 2A** adds the durable execution runtime that carries out allowed requests — persisted executions with an
> immutable trusted snapshot, the pg-boss worker, cancellation, timeouts, limits and crash recovery. **Phase 2B** adds
> the isolated container backend for capabilities that declare it. Neither runs security tests, and there is no
> network egress layer yet; see [security-executions.md](security-executions.md).

The rule underneath everything:

> A model may *propose* an action. Deterministic Audivra code decides whether it is allowed.

Website Audits are unaffected: they neither need nor consult security engagements.

## Where it lives

| Layer | Location |
| --- | --- |
| Contracts (Zod) | `packages/contracts/src/security*.ts`, `net.ts` (IP/CIDR/host parsing), `redaction.ts` |
| Persistence | `packages/database` — tables `security_engagements`, `security_authorizations`, `security_events`; engagement-owned rows in `evidence`; migration `0003_security_foundation` |
| Engine | `packages/security` — scope engine, authorization, policy, readiness, registry, broker, scoped HTTP client, resources, trust boundary, agent gateway, service |
| API | `apps/server/src/routes-security.ts` (`/api/security/*`) |
| UI | `apps/web` — *Security* in the sidebar: list, new engagement, engagement (Overview · Scope · Authorization · Policy · Audit trail) |
| Fixture | `fixtures/scope/server.mjs` — allowed routes, in/out-of-scope redirects, alternate port, other host names |
| Executions (Phase 2A) | table `security_executions`, `packages/security/src/execution/`, worker `apps/worker/src/security-executions.ts` — see [security-executions.md](security-executions.md) |

## Security engagement

An engagement (`security_engagements`) is an authorized assessment of a target. It holds the target URL
and its `site_key` (the same site identity as Website Audits, so the UI can link to the site's audits),
the environment, the pinned policy profile (key **and** version), the scope manifest with its version and
content hash, a `config_version`, notes, the creator and timestamps.

Status is a label for people, never a permission:

- `draft` → `authorization-pending` → `ready` are **recomputed from requirements** after every change.
- `active`, `paused`, `completed`, `cancelled` are explicit lifecycle actions; activation and resumption
  require the engagement to be ready at that moment. Completed/cancelled engagements are frozen.
- `invalid` is reserved for configurations that can no longer be used.

`config_version` increases with every change to environment, policy profile, scope, authorization or
lifecycle; every decision records the version it was made against.

## Authorization

Entering a URL is not authorization. Authorization records (`security_authorizations`) say which subject
(host, optional port, optional subdomains) was verified, by which method, when, until when, and with what
evidence (metadata). `expired` is derived from `expires_at` on every read; revocation is recorded.

| Method | State in Phase 1 |
| --- | --- |
| `local-development` | **Implemented.** Verifies the subject is this machine: a loopback IP literal or a `localhost` name that resolves only to loopback addresses, one port at a time, valid for 7 days. It cannot authorize anything remote. |
| `dns-txt`, `well-known-file`, `repository`, `deployment`, `manual-approval` | Modelled and listed, reported as **not available**; requests are refused with HTTP 422. Nothing is ever marked verified without a real check. |

**Invariant:** a capability needs a valid authorization when it declares so, and *always* when it is
above `passive` or not `read-only` (`authorizationRequiredFor`). The registry refuses capabilities that
understate this, and the broker enforces it regardless. Readiness additionally requires every scope target
to be covered by a verified, unexpired authorization.

## Scope manifest and scope engine

The manifest (`ScopeManifest`, `schemaVersion: 1`) is strict: unknown keys are rejected, and every value is
normalized on parse (lower-case punycode hosts, canonical IP text, normalized path prefixes). Fields:
hosts (with optional subdomains, ports, schemes, path prefixes), network addresses and CIDR blocks (at
most 65,536 addresses per block), protocols, ports, exclusions (hosts, `*.subdomain` patterns, paths,
addresses, blocks — exclusions always win), explicitly authorized third-party dependencies, the redirect
policy and hop limit, DNS pinning, an optional testing window, requested limits and requested risk /
mutation classes and external integrations.

The scope engine (`packages/security/src/scope.ts`) is the only place scope is decided:

- `evaluateUrl` — scheme, credentials-in-URL, exclusions, host rules (`example.com` never covers
  `www.example.com` or any other subdomain unless `includeSubdomains`), ports (a default port only for
  its own scheme), segment-aware path prefixes (encoded separators are refused), network addresses and
  blocks, dependencies, then third party (denied).
- `evaluateRedirect` — resolves the `Location` against the redirecting URL and evaluates it as an
  independent destination; refuses HTTPS → HTTP downgrades and excess hops.
- `evaluateNetworkDestination` — DNS awareness: every resolved address of a destination must pass.
  Non-public addresses (loopback, private, link-local, unique-local, …) are accepted only when listed in
  the scope's networks, when they are the target itself, or for `localhost` names; unspecified and
  multicast addresses never. IPv4-mapped, NAT64 and 6to4 forms are judged by their embedded IPv4 address.
- `evaluateTarget` — host/port targets.

Every result is structured: `decision`, a stable `rule`, a human `reason`, the classification
(`primary`, `dependency`, `third-party`, `excluded`, `invalid`), the normalized destination with resolved
addresses and categories, and the limitations of the check.

## Environment and risk policy

Environments: `production`, `staging`, `isolated-lab`. Capabilities declare a **risk class**
(`passive`, `low-impact`, `state-changing`, `high-impact`, `destructive`) and a **mutation class**
(`read-only`, `transient-state`, `reversible-write`, `irreversible-write`).

Policy profiles are versioned code assets (`packages/contracts/src/security-policy.ts`), like audit
templates — not environment variables. For each environment a profile marks every class `allow`,
`bounded` (allowed under stricter limits), `opt-in` (only if the engagement selects it) or `deny`, and
sets ceilings for every execution limit. Engagements pin a profile version, so a later change to a
profile never rewrites what an existing engagement allows.

| `standard` v1 | passive | low impact | state changing | high impact | destructive |
| --- | --- | --- | --- | --- | --- |
| production | allow | bounded | opt-in | deny | deny |
| staging | allow | allow | opt-in | opt-in | deny |
| isolated lab | allow | allow | allow | opt-in | opt-in |

`observe-only` v1 permits passive, read-only capabilities only, in every environment. While no
environment is chosen, policy is evaluated as production and nothing can execute.

`effectivePolicy()` combines profile and engagement (the engagement can only narrow, `deny` always wins,
requested limits are clamped to the ceilings) and reports blocking issues; `evaluateCapabilityPolicy()`
decides one capability. There are no environment checks anywhere else.

| What | Where it belongs |
| --- | --- |
| Risk / mutation vocabulary, profiles and their ceilings | code (versioned) |
| Free-disk threshold for executions (`SECURITY_MIN_FREE_DISK_MB`, default 2048) | environment configuration (operational, not policy) |
| Environment, scope, requested classes and limits, testing window | engagement configuration |

## Capabilities, registry and broker

A capability describes *what* Audivra can do (`SecurityCapabilityMetadata`: id, family, risk and mutation
class, supported environments, authorization/identity/network/external-integration needs, cancellation,
rate-limit class, resource profile, timeout profile, evidence types, implementation id), separately from
*how* (`CapabilityImplementation`: strict input schema, `targets(input)`, `execute`). The registry
validates metadata, refuses duplicate ids and understated authorization needs, and freezes metadata.

The **Capability Broker** (`packages/security/src/broker.ts`) is the only path to execution:

```
request (engagement, capability, input, actor — nothing else)
  → capability registered → input valid (strict) → engagement loaded
  → readiness (lifecycle, environment, scope, policy, testing window) → engagement authorized
  → scope of every target (+ resolved addresses for network capabilities)
  → destination authorization → environment / risk / mutation policy → resources
  → decision (persisted, fully explained)
  → allowed only: frozen execution context + handles → executor → evidence + events
```

A request has no field for authorization, scope, environment or policy — they are loaded from the
engagement, so neither a caller nor a model can supply them. A denied request never reaches its executor
(tests assert this for every denial class).

### Trusted execution context and handles

The executor receives a deeply frozen `SecurityExecutionContext` built from persisted data only
(execution and correlation ids, engagement, config version, environment, authorization state and ids,
scope version/hash/manifest, policy, capability, effective limits, actor, allowed targets) and handles:

- `http` — the **scoped HTTP client**: safe methods only; every request and redirect hop is scope-checked,
  its host resolved and the addresses evaluated, and the connection is pinned to an evaluated address
  (no second DNS lookup); request count, rate and concurrency budgets are enforced; every attempt is logged.
- `workspace` — `.local-data/security/<engagement>/executions/<execution>/` with `inputs/`, `outputs/`,
  `artifacts/` and `tmp/` areas; every path is confined to the execution directory.
- `evidence` — records evidence with provenance filled in by the broker.
- `processes` — starts a process owned by the execution: registered by PID + creation time under the
  execution id, confined to the workspace, counted against the process limit and terminated exactly (never by name
  or pattern) when it is cancelled or times out. (`processOwner` is the same ownership metadata for `runProcess`.)

### Limits and resources

Effective limits (max requests, requests per second, concurrency, execution timeout, response size,
artifact budget) flow profile → engagement → decision → context → HTTP client. Before execution the
broker checks free disk space on the data volume, the engagement's artifact budget, and — for
capabilities that need a container image — that the image is present. **Images are never pulled
implicitly.**

## Audit trail and evidence

`security_events` is append-only (a database trigger rejects UPDATE and DELETE). It records
`engagement.created`, `engagement.updated`, `environment.changed`, `scope.changed` (with the full
manifest, version and hash), `policy.changed`, `authorization.requested`, `authorization.changed`,
`lifecycle.changed` and, per capability request, `capability.requested`, `capability.allowed` /
`capability.denied` (with the complete `PolicyDecision`: every check, rule and reason, the scope
evaluations, authorization state, policy and limits), `capability.started`, `capability.completed`,
`capability.failed`, `capability.cancelled`, and for durable executions the `execution.*` lifecycle events
([security-executions.md](security-executions.md#events)).

Security evidence uses the existing `evidence` table: a row is owned by exactly one audit **or** one
engagement (check constraint `evidence_single_owner`), engagement evidence has its own `EV-n` sequence and
a `security_provenance` (engagement, execution, correlation, capability and implementation, the id of
the allowing decision event, environment, scope version and hash, config version, policy profile,
authorization ids, sensitivity, redaction count). A denial is an event, never evidence about the target.

## Trust boundary for model context

`packages/security/src/trust.ts` tags every piece of model context as **trusted** (platform policy,
engagement configuration, authorization, scope, capability metadata) or **untrusted** (target HTML and
text, API responses, source comments, scanner output, browser observations, capability output).
Untrusted content is rendered inside nonce-tagged envelopes with envelope markers escaped. This is
provenance, not a defence by itself: the guarantee is structural — policy inputs are only read from
persisted records, and model output reaches the platform only as a capability *request* through the
`AgentCapabilityGateway`, whose arguments may contain `capabilityId`, `input` and `rationale` and nothing
else (other fields reject the request and the rejection is recorded). Configuration changes from an
`agent` actor are refused by the service.

**Existing direct execution paths that security capabilities must not use:** the auditor's Bash tool, the
`audit` and `browser` MCP servers, `runProcess` called outside a capability executor, and the baseline
scanners (`packages/audit-core/src/baseline/scanners.ts`). They serve Website Audits under the passive
policy in [security.md](security.md) and are unchanged; a future security MCP tool must call the gateway.

## Secrets

`SensitiveValue` wraps secrets so JSON, string conversion and Node's inspector print `[REDACTED]`.
`redactSensitive()` replaces sensitive fields (password, token, API key, authorization, cookie, …) and
recognizable secrets in text (bearer/basic credentials, JWTs, URL user-info, private keys, common key
formats, secret query parameters). It is applied when security events, decisions, authorization records
and evidence are written, to every `/api/security` response, to error messages and to model context.
Logs redact credential fields structurally (pino `redact`). The credential vault itself is future work.

## Guarantees today vs. later

| Guarantee | Today (Phase 1) | Needs the later isolation / mediated-egress layer |
| --- | --- | --- |
| Denied requests never reach an executor | Enforced in code, tested for every denial class | — |
| Authorization, scope, environment, policy cannot come from a model | Enforced: no request field carries them; strict schemas; agent actors refused | — |
| Every network request of a capability is in scope, incl. redirects and resolved addresses | Enforced **for code using the scoped HTTP client**, with DNS-pinned connections | OS/network-level enforcement for anything that opens its own sockets (child processes, containers, browsers) |
| Processes are terminated exactly | Enforced by PID + creation time / exact container names | Sandboxed execution |
| Third parties never targeted implicitly | Enforced by the scope engine | Egress filtering of browser sub-resources |
| Audit trail cannot be edited | Database trigger (a database owner could still drop it) | Externally anchored, signed log |

## Known limitations

- Only local development authorization exists; real-world targets cannot be authorized yet, so nothing
  beyond the local fixtures can become ready.
- The control plane is application-level. A capability implementation that ignores the scoped client
  could still reach the network; capabilities are reviewed code registered explicitly, but true
  containment needs the isolation layer.
- Public-suffix rules are approximated (a single-label name cannot include subdomains); a full public
  suffix list is not bundled.
- Durable executions (Phase 2A) run through the `security-execution` pg-boss queue; `CapabilityBroker.execute()`
  remains the in-process path for tests and the agent gateway. See [security-executions.md](security-executions.md).
- Audivra is single-user and local: the actor for configuration changes is the local user.
