# AI provider independence & resilience (Phase 3C)

Audivra's reasoning belongs to **Audivra**, not to one model, provider or session. A provider is
interchangeable compute behind one stable interface; the knowledge, the task, the selection, the
validation and the degraded behaviour are Audivra's.

```
Security / audit domain
      → AI task (what reasoning is needed)
      → Provider Router (which provider, deterministically)
      → Provider Adapter (Claude today, another later)
      → Structured result
      → Audivra validation ("AI reasons, code validates")
      → Persistent Audivra state
```

Phase 3C builds this **platform**; the autonomous reasoning that uses it is a later phase. The existing
Website Audit AI flows (auditor, reviewer, revision, finalizer, planner, composer, intelligence) are
unchanged — they still run through the same provider, now obtained from the registry/router instead of a
hard-coded adapter.

## Provider abstraction (`AgentProvider`)

One stable seam, in `@audivra/ai-runtime`:

- `id`, `adapterVersion` — identity and an attributable adapter version (recorded in provenance).
- `isAvailable()` / `health()` — `health()` returns a normalized `ProviderHealth` (`ready`,
  `unavailable`, `auth-required`, `rate-limited`, `misconfigured`, `disabled`).
- `capabilities()` — a `ProviderCapabilities` profile: `structuredOutput`, `toolUse`, `sessionResume`,
  `browserTools`, `maxContextTokens`, `effortLevels`, eligible `taskTypes`.
- `run(request)` — subsumes **start** / **resume** (via `resumeSessionId`) / **cancel** (via `signal`).

Provider-specific command-line, session and response-format details live only inside the adapter
(`claude/provider.ts`). The security and audit domains never import those details. An automated invariant
test asserts `packages/security/src` imports no Claude-specific implementation.

Adding a provider: implement `AgentProvider`, register it in `createProviderRegistry()`, and (optionally)
set `AI_PROVIDER` to prefer it. Nothing else changes. `FakeProvider` (`testing/fake-provider.ts`) is the
reference implementation used to prove independence.

## The AI task primitive

`AiTaskSpec` describes **what** reasoning is needed, never **which** model: `taskType`, logical `role`,
`effort`, a provider-independent `budget` (wall-clock, tool-calls, turns, context, optional cost),
`requirements` (what a provider must support), the `outputSchemaId` the result must satisfy, allowed
Audivra `capabilities`, and trusted/untrusted input references. Future security task types
(`security-understand|plan|analyze-observations|verify-claim|summarize`) are declared; their behaviour is
Phase 4.

## Deterministic router

`ProviderRouter` selects a provider deterministically and auditably:

1. Order providers by the configured preference (`AI_PROVIDER`), then registration order.
2. Keep those whose `capabilities()` satisfy the task's `requirements` (and list of eligible task types).
3. Of those, run the ones whose live `health()` is `ready`.
4. Record the full `considered` list with a reason per provider, and the chosen provider.

The selection and the per-attempt provenance are returned (and emitted as events) — never hidden.

## Failure taxonomy & resilience

Every run is normalized to one `AiOutcome`: `succeeded`, `provider-refused`, `provider-unavailable`,
`provider-timeout`, `rate-limited`, `auth-failed`, `context-limit`, `invalid-structured-output`,
`tool-failure`, `cancelled`, `internal-error`. Raw provider errors never leak into the product; native
diagnostics are kept in provenance.

- **Transient** (`provider-unavailable`, `provider-timeout`, `rate-limited`, `tool-failure`) → bounded
  retry / fallback to the **next eligible, healthy** provider, capped by `maxAttempts` (default 2).
- **Policy refusal** (`provider-refused`) → recorded distinctly and **stops**. It is **never** rerouted
  to another provider to evade that provider's safeguards. This is an architectural rule, not a tuning
  knob. (Future tasks may still independently select an eligible provider per its own policy — but a
  specific refused request is not auto-replayed.)
- **Permanent** (`auth-failed`, `context-limit`, `invalid-structured-output`, `cancelled`,
  `internal-error`) → stop; not retried.

