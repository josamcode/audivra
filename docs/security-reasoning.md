# Security Graph and hypothesis-driven reasoning (Phase 4)

Phase 4 turns Audivra from a set of sensors into a reasoning system — without giving reasoning any
execution authority. **The AI reasons; Audivra stores and validates; the Capability Broker decides.**

```
stored observations / evidence
      → deterministic graph projector ─► Security Graph (typed facts + provenance + knowledge gaps)
      → AI researcher (hypotheses) ─► deterministic validation, dedupe ─► AI verifier (review)
      → deterministic ranking (expected information gain)
      → AI planner (typed next capability) ─► action validation ─► broker preflight
      → [investigate mode] broker.submit ─► durable execution ─► new observations
      → graph projection ─► deterministic evidence checks ─► hypothesis state
```

It does **not** build attack paths, business-logic testing, authenticated/multi-step validation or
verified findings — those are later phases. A hypothesis is a claim to investigate; a `confirmed-signal`
is an independently corroborated signal, never a verified vulnerability.

## Where it lives

| Concern | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-graph.ts`, `security-reasoning.ts` |
| Schema + migration | `packages/database/src/schema.ts`, `migrations/0006_security_graph_reasoning.sql` (additive) |
| Repositories | `packages/database/src/repo/security-graph.ts`, `security-reasoning.ts` |
| Graph | `packages/security/src/graph/` — `identity.ts`, `project.ts` (pure), `derive.ts` (pure), `projector.ts`, `service.ts` |
| Reasoning | `packages/security/src/reasoning/` — `ai.ts` (port + task specs), `knowledge.ts`, `context.ts`, `hypotheses.ts`, `ranking.ts`, `planning.ts`, `engine.ts`, `service.ts` |
| AI adapter | `packages/ai-runtime/src/reasoning.ts` (router-backed), `testing/scripted-reasoner.ts` (deterministic provider); prompts `prompts/security-{researcher,verifier,planner}-system.md` |
| Worker | `apps/worker/src/security-reasoning.ts` (graph projection after executions, the `security-reasoning` queue) |
| API | `apps/server/src/routes-reasoning.ts` |
| UI | `apps/web/src/features/security/graph-tab.tsx`, `hypotheses-tab.tsx` (+ Knowledge panel on the overview) |
| Benchmark | `apps/worker/src/reasoning-benchmark.ts`, `pnpm benchmark:reasoning` |

## Data model (migration 0006)

Eight tables, each with a distinct access pattern; PostgreSQL only (no graph database — the graph is
small per engagement and every query is bounded):

| Table | Holds | Key indexes |
| --- | --- | --- |
| `security_graph_nodes` | typed entities | unique `(engagement, key)`; `(engagement, kind)`; `(engagement, status)` |
| `security_graph_edges` | typed relationships | unique `(engagement, key)`; `from_node_id`; `to_node_id`; `(engagement, type)` |
| `security_graph_provenance` | one row per (fact, source) — *why* a fact is believed | unique `(subject_type, subject_id, source, source_ref)`; `subject_id`; `(engagement, observation_id)` |
| `security_graph_gaps` | explicit unknowns, opened/resolved over time | unique `(engagement, kind, subject_key)`; `(engagement, status)` |
| `security_hypotheses` | persistent hypotheses (checks, ranking, history) | unique `(engagement, dedupe_key)`; `(engagement, status)`; `(engagement, priority)` |
| `security_hypothesis_links` | affected entities, supporting/contradicting observations, gaps | unique `(hypothesis, role, target_type, target_id)`; `(engagement, target_type, target_id)` |
| `security_reasoning_runs` | persisted, bounded loop state (stage, budget, usage, lease, decisions, AI provenance) | `(engagement, created_at)`; `status` |
| `security_reasoning_actions` | typed next-capability proposals and what became of them | `(engagement, created_at)`; `hypothesis_id`; `execution_id`; `(engagement, action_key)` |

Observations and evidence are not duplicated as nodes: `OBSERVED_BY` / `SUPPORTED_BY` are the provenance
rows (each carries the observation id, evidence refs, execution ids, capabilities and tools).

## The Security Graph

**Entity kinds** (only those with a Phase 4 use case): `host`, `endpoint`, `api-operation`, `parameter`,
`technology`, `signal` (a finding placeholder: a scanner/contract/source signal, not a finding),
`source-file`. Identity, role, tenant, session, resource and business-action kinds wait for authenticated
testing (Phase 5).

**Relationship types**: `HOSTS` (host→endpoint), `EXPOSES` (host→api-operation), `READS` (endpoint or
operation→parameter), `CALLS` (page→form action), `BELONGS_TO` (endpoint→the API operation whose path
template it matches), `DEPENDS_ON` (host→technology), `REDIRECTS_TO` (endpoint→endpoint), `AFFECTS`
(signal→endpoint / operation / source file / host).

### Projection (deterministic, no AI)

`projectObservations()` is a pure function: every stored observation in, desired facts out. The same
observations always produce the same graph, in any order. Rules per observation type: responses,
headers, technologies, crawled endpoints (query parameters → `parameter` + `READS`), forms (`CALLS` +
form parameters), redirects (`REDIRECTS_TO`, destination recorded but never contacted), API operations
(`EXPOSES`, path parameters), API validation/workflow signals, web signals, source findings. Rule-based
facts carry `derivation` provenance naming the rule: a technology parsed from the first `Server` product
token, a technology extracted by the server-banner template, an endpoint matching an API path template.

The `GraphProjector` then runs **inside a per-engagement advisory lock**: load observations, executions and
the stored graph → project → derive → diff → insert new facts / update changed ones / leave the rest
untouched. A repeated projection over the same observations writes nothing and emits no event (proven in
unit, integration and benchmark tests). The worker projects after every execution settles; the API
offers an idempotent rebuild; every reasoning iteration starts with one.

### Identity, merge and deduplication

Deterministic keys (`graph/identity.ts`): `host:<origin>`, `endpoint:<origin><path>` (query, fragment and
trailing slash dropped; methods are attributes), `api-operation:<origin><base>|<METHOD> <template>`,
`parameter:<owner>|<location>:<name>`, `technology:<name>` (version stripped; versions are attributes),
`signal:<type>:<subject>@<asset>`, `source-file:<path>`, edges `TYPE|from|to`. httpx, katana and
Schemathesis reporting the same endpoint/operation merge onto one fact; each contribution stays as its
own provenance row. AI never decides identity.

### Provenance, basis and confidence

Every fact answers *why does Audivra believe this?* through provenance with a **source** (`observation`,
`derivation`, `ai-inference`, `user-declaration`) and a **source trust** (`runtime-observation`,
`source-analysis`, `deterministic-derivation`, `user-declaration`, `ai-inference`). Aggregation:

- **basis** = the strongest source: `observed` > `declared` > `derived` > `inferred`. An AI inference added
  to an observed fact leaves it `observed`; an AI-only fact is `inferred` and labelled as such everywhere.
- **confidence** = the strongest deterministic source; AI-only facts are capped at 0.6.
- **corroboration** = distinct sensors (tools) — kept separate from confidence.

### Temporal model

`firstObservedAt` / `lastObservedAt`, first/last execution, and a status: `active`; `stale` (every sensor
that reported it ran again *completely* on the same target and did not report it — a partial run proves
nothing); `superseded` (a redirect now goes elsewhere); `contradicted`. Nothing is deleted because a later
run differs, so knowledge can be compared over time.

### Contradictions

Conflicts are kept, not resolved by fiat: two exclusive technologies (e.g. two web servers) on one host,
or two sensors currently reporting different versions of a technology (an upgrade seen over time by one
sensor is not a conflict). Both facts are marked `contradicted` with the conflict, a
`contradiction-unresolved` gap opens, and a `graph.contradiction-detected` event is recorded.

### Knowledge gaps (unknown ≠ false)

Derived deterministically and persisted with history: `endpoint-behavior-unknown`,
`technology-uncorroborated`, `api-operation-unobserved`, `signal-unconfirmed`, `contradiction-unresolved`,
`authentication-requirement-unknown`. Each records its question, which observation types would answer it
(`answeredBy` — empty when no shipped capability can), and how it was resolved (which observation and
execution). Ownership and tenant gaps need identities (Phase 5).

### AI enrichment

The researcher may propose relationships (`CALLS`, `BELONGS_TO`, `DEPENDS_ON`, `READS`) between existing
entities, citing supporting observations about them. Kinds, references, scope and evidence are validated;
accepted ones are stored as `inferred` with `ai-inference` provenance and never replace observed facts.

## Hypotheses

A `SecurityHypothesis` has: claim, category (Phase 4 safe domains only: attack surface, technology,
endpoint behavior, API surface, configuration, evidence gap, signal confirmation), affected entities,
supporting and contradicting observations, gaps, impact, confidence, **machine-checkable evidence checks**
(`response-status`, `independent-corroboration`, `observation-present`, `entity-contradicted`,
`gap-resolved` — each `supports` or `contradicts`), candidate capabilities, ranking (expected information
gain, estimated cost, execution risk), attempts, origin (provider, model, prompt version), review verdict
and a bounded transition history.

**Lifecycle**: `proposed → needs-evidence → supported → confirmed-signal`, or `disproved`, `deferred`,
`blocked`, `exhausted`. Status changes come **only** from evaluating the checks against the graph:
a met contradicting check disproves; all supporting checks met with evidence from two independent sensors
(or a met corroboration check) confirms the signal; partial support is `supported`.

**Quality rules** (deterministic, `hypotheses.ts`) reject proposals that reference unknown entities,
observations or gaps; cite evidence unrelated to their entities (hub/host evidence does not count);
cite nothing; mention paths or URLs not in the graph; concern out-of-scope or third-party assets; need
evidence no capability allowed in this environment can produce; or are already established or already
contradicted. Confidence is clamped by a support-based ceiling.

**Deduplication**: the structural key is the set of affected entities — "possible missing authorization",
"access control issue" and "IDOR" about the same entities are one hypothesis. A model's `duplicateOf` is
only a suggestion, merged when the entities agree; restatements in one batch are rejected; merges add
evidence and a history note.

**Independent review**: a separate verifier task classifies accepted proposals (reasonable, needs-evidence,
unsupported, duplicate, contradicted). It can only make things more conservative.

## Ranking and information gain

Deterministic and explainable (`ranking.ts`); raw model enthusiasm is not an input:

```
uncertainty   = binary entropy of the confidence
resolvability = how directly the best eligible capability produces the evidence the unmet checks need
                (a different sensor for corroboration; the sensor that already reported the entity counts 0.3)
