# Independent verification & evidence-backed findings (Phase 6A)

Audivra turns strong, evidence-backed signals into trustworthy **Security Findings** — without ever treating
a scanner hit, an AI opinion or one isolated observation as proof. A finding is the end of a deliberate
boundary, not a relabelled signal.

```
observations + graph + hypotheses + comparisons + invariants
  → verification candidate (stable issueKey)
  → deterministic, machine-checkable verification requirements
  → AUDIVRA decides whether the required evidence exists
  → optional independent verifier (AI) — may only make it MORE cautious
  → verified / supported / rejected / inconclusive / blocked
  → Security Finding (constrained severity, evidence-quality confidence, structured reproduction)
```

The AI may **reason** about evidence; **Audivra deterministically decides** whether the required evidence
exists. A scanner or a model alone can never create a *verified* finding: a `verified` finding requires both
that every machine-checkable requirement is met *and* that an independent verifier confirmed it. A provider
failure during verification is `blocked`, never silently `verified`; a material contradiction forces
`inconclusive` and the contradicting evidence is preserved. This phase does **not** add attack-path chaining,
a retesting engine or exploit orchestration — those are later phases (6B+).

## Where it lives

| Concern | Code |
| --- | --- |
| Contracts | `packages/contracts/src/security-finding.ts` (categories, verification states, checks, candidate, severity/confidence inputs, reproduction, finding, AI outputs, coverage, report) |
| Events & graph vocab | `packages/contracts/src/security.ts` (verification/finding events), `security-graph.ts` (`finding` kind, `FINDING_AFFECTS`/`CONTRADICTS`) |
| Requirements | `packages/security/src/verification/requirements.ts` (`requirementsFor(origin, category)`) |
| Candidate generation | `packages/security/src/verification/candidates.ts` (`generateCandidates`, `findingIssueKey`) |
| Deterministic evaluation | `packages/security/src/verification/evaluate.ts` (`evaluateCandidate`) |
| Severity & confidence | `packages/security/src/verification/severity.ts` (`computeSeverity`, `computeConfidence`) |
| Decision & inputs | `packages/security/src/verification/engine.ts` (`resolveVerification`, severity/confidence builders) |
| Reproduction | `packages/security/src/verification/reproduction.ts` |
| Synthesis | `packages/security/src/verification/synthesize.ts` |
| AI tasks & prompts | `packages/security/src/verification/ai.ts`, `prompts/security-finding-{verifier,prose,reviewer}-system.md` |
| Service | `packages/security/src/verification/service.ts` (`VerificationService`) |
| Read / report / exports | `packages/security/src/verification/read.ts`, `exports.ts` |
| Graph projection | `packages/security/src/graph/project-findings.ts` (wired into `projectGraph`/the projector) |
| Schema + migration | `packages/database/src/schema.ts`, `migrations/0011_security_findings.sql` (additive) |
| Repository | `packages/database/src/repo/security-findings.ts` |
| API | `apps/server/src/routes-findings.ts` |
| Worker / queue | `apps/worker/src/security-verification.ts`, `packages/database/src/queue.ts` (`security-verification`) |
| UI | `apps/web/src/features/security/findings-tab.tsx` |
| Benchmark | `apps/worker/src/findings-benchmark.ts` |

## The verification boundary

A **verification candidate** is a strong signal that has earned independent verification — never a finding by
itself. Candidates are generated deterministically from five origins:

- `confirmed-signal-hypothesis` — a sensor hypothesis the evidence independently confirmed;
- `differential-comparison` — a differential comparison that came back `inconsistent`;
- `contradicted-invariant` — a declared invariant a comparison contradicted;
- `corroborated-observation` — an observation two independent sensors corroborate (a lone scanner hit is not
  a candidate);
- `source-runtime-correlation` — a source-code signal a runtime observation corroborates.

Each candidate carries a stable `issueKey` (category + affected entities + the security property), so the
same issue is advanced across passes, never duplicated, and candidates that share an issueKey are merged
(their evidence unioned).

## Machine-checkable requirements

`requirementsFor(origin, category)` returns the `VerificationCheck`s a candidate must satisfy — chosen by
Audivra, never by the AI. Each check is evaluated against stored state (`evaluateCandidate`); the verifier's
prose never satisfies a check. For example, a differential-comparison candidate must carry an `inconsistent`
`comparison-result`, a `positive-control` **and** a `negative-control`, a grounded `expectation-provenance`,
a known `affected-entity`, and `no-material-contradiction`. The evaluation yields a disposition:

- `complete` — every requirement met (eligible for `verified` once an independent verifier confirms);
- `partial` — some supporting checks met, but not all (at most `supported`);
- `contradicted` — a material contradiction (forces `inconclusive`);
- `insufficient` — effectively no evidence (`needs-evidence`).

## The decision

`resolveVerification` combines the deterministic disposition with the verifier's verdict under one rule: **the
verifier may only ever make the outcome more cautious.**

| Disposition | No verifier / none selected | Verifier `confirm` | Verifier `disprove` | Verifier `alternative` / provider failed |
| --- | --- | --- | --- | --- |
| complete | supported | **verified** | rejected | inconclusive / **blocked** |
| partial | supported | supported | rejected | supported / **blocked** |
| contradicted | inconclusive | inconclusive | inconclusive | inconclusive |
| insufficient | needs-evidence | needs-evidence | needs-evidence | needs-evidence |

A candidate becomes `verified` only when the deterministic requirements are all met **and** an independent
verifier confirms. When no AI provider is configured at all, the verifier is simply not run and the candidate
keeps its deterministic floor (`supported` for a complete candidate) — honest, and never `verified`. When a
provider *is* selected and then fails, the candidate is `blocked` (verification pending), never `verified`.

## Severity and confidence

Severity is computed deterministically from `SeverityInputs` (category, scope class, privilege/tenant
boundary crossed, data sensitivity, exploit prerequisites, confidence, environment) — mirroring the Website
Audit philosophy: **the AI may only explain or lower the severity, never raise it.** The second-stage reviewer
can suggest a lower severity; a higher suggestion is ignored. Confidence comes from evidence quality (direct
observation, independent corroboration, positive/negative controls, deterministic reproduction, and whether
any contradicting evidence or AI inference is in play), and a finding that leans on AI inference never exceeds
the inferred-fact confidence cap.

## The finding

A `SecurityFinding` is synthesized only for a settled, finding-worthy candidate (`supported` or `verified`).
It records the deterministic severity and its rationale, the evidence-quality confidence, the affected
entities, a structured `ReproductionRecord` (the executed comparison arms, their executions and the
before/after state), and AI-authored `impact`/`remediation` prose whose facts are bounded to stored state.
Verified and supported findings are projected into the Security Graph as `finding` nodes with
`FINDING_AFFECTS` edges to the entities they concern and `CONTRADICTS` edges to invariants they violate.

## Reports and exports

The assessment **report** keeps verified findings, supported signals and open investigation strictly apart —
a supported signal is honestly not a verified finding, and an inconclusive or blocked candidate is shown as
open work. **Exports** (JSON with a stable `audivra.security-findings.v1` schema version, and CSV) are
generated on demand entirely from persisted state: no export ever re-runs the AI or a capability.

## The closed loop and resilience

The verification pass runs as a durable pg-boss job keyed by engagement (`security-verification`, `stately`,
singletonKey = engagement id). It is deterministic and idempotent: a crash or restart simply re-runs it —
candidates advance by `issueKey` and are never duplicated. After the comparison reasoning pass settles, a
verification pass is enqueued automatically, closing the loop: **sensors → comparisons → verification →
findings.**