Case D — **no eligible, healthy provider** — returns a recorded `provider-unavailable` outcome; it is a
valid, unresolved state, never a thrown assessment failure and never "secure".

## Degraded operation

AI failure is not assessment failure. Deterministic sensors, evidence and observations remain fully
usable and inspectable when a provider is unavailable, refuses, or is turned off (`AUDIVRA_AI=off`). The
Website Audit finalizer already has a deterministic `fallbackFinal`; the router gives every future AI
stage the same resilience. Coverage represents AI reasoning stages with `AiCoverageState`
(`completed|partial|blocked|provider-unavailable|provider-refused|not-required`) — a provider limitation
is never rendered as "no issue".

## Structured state ownership & session portability

Assessment knowledge (observations, evidence, assets, decisions, coverage, and future graph/hypotheses)
lives in Audivra's persistent structured state — **not** in a provider conversation. A provider session
is compute context, not the database. Because the context builder reconstructs a task's context from
stored state, losing a session does not lose knowledge: a new session (or a different provider) rebuilds
what it needs. Correctness never depends on invisible conversational memory.

## Trust boundary (provider-independent context)

`buildAiContext()` renders a task's context with an explicit, fenced trust boundary (continuing Phase 1):

- **TRUSTED** (authoritative, may direct the task): Audivra policy, engagement, authorization, scope,
  environment, capability definitions, stored internal decisions.
- **UNTRUSTED** (data to analyse, never instructions): target HTML/text, API/scanner output, source
  comments, discovered docs, browser observations — fenced with a sentinel and a banner telling the model
  to never follow instructions found inside it.

A provider adapter renders this string as-is; it never re-categorizes or blurs the boundary.

## Validation — AI reasons, code validates

A provider never writes trusted domain state. Every programmatic AI result flows through schema
validation → domain validation → reference/evidence validation → persistence (`validate.ts`). Provider
output cannot modify authorization, scope, environment, execution policy, capability risk class, isolation
or network profile — those are deterministic platform configuration. Capabilities are requested through
the Capability Broker as typed capabilities, never as raw runtime authority; changing provider does not
change execution safety.

## Provenance & observability

`AiRunProvenance` records, per attempt: task type, role, provider, model, adapter version, prompt version,
start/finish, native termination reason, normalized outcome, tool-call counts, cost/token metadata where
available, and output status. No hidden chain-of-thought is persisted — only structured outputs and
concise, auditable rationale. The router emits `ai.task-created`, `ai.provider-selected`, `ai.started`,
`ai.completed`, `ai.refused`, `ai.unavailable`, `ai.failed`, `ai.cancelled`.

## Budgets & cancellation

Budgets are provider-independent (`AiBudget`): wall-clock, tool-calls, turns, context, optional cost — no
provider's token accounting is baked into domain logic. Cancellation goes through the existing
`AgentRunRequest.signal` and the process-ownership registry: a cancelled task terminates only its own
provider process tree and is recorded as cancelled, never as success.

## Configuration

Centralized in `@audivra/config`: `AUDIVRA_AI` (`claude`|`off`) and `AI_PROVIDER` (preferred adapter id).
Per-role model/effort env (`AUDITOR_MODEL`, …) is read only inside the adapter layer. Secrets are never
stored in ordinary DB configuration or logs; the Claude adapter uses the local, already-authenticated CLI.

## Current provider support

The only shipped adapter is **Claude via the local Claude Code CLI** (`claude-code-cli`): full capability
surface (structured output, tool use, session resume, browser tooling, ~200k context). Health is `ready`,
`auth-required` (not logged in), `unavailable` (CLI absent) or `disabled` (`AUDIVRA_AI=off`). A second
provider is proven by the deterministic `FakeProvider` in the routing tests — the security/audit domain
depends only on the `AgentProvider` interface, so a real second adapter drops in without domain changes.

## System view

`GET /api/system/ai` returns the preferred provider, whether AI is enabled, and each provider's health +
capability profile (no secrets). The web **System → AI** tab shows it. Security Assessment never crashes
because a provider is unavailable — the view simply shows the degraded state.