expected gain = uncertainty × resolvability × 0.5^failedAttempts
priority      = 100 × impact × (0.55·gain + 0.20·evidenceGap + 0.15·centrality + 0.10·novelty)
                ÷ (1 + 0.25·(costUnits − 1)) − 10·riskPenalty
```

A high-impact, low-confidence hypothesis one cheap capability can settle outranks a well-supported one an
expensive capability could only nudge. Below an expected gain of 0.12 a hypothesis is `deferred`. The
explanation string is stored with every ranking and shown in the UI.

## Capability planning and execution authority

The planner proposes `{ hypothesisId, capabilityId, input, expectedEvidence, reason }` — never an image,
command, network policy, environment or scope. Before anything runs (`planning.ts`): the hypothesis exists
and is open; the capability exists, may run in this environment and needs only inputs a planner can supply
from the graph (a URL — never invented schema or source content); the input validates against its strict
schema; every target is a known in-scope asset related to the hypothesis; the capability can produce
evidence the unmet checks need; no cheaper eligible capability produces the same evidence; the same action
is not running and did not already run since the hypothesis existed. Then the broker's new side-effect-free
**`preflight()`** — the exact checks of `submit` (readiness, authorization, scope + DNS, policy, resources),
persisting nothing — marks it `approved-by-policy` or `blocked` with the decision.

Execution is conservative: only in `investigate` mode, only read-only passive/low-impact capabilities that
are not high-cost (passive only in production), within the run's action and cost budgets, and always via
`broker.submit()` as an `agent` request (correlation id = the action id, so a crash between submit and
recording never double-submits). The broker decides again, authoritatively. Phase 4 changes reasoning
only: authorization, scope, policy, isolation, controlled egress and capability approval are untouched.

## The bounded reasoning loop

`ReasoningEngine` is a persisted state machine; every stage boundary is written before the next stage:

```
ingest (project) → assess (evaluate checks; attempts; exhaustion) → generate (researcher + verifier)
→ rank → plan (planner + validation + preflight) → execute (investigate only) → await → ingest …
```

**Limits** (strict ceilings; a request can only lower them): iterations (≤5, default 3), AI calls (≤20,
default 9, counted *before* the call), actions (≤6, default 3), cost units (≤16, default 6), wall time
(≤60 min, default 30). A hypothesis is exhausted when no untried useful capability remains (at most 3
attempts).

**Durability**: runs are pg-boss jobs (`security-reasoning`, `stately` policy: one queued + one active per
run, so a wake-up is never lost) holding a **lease** with heartbeats. A run survives a worker restart
(recovery re-queues queued, abandoned and resumable runs; shutdown hands the run back at its stage), a lost
AI session (every task rebuilds its context from stored state — no session resume), a provider change, and
execution interruption (the worker's post-execution hook projects the graph and wakes waiting runs).
Persisted: hypotheses, actions, stage, usage, a concise decision trail and AI provenance — never hidden
chain-of-thought.

**Stopping conditions** (persisted as `stopReason` + detail): `sufficient-evidence`,
`nothing-to-investigate`, `no-eligible-capability`, `low-information-gain`, `policy-blocked`,
`awaiting-approval` (propose mode, or approved actions not eligible for automatic execution),
`budget-exhausted`, `provider-unavailable`, `provider-refused`, `ai-output-invalid`, `cancelled`,
`internal-error`.

**Cost awareness**: per run — iterations, AI calls and attempts, providers used, AI cost where reported,
actions proposed/executed, cost units, elapsed time, time per stage, and validation outcomes
(accepted / merged / rejected by reason, actions rejected / blocked / skipped).

## Provider usage

Reasoning uses the Phase 3C platform end to end: `AiTaskSpec` (`security-analyze-observations` researcher,
`security-verify-claim` verifier, `security-plan` planner; no tools, structured output, no session resume),
the `ProviderRouter` (deterministic selection, bounded transient fallback, refusals recorded and **never
rerouted**), normalized outcomes, `buildAiContext()` trust boundary (Audivra-owned rules, scope,
capabilities, gaps and hypotheses are TRUSTED; entity labels, URLs and observation content are UNTRUSTED
data) and versioned prompts. The security domain depends only on a `ReasoningAi` port; the worker wires
`createReasoningAi(router)`. A provider failure only pauses AI work; a refusal marks the run `blocked`;
malformed output is rejected before anything is stored. With AI unavailable, graph ingestion, observations,
sensors, existing hypotheses and deterministic coverage all keep working.

## API

Read-only and bounded: `GET …/engagements/:id/graph/summary|nodes|edges|gaps`,
`GET /api/security/graph/nodes/:nodeId` (+ `/neighborhood?depth=1|2`, `/observations`, `/evidence`),
`GET …/engagements/:id/hypotheses`, `GET /api/security/hypotheses/:id`, `GET …/reasoning/runs|actions|coverage`,
`GET /api/security/reasoning/runs/:runId`. Writes: `POST …/graph/project` (deterministic rebuild),
`POST …/reasoning/runs` (`{ mode?, budget? }` — strict), `POST /api/security/reasoning/runs/:runId/cancel`.
No endpoint runs a prompt or takes a capability id, input, image or command; every response is redacted.

## UI

- **Graph** — summary (entities, relationships, observed/derived/inferred, contradicted, stale facts, open
  unknowns), an entity table with kind/basis/status/search filters, an entity rail (attributes, conflicts,
  unknowns, relationships as a navigable neighbourhood, *why Audivra believes this* with the observations,
  evidence refs and executions behind each fact, related hypotheses) and an Unknowns list.
- **Hypotheses** — reasoning controls (*Propose next steps*; *Investigate* behind a confirmation that
  states the budget and broker), the latest run (status, stop reason, AI calls and providers, actions, cost,
  validation outcomes, AI coverage, decision trail), reasoning coverage, a ranked table and a detail panel
  answering *why is Audivra investigating this?* (rationale, ranking explanation and factors, evidence
  checks met/unmet, supporting/contradicting evidence, affected entities and unknowns, proposed actions with
  their policy decisions and executions, history, origin and review).
- **Overview** — a Knowledge panel; **Audit trail** — `graph.*`, `hypothesis.*`, `reasoning.*` events (one
  per projection/decision, never one per entity).

## Benchmark

`pnpm benchmark:reasoning` (own database `audivra_bench`, no Docker, no real AI) runs nine deterministic
scenarios and fails on any missed metric: graph construction (expected entities, merge without duplicates,
provenance preserved, idempotent re-projection), the grounded loop (hypothesis precision, useful next
action, no unnecessary actions), adversarial pressure (unsupported hypothesis rate 0, every invalid proposal
rejected, duplicate rate 0, no invalid action executed), unnecessary cost, redundant actions, preferring
"unknown" over invented certainty, contradictions, AI unavailable, and refusal (never rerouted). It reports
acceptance rate, AI calls and actions as information — never the number of hypotheses as a goal. The same
benchmark is a regression gate in `apps/worker/test/reasoning-benchmark.integration.test.ts`.

## Measured performance

Windows + Docker Desktop, PostgreSQL in Docker, synthetic crawl observations (`.local-data/qa/perf-graph.ts`):

| Observations | Entities / relationships | Provenance rows | First projection | Re-projection (no changes) | Knowledge load | Researcher context |
| --- | --- | --- | --- | --- | --- | --- |
| 110 | 211 / 210 | 570 | 0.38 s | 0.11 s | 0.06 s | 87k chars (80 entities) |
| 550 | 1,014 / 1,013 | 2,850 | 1.5 s | 0.41 s | 0.12 s | 71k chars (80 entities) |
| 2,200 | 4,014 / 4,013 | 11,400 | 5.9 s | 1.35 s | 0.42 s | 71k chars (80 entities) |

Projection is roughly linear and a repeated projection writes nothing; the AI context is bounded by the
relevance budget, not by the graph size. The deterministic reasoning benchmark (9 scenarios) runs in
~6 s; the E2E reasoning flow with real sensors (httpx, katana, Nuclei through the gateway) in ~1 min.
Not optimized for very large graphs: each settled execution re-projects the engagement (≈1.4 s of no-op
work at 4,000 entities); an incremental projector is the next step if engagements grow by orders of
magnitude.

## Limitations

- Reasoning is limited to Phase 4's safe domains; authorization, business-logic and multi-step sequences,
  identities and tenants are Phase 5.
- Only URL-input sensors can be planned (httpx, katana, Nuclei); Schemathesis and Semgrep need schema or
  source content the planner never invents, so they remain person-initiated.
- Confirmation of header-based signals is limited by what sensors record (httpx records only `Server`; a
  missing-HSTS signal has no shipped confirming sensor and stays an explicit unknown).
- katana runs without technology detection, so it reports endpoints but not technologies; the ranking learns
  this through attempts rather than metadata.
- There is no person-approval endpoint for `approved-by-policy` actions in propose mode; a later
  `investigate` run re-plans them through the same validation and broker.
- Staleness needs a complete re-run of the same capability on the same target; derived-only facts
  (template matches) are not marked stale.
