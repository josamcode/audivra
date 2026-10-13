# Differential authorization & business-logic comparison (Phase 5 Step 4)

Audivra compares how an application behaves across *authorized test identities, roles, tenants, resources and
states*, using the trusted identity-aware execution system (Step 3). A comparison is a structured, persisted
experiment — never an arbitrary request, never a vulnerability verdict.

```
graph knowledge → identity/resource boundary hypothesis → bounded comparison plan
  → identity-aware executions (one per arm, through the broker) → expected vs observed behaviour
  → evidence → deterministic result classification → hypothesis / invariant update
```

The AI only **proposes** comparisons; Audivra deterministically validates every reference, executes each arm
through the Capability Broker, normalizes and compares the responses, classifies the result from the controls
and expectations, and stores it. No identity/session/resource/action/credential is ever invented, and no
result is produced without real execution evidence. This step does **not** add attack-path chaining, exploit
synthesis or verified-finding synthesis — those are later phases.

## Where it lives

| Concern | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-comparison.ts` (dimensions, expected behaviour, arms, observations, results, plans, coverage) |
| Hypothesis evidence check | `packages/contracts/src/security-reasoning.ts` (`comparison-result` `EvidenceCheck`, authorization categories) |
| Normalization & diff | `packages/security/src/comparison/normalize.ts` |
| Classification & keys | `packages/security/src/comparison/classify.ts` |
| Validation | `packages/security/src/comparison/validate.ts` |
| Planner & proposal validation | `packages/security/src/comparison/plan.ts` |
| Hypotheses | `packages/security/src/comparison/hypothesis.ts` |
| Engine | `packages/security/src/comparison/engine.ts` (`ComparisonEngine`) |
| Service / coverage | `packages/security/src/comparison/service.ts`, `coverage.ts` |
| Capabilities | `packages/security/src/capabilities/comparison-probe.ts` (`access.identity-read`, `access.identity-action`) |
| Schema + migration | `packages/database/src/schema.ts`, `migrations/0009_security_comparisons.sql` (additive) |
| Repository | `packages/database/src/repo/security-comparisons.ts` |
| API | `apps/server/src/routes-comparisons.ts` |
| Worker / queue | `apps/worker/src/security-comparisons.ts`, `packages/database/src/queue.ts` |
| UI | `apps/web/src/features/security/access-tab.tsx` |
| Benchmark | `apps/worker/src/authorization-benchmark.ts`, `scripts/benchmark-authorization.ts` |

## The comparison model

A `SecurityComparison` is identity × resource × action × state, optionally contrasted with a second
identity/context. It is made of **arms**, each one an identity-aware execution against one resource/action:

- `subject` — the identity whose expected outcome is being tested.
- `positive-control` — an identity that *should* be allowed (proves the resource is access-controlled).
- `negative-control` — anonymous/none that *should* be denied (proves denial is real).

Each arm carries an **expected behaviour** with explicit provenance (`declared` / `code-derived` / `observed`
/ `ai-inferred`), and, after execution, a **normalized observation**.

## Expected vs observed, semantic comparison

The observed behaviour is a bounded, normalized `ComparisonObservation` — never a raw status alone:

- a semantic **response class** (`success` / `denied` / `not-found` / `auth-required` / `redirect-login` / …),
- the returned **object** and **fields** (for object/field boundaries),
- a **content hash** computed *after* stripping volatile noise (timestamps, UUIDs, tokens, CSRF, JWTs) so
  equal responses hash equal without erasing security-relevant differences,
- whether **state changed** and whether it **bounced to login**, and a **business result** when observable.

Comparing two arms yields `SemanticDifference`s, each flagged for whether it matters to authorization/business
correctness. The original evidence is always kept (the comparison stores its evidence refs).

## Result, controls and invariants

Results are cautious: `consistent` (behaviour matched the expected boundary), `inconsistent` (a
security-relevant difference contradicted it), `inconclusive` (evidence/controls insufficient), `blocked`
(policy/environment/validation stopped it), `not-tested`. **A strong signal is never claimed without adequate
control evidence**: access obtained where denial was expected is only `inconsistent` when a positive control
confirms the resource is normally access-controlled — otherwise it is `inconclusive`.

An invariant (e.g. “only the owner may read a document”) is `supported` when a comparison is `consistent`,
`contradicted` when `inconsistent`, `inconclusive` otherwise, `not-tested` when no comparison evaluated it.

## Deterministic hypothesis updates

An authorization boundary hypothesis (categories `object-boundary`, `role-boundary`, `tenant-boundary`,
`function-level`, `field-boundary`, `session-boundary`, `business-rule`) carries only `comparison-result`
evidence checks. When a linked comparison settles, the hypothesis is re-evaluated **deterministically** by the
same evidence-check machinery as Phase 4 — an `inconsistent` comparison supports a weakness hypothesis, a
`consistent` one disproves it, and two independent control arms make an inconsistent signal a `confirmed-signal`.
The AI cannot declare a hypothesis confirmed; only the computed comparison result moves it. These hypotheses
are owned by the comparison engine — the sensor-driven reasoning loop skips them entirely.

## State-changing comparisons, test data and cleanup

The read probe (`access.identity-read`) is passive. The action probe (`access.identity-action`) is
state-changing/reversible-write and is therefore gated by the environment policy (only an isolated lab allows
it by default; staging requires an opt-in and otherwise blocks it) and by the engagement's authorization. A
state-transition comparison reads the resource's state as the subject **before** and **after** the action and
records both. When a state-changing comparison mutates state, the engine runs the plan's compensating
`cleanup` request and records whether it succeeded — a failed cleanup stays visible and is never reported as
restored. State-changing comparisons prefer `test-owned`/`synthetic` resources; production-like data is
refused outside an isolated lab.

## Planner & pruning

`ComparisonService.propose` deterministically proposes a bounded, ranked, deduplicated set of comparisons
(one representative per resource/dimension, always with controls), ranked by information gain — never the
Cartesian product of identities × resources × actions. It needs no AI (so it works when the provider is
unavailable). An AI proposal is accepted only after `validateProposedComparison` confirms every identity and
resource exists and has a session, that ownership claims match the declarations (the model cannot invent
“other owner”), that controls are present, and that it is not a duplicate.

## Secret boundary & isolation

Every arm runs with an explicit `identityId`/`sessionId` — never an implicit “current login”. The session
material is injected by the trusted runtime same-origin only (Step 3); the comparison stores response captures
(status, bounded body sample, hashes) and evidence refs, never the request headers that carried the session.
The canary test proves no session token reaches evidence, observations, events, the graph, the comparison
records or the logs. A/B identities stay isolated: each arm authenticates only as its own identity.

## API

| Method & path | Purpose |
| --- | --- |
| `POST /api/security/engagements/:id/comparisons` | Plan + persist a comparison and queue it for the worker. |
| `GET /api/security/engagements/:id/comparisons/propose` | Deterministically propose bounded comparisons (no execution). |
| `GET /api/security/engagements/:id/comparisons` | List comparisons. |
| `GET /api/security/comparisons/:comparisonId` | A comparison with its arms, evidence, hypothesis and invariant. |
| `GET /api/security/engagements/:id/comparisons/coverage` | Authorization/business coverage (counts and states). |
| `GET /api/security/engagements/:id/comparisons/invariants` | Per-invariant support/contradiction. |

There is no endpoint that runs an arbitrary request: a comparison only ever runs the two reviewed
identity-aware capabilities, each decided by the Capability Broker.

## Benchmark

`pnpm benchmark:authorization` runs a multi-tenant fixture with known ground truth (enforced vs
intentionally-broken object/tenant boundaries) and measures object/tenant precision and recall, false
positives, control usage, business-rule accuracy, inconclusive-without-controls correctness, state-transition
cleanup and bounded planner selection. It uses no real AI and no Docker; results are written to
`.local-data/benchmarks/authorization-*.json`.

## Tests

- Unit (`packages/security/test/comparison.test.ts`): normalization (semantics beyond status, volatile
  stripping), semantic diff, classification with controls, the relationship classifier, dedupe keys, the
  bounded planner and adversarial-proposal rejection.
- Integration (`apps/server/test/security-comparison.integration.test.ts`): a broken object boundary detected
  with controls (evidence tagged, invariant contradicted, hypothesis confirmed), an enforced boundary proved
  consistent (hypothesis disproved), a cross-tenant comparison, a business-state transition with cleanup,
  state-changing policy constraints in staging, the secret canary, bounded/deduplicated planner proposals,
  adversarial-proposal rejection, reference validation and idempotent re-run.
- Benchmark regression (`apps/worker/test/authorization-benchmark.integration.test.ts`).
