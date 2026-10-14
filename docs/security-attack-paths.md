# Evidence-backed attack path analysis (Phase 6B)

Audivra connects what it has already verified — findings, the Security Graph, identities/resources/trust
boundaries, comparisons and invariants — into ordered, structured **attack paths**: routes from a known start
condition to a structured impact. A path is not a narrative invented after the assessment; every step
references stored structured state and carries an explicit verification label, and a path with any inferred or
missing edge is never presented as a demonstrated compromise.

```
verified findings + security graph + trust relationships
  → candidate path → validate every step → verified / partially-verified / supported / speculative / rejected
```

6B adds no offensive execution: it analyses what Audivra already knows. A gap in a route is represented, never
manufactured into proof. Attack-path chaining into retesting, historical comparison, Strix integration or
autonomous orchestration is explicitly out of scope (Phase 6C+).

## Where it lives

| Concern | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-attack-path.ts` (start conditions, impact classes, trust boundaries, steps, edge verification states, missing evidence, path, coverage, report, AI outputs) |
| Events | `packages/contracts/src/security.ts` (`attack-path.*` events) |
| Condition mapping | `packages/security/src/attack-path/conditions.ts` (`findingEnablement`) |
| Stable key | `packages/security/src/attack-path/key.ts` (`attackPathKey`) |
| Edge verification | `packages/security/src/attack-path/edges.ts` |
| Discovery | `packages/security/src/attack-path/discover.ts` (`discoverPaths`, `buildAiChain`, bounded + cycle-safe) |
| Validation | `packages/security/src/attack-path/validate.ts` |
| State / confidence / priority | `packages/security/src/attack-path/confidence.ts` (`pathVerdict`, `pathImpactPriority`) |
| Dedupe / dominance | `packages/security/src/attack-path/dedupe.ts` |
| Synthesis | `packages/security/src/attack-path/synthesize.ts` |
| AI tasks & prompts | `packages/security/src/attack-path/ai.ts`, `prompts/security-attack-path-{proposer,explainer}-system.md` |
| Service | `packages/security/src/attack-path/service.ts` (`AttackPathService`) |
| Read / report / exports | `packages/security/src/attack-path/read.ts`, `exports.ts` |
| Schema + migration | `packages/database/src/schema.ts`, `migrations/0012_security_attack_paths.sql` (additive) |
| Repository | `packages/database/src/repo/security-attack-paths.ts` |
| API | `apps/server/src/routes-attack-paths.ts` |
| Worker / queue | `apps/worker/src/security-attack-paths.ts`, `packages/database/src/queue.ts` (`security-attack-path`) |
| UI | `apps/web/src/features/security/attack-paths-tab.tsx` |
| Benchmark | `apps/worker/src/attack-path-benchmark.ts` |

## The path model

A path has a **start condition** (anonymous, an authenticated identity, a tenant member/admin, access to a
resource, or an exposed endpoint — always drawn from graph/domain state), an **end impact** (one of a small
set of structured impact classes), and an ordered list of **steps**. Each step references the stored state
that backs it (a finding, a graph node/edge, an invariant, a comparison, an identity, a resource, a
business-action or a state transition) and carries an explicit **edge verification state**:

- `verified` — backed by a verified finding or a deterministic observation/comparison/declared fact;
- `supported` — real but not fully verified;
- `inferred` — a derivation/AI relationship;
- `missing` — the required connecting evidence is absent;
- `contradicted` — stored evidence conflicts with the step.

These are kept distinct and never collapsed into one number.

## Finding → condition mapping

`findingEnablement` maps a finding conservatively to the condition it requires and the impact it reaches, from
the finding's category, affected entities, severity inputs and reproduction record — never from an AI freely
deciding that a finding "means" admin access. A gap in the mapping stays a gap.

## Discovery

Deterministic discovery builds a path from a single verified finding that demonstrates meaningful impact, and
chains findings only through a **real connector**: the *same principal* escalating to a greater (or distinct)
impact, or a *verified/declared graph edge* that connects one finding's reach to the next finding's entity.
Search is strictly bounded (max depth, max candidate paths, max expansions) and cycle-safe (a finding is never
revisited within a path), so traversal cannot explode combinatorially; the termination reason is recorded. An
AI proposer may suggest further correlations by referencing existing finding ids and graph keys only; a
proposal that cites invented state is rejected, and a claimed connection with no graph edge becomes a `missing`
(or, when stored evidence contradicts it, a `contradicted`) step — never an invented pass.

## State, confidence and priority

A path's verification state and confidence are **bounded by its weakest meaningful edge**, never an average: a
`verified → verified → inferred` path is `partially-verified`, a path with a missing edge is `speculative`,
and a path with a contradicted step is `rejected`. Path **impact priority** is a separate axis (final impact,
boundaries crossed, starting privilege, and the verification state) — it never silently inflates a finding's
own severity.

## Dedupe and dominance

The same semantic route discovered from different findings collapses onto one stable `pathKey` (provenance
merged). A shorter route that is an ordered prefix of a longer route reaching a greater impact is marked as
dominated by the longer one: both are kept and related, and the default path listing hides dominated subpaths
so the client sees the meaningful routes rather than twenty trivial variations. The key is designed so Phase
6C can later compare paths across assessments.

## Missing evidence

Every path lists its explicit `MissingEvidenceRequirement[]` — an unknown identity relationship, an unverified
transition, an incomplete comparison, an unsupported impact edge or an unverified reachability — the useful
input for a later autonomous researcher. 6B executes no extra tests to close them.

## API, reports, exports and the closed loop

The read API (list/detail/coverage/report/export) and the report (verified paths, partially-verified paths,
open evidence gaps, coverage) are built only from persisted state — no endpoint re-runs discovery, the AI or a
capability, and there is no path-execution or arbitrary-graph-query endpoint. Exports (JSON with a stable
`audivra.security-attack-paths.v1` schema version, and CSV) regenerate nothing. Analysis runs as a durable
pg-boss job keyed by engagement (`security-attack-path`, `stately`); it is deterministic and idempotent (paths
advance by their stable key), and it is enqueued automatically after the verification pass — extending the
closed loop **sensors → comparisons → verification → findings → attack paths**. A provider failure leaves the
deterministic paths intact and marks AI enrichment partial; no path is falsely rejected or verified because
the provider failed.
