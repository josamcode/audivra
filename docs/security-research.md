# Autonomous security-researcher orchestration (Phase 6E)

Audivra can run a bounded, persistent, adaptive **research loop** that connects everything built in Phases 1–6D
into one investigation session. It is an *orchestrator*, not a new agent: it coordinates the existing services
and owns no domain logic and no execution authority.

```
ASSESS → PLAN → VALIDATE → EXECUTE → INGEST → VERIFY → REFLECT   (repeat or stop)
```

> Audivra does not guarantee finding every vulnerability. A research run optimizes for useful evidence,
> coverage, precision, verified findings and low unnecessary-action rate — never for finding count — and it
> always reports residual uncertainty. It is not a "complete penetration test".

## Why it is not a monolith

The AI reasons (proposes typed next actions + concise rationale); **Audivra owns authority and truth.** Each
action maps to an existing service — the comparison planner/engine (Phase 5), the Capability Broker, the
verification engine (6A), the attack-path analyzer (6B), retesting (6C), the specialist engine (6D). There is
no `AutonomousPentestAgent` class; the orchestrator is thin glue over `security/src/research/`.

## State machine

| Concept | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-research.ts` (run, action, modes, objectives, budget, usage, coverage, residual, planner output) |
| Run + actions (persisted) | migration `0015` → `security_research_runs`, `security_research_actions`; repo `security-research.ts` |
| ASSESS (deterministic) | `research/assess.ts` |
| VALIDATE | `research/validate.ts` |
| RANK | `research/rank.ts` |
| PLAN (AI advisory) | `research/ai.ts`, `prompts/security-research-planner-system.md` |
| EXECUTE (maps to existing services) | `research/execute.ts` |
| Budget / fingerprint / coverage | `research/budget.ts`, `fingerprint.ts`, `coverage.ts` |
| Orchestrator | `research/service.ts` (`ResearchService`) |
| Read | `research/read.ts` |
| API / worker / UI | `apps/server/src/routes-research.ts`, `apps/worker/src/security-research.ts`, `apps/web/src/features/security/research-tab.tsx` |
| Benchmark | `apps/worker/src/research-benchmark.ts` |

A run moves `created → running → (paused | degraded) → stopped | failed`, with a stage per cycle
(`assess/plan/validate/execute/ingest/verify/reflect`). **All loop state is persisted every cycle**, so a
worker/provider restart resumes deterministically — the run is never an AI conversation.

## Modes & objectives

Modes (set at creation, immutable — the AI can never promote the mode): `propose-only` (plan + rank, execute
nothing), `investigate` (auto-execute eligible actions under the existing policy), `deep-authorized` (larger
budget where environment/policy permit; still no new authority). Production defaults conservatively; autonomy
and execution power are separate dimensions. Objectives are structured (`maximize-coverage`,
`investigate-authorization`, `investigate-business-rules`, `investigate-api-surface`, `retest-previous`, …) —
a free-form note may accompany one but carries no execution authority.

## Planning, validation, ranking

**ASSESS** is largely deterministic: from stored state it derives cheap-first candidates — controlled
comparisons the Phase 5 planner proposes, a verification pass when inconsistent comparisons lack findings, an
attack-path refresh when findings exist, retests for a historical objective, and — only as a conservative last
resort — an expensive specialist run. **PLAN** optionally asks the AI for a few *typed* proposals (existing ids
only, no command/flags/credentials/budget); they are merged as advisory candidates. **VALIDATE** rejects
anything invalid: missing reference, unavailable capability, invalid input, out-of-scope, duplicate of recent
work, budget-exceeded, specialist-unavailable, and — cheap-before-expensive — a specialist action while a
cheaper valid one remains. **RANK** orders deterministically by expected information gain, cost, prior-failure
memory and risk; the AI's own priority is only a small advisory bonus.

## Deterministic authority (unchanged)

Eligibility is still `engagement + authorization + scope + environment + capability metadata + policy → broker`.
The researcher never invokes a subprocess, Docker, arbitrary HTTP, a browser or a CLI — only registered
capabilities and reviewed services. Findings still require 6A independent verification; attack paths still
require 6B validation; retests still use 6C; identity/business testing still uses Phase 5. The researcher
cannot verify its own finding, access secrets, choose a runtime, expand scope or change authorization.

## Provider & specialist behavior

If Audivra's AI provider **refuses**, that AI task stops and the refusal is recorded; the deterministic state
is intact and Strix is **not** invoked as a bypass. If the provider is **unavailable**, the run degrades: the
deterministic loop (ingestion, verification, history) keeps working and the run is marked `degraded`/`provider
unavailable` — it is never marked complete merely because the AI disappeared. **Strix** is a very-high-cost
specialist: it is proposed only for a broad objective, only when no cheaper capability can answer the question,
and only when it is available and within budget — never because the researcher is uncertain. Source-only Strix
remains usable when live-target mode is disabled.

## Stopping & residual uncertainty

A run stops with an explicit reason: `objective-satisfied`, `no-useful-action`, `information-gain-too-low`,
`coverage-target-reached`, `budget-exhausted`, `time-limit`, `action-limit`, `ai-unavailable`,
`policy-blocked`, `user-cancelled`, `system-failure`. It does not require exhaustive coverage; it stops when
remaining work is redundant or low-value, and it always reports residual uncertainty (tested / partially
tested / not tested / still unknown).

## Budgets, concurrency, recovery

Explicit per-mode budgets (wall time, iterations, actions, AI calls, specialist runs, expensive actions) with
safe defaults; a user may only narrow within a mode's ceiling. One research job per run (`stately`); expensive
specialist actions are bounded by the budget. On restart, resumable runs are re-enqueued and `drive` resumes
from the persisted state idempotently (completed work is not repeated; finished external work is not re-run).

## API / UI / reports

Bounded APIs: create / list / detail / start / pause / resume / cancel — no arbitrary prompt execution. The
Research view shows the mode/objective/stage/iteration, budget used, a concise **decision timeline**, the
proposed/executed actions (with eligibility/rejection reasons), the findings surfaced, and residual
uncertainty. Security reports include the autonomous-research summary (objective, capabilities used, verified
findings, attack paths, coverage, blocked areas, residual uncertainty, termination reason) and never claim a
complete penetration test.

## Testing

A deterministic fake AI (the scripted reasoning provider) and the Phase 6D fake specialist engine make CI
deterministic — the normal suite needs no Claude, paid AI, Strix provider or external internet. A real-model
evaluation is optional and manually invoked. See [testing.md](testing.md).

## Limitations

- The loop's executable action set is `observe / comparison / verify / attack-path / retest / specialist`
  (sensors needing Docker are proposable but blocked in a no-Docker environment, which the loop records).
- Cross-process live cancellation relies on the per-cycle state check + wall-clock timeout; same-process
  cancellation (tests, single-process backend) is immediate.
- Not built here (Phase 6F): a setup wizard, operational dashboards, final report polish, broad performance
  tuning, packaging/deployment hardening.
