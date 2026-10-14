# Retesting & historical security comparison (Phase 6C)

Audivra answers, for an authorized target assessed more than once: **is this issue still present, was it
actually fixed, did it regress, did the surface change, or is it simply not reproducible right now?** The
governing rule is that Audivra never equates *not observed again* with *fixed*. A fix must be proven.

```
verified finding → structured retest case → readiness/broker/durable execution → evidence
  → the 6A verification engine (checks the ORIGINAL requirements against fresh evidence) → historical result

assessment A findings/paths/coverage + assessment B findings/paths/coverage
  → exact-key (then cautious semantic) matching → new / still-present / fixed / changed / regressed / … → persisted comparison
```

6C adds no new offensive capability. A retest replays what Audivra already tested through the **same** runtime
as a comparison; it analyses two assessments of what it already knows. A gap is represented, never
manufactured into proof.

## Where it lives

| Concern | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-history.ts` (retest states, eligibility, retest case/result, adaptation, matching, finding comparison, lineage, path/graph/coverage diffs, assessment comparison, analyst decisions, historical report) |
| Events | `packages/contracts/src/security.ts` (`retest.*`, `history.*`) |
| Retest case | `packages/security/src/retest/case.ts` (`buildRetestCase`, `reproductionFromComparison`) |
| Eligibility | `packages/security/src/retest/eligibility.ts` |
| Classification | `packages/security/src/retest/classify.ts` (`classifyRetest`, `reevaluateChecks`) |
| Adaptation | `packages/security/src/retest/adapt.ts`, `ai.ts`, `prompts/security-retest-adapter-system.md` |
| Execution | `packages/security/src/retest/execute.ts` (`RetestExecutor`) |
| Retest service | `packages/security/src/retest/service.ts` (`RetestService`) |
| Matching / compare | `packages/security/src/history/match.ts`, `compare.ts` |
| Path / graph / coverage diff | `packages/security/src/history/paths.ts`, `graph.ts`, `coverage.ts` |
| History service / read / report / exports | `packages/security/src/history/{service,read,report,exports}.ts` |
| Schema + migration | `packages/database/src/schema.ts`, `migrations/0013_security_history.sql` (additive) |
| Repository | `packages/database/src/repo/security-history.ts` |
| API | `apps/server/src/routes-history.ts` |
| Worker / queue | `apps/worker/src/security-retests.ts`, `packages/database/src/queue.ts` (`security-retest`) |
| UI | `apps/web/src/features/security/retests-tab.tsx`, `comparison-tab.tsx`, finding timeline in `findings-tab.tsx` |
| Benchmark | `apps/worker/src/history-benchmark.ts` |

## The retest case

A verified/supported finding produces a structured, self-contained **retest case**: the frozen (validated)
comparison plan reconstructed from the original comparison — the same arms, identities, resources, methods and
*expectations and controls* — plus the 6A verification requirements the fresh evidence must still satisfy, the
preconditions, the relevant capability ids and the cleanup requirement. It is stored structurally (never as
prose) so a later assessment can replay it with no conversational memory.

## Eligibility (before anything runs)

`evaluateRetestEligibility` decides deterministically whether a case can be replayed against a target
assessment and records the exact blocker when it cannot: `unsupported-reproduction`, `resource-missing`,
`identity-unavailable`, `session-unavailable`, `scope-excludes-target`, `authorization-invalid`,
`capability-unavailable`. An ineligible retest is a gap, never a fix.

## The result, and the one fix rule

`classifyRetest` interprets the fresh comparison into a historical state —
`still-present` / `fixed` / `regressed` / `changed` / `cannot-reproduce` / `blocked` / `not-tested` /
`inconclusive` (never `resolved`). **A finding becomes `fixed` only when the retest actually ran, the subject
executed, the positive control STILL works, and the vulnerable behaviour is now absent (a consistent replay).**
If the control no longer establishes the baseline, the subject did not execute, or the resource is gone, the
result is `cannot-reproduce` / `blocked`, never `fixed`. `regressed` is assigned when the issue's own history
shows a prior proven fix and it is present again. A provider failure (AI adaptation) never yields a fix.

## Semantic adaptation (bounded)

When deterministic replay cannot run because the app changed, an AI adapter may propose **one** relocation —
a current endpoint/URL or an equivalent current resource — referencing only existing graph entities. Audivra
validates every field and applies only a location change; it never lets the security property, expected
outcome, invariant, identity or tenant boundary change (that would be a `changed` or `new` issue). If the AI is
unavailable or the proposal is invalid, the retest stays blocked/cannot-reproduce.

## Historical comparison

Two assessments are matched by stable issue key first (`exact-issue-key`), then by a cautious similarity layer
(`semantic-match`, same category + a shared affected entity — never a blind title match), with analyst
`manual-link`s honoured. Each matched finding is classified new / still-present / fixed / changed / regressed /
cannot-reproduce / not-tested / unmatched-historical. **A previous finding merely absent from the current
assessment is `not-tested`, never `fixed`** — only a retest result makes it `fixed` or `cannot-reproduce`.
Attack paths are compared by the 6B stable `pathKey` (a vanished path is `disappeared`, reported honestly, not
fixed). The important graph entities are diffed by key, and coverage is compared explicitly: when the current
assessment measured less, `coverageRegressed` is flagged so fewer findings is never read as improvement.

## API, UI, reports, exports

The read API (finding history, retest cases/results, assessment comparison, historical report, coverage, path
history, analyst decisions) is built only from persisted state. The one capability-bearing action — running a
retest — only enqueues a durable `security-retest` worker job (carrying the retest-case id and the target
assessment); it runs no capability in the request path and there is no arbitrary-execution endpoint. The
Finding detail shows a cross-assessment timeline (FIXED vs CANNOT_REPRODUCE are visually distinct); the
Retesting and Comparison views show eligibility/blockers, retest states, and the before/after path history.
Reports separate fixed / not tested / cannot reproduce / regressed, and exports (JSON `audivra.security-history.v1`,
CSV) regenerate nothing.

## Not built here (Phase 6D+)

Strix integration, a final autonomous-researcher orchestration and a large specialist-agent hierarchy are out
of scope. 6C creates the retest-scheduling *data model* (a case can be marked planned) but builds no recurring
scheduler.
