# Audivra threat model (V1)

Audivra is an authorized, local-first website-auditing and security-assessment platform. It runs offensive
tooling and autonomous reasoning against targets the operator is authorized to test. This document states the
threats Audivra defends against, the mitigations in place, and the residual risk accepted for V1.

The governing principle: **deterministic Audivra code owns authority and truth; the AI and external tools only
propose and observe.** Every AI/tool output is validated by deterministic code before it changes Audivra
state, and nothing a model or a target produces can grant capability, authorization, scope or a verified
finding.

| # | Threat | Mitigations | Residual risk |
| --- | --- | --- | --- |
| 1 | **Malicious target content** influencing analysis | Target-derived data (observations, HTTP bodies, graph) is carried as UNTRUSTED context, fenced separately from TRUSTED Audivra state; it is never interpreted as instructions. AI outputs are structured and schema-validated; Audivra never executes a model-chosen command. | A model may still be *influenced* within a task; bounded because its output can only reference existing ids and is validated/ranked deterministically. |
| 2 | **Prompt injection** via tool/specialist output | Specialist/tool prose is labelled untrusted, stored as evidence, never fed back as policy or instructions. Phase 3C trust separation is preserved across 6D/6E. An invariant test asserts specialist output is not trusted. | Prose shown to a later AI task is untrusted context; it cannot change authority or verification. |
| 3 | **Compromised/hostile tool output or artifacts** | Raw output is size-bounded; artifacts are stored with a hash, source, execution id, tool/version and provenance; redaction runs at the storage boundary; malformed structured output is dropped, not trusted. | A crafted artifact could still consume budget; bounded by artifact/byte limits. |
| 4 | **Credential / session exposure** | A dedicated vault (AES-256-GCM envelope, `av1.<keyId>.<iv>.<tag>.<ct>`); the key lives outside the DB; only opaque `credentialRef`/`sessionRef` pointers appear in graph/observations/events/exports; `redactSensitive` scrubs material-bearing subtrees; canary tests prove no secret marker reaches any output. | A local attacker with both the DB and the key file can read secrets (see §45/§46 backup). |
| 5 | **Docker / runtime compromise** (a tool escaping its sandbox) | Sensors run in an Audivra-created hardened container: `--read-only`, `--cap-drop ALL`, non-root, `--network none` or a scoped-egress gateway, and **no Docker socket mounted**. Controlled egress (Phase 2C) is the only outbound path. Cleanup removes exactly owned resources by id/name — never a global prune. | The Strix specialist runs its own Kali sandbox on the host (reviewed trusted runtime); live-target containment is unproven, so live modes are **disabled by default** (fail-closed). |
| 6 | **Scope escape** (testing something out of scope) | A deterministic scope engine authorizes every destination by name and by resolved DNS; the broker is the only execution authority; a target discovered by a tool/spec/Strix is never auto-authorized; out-of-scope results are dropped at ingestion. | DNS rebinding between preflight and execution is mitigated by per-request re-evaluation; a determined time-of-check/time-of-use gap is residual and bounded by the gateway. |
| 7 | **AI provider compromise / refusal bypass** | The Phase 3C provider router selects/retries deterministically; a refusal is recorded and never rerouted to evade a safeguard; a provider failure degrades the run (never a false "complete" or a false finding). The AI never writes Audivra state directly. | A compromised provider could return misleading analysis; bounded because findings require independent 6A verification and paths require 6B validation. |
| 8 | **Malicious local user** | V1 is a single-user, local-first deployment (see Known Limitations). The broker/policy still gate every capability; secrets are in the vault; the engagement authorization/scope/policy constrain what can run. | No application login in V1 — anyone with local access to the app and the vault key has operator rights. This is the explicit V1 boundary (§39 decision: local-only). |
| 9 | **Supply-chain / tool-image risk** | Sensor tools run from approved, reviewed runtimes; images are pinned and never pulled implicitly (explicit setup only); the Strix CLI + sandbox image are version-pinned and reviewed; the AI can never choose an image/runtime. | A compromised upstream of an approved image is residual; mitigated by pinning + explicit, reviewed upgrades. |
| 10 | **Secret leakage into reports/exports** | Exports are generated from stored, already-redacted state with no AI re-run; a canary export-safety test asserts no credential/session/vault/provider secret marker appears in any export kind. | None known; enforced by test. |

## V1 posture summary

- **Authorization, scope, environment, policy and runtime remain deterministic and authoritative** across
  every phase (1–6E). No phase added a way for the AI or a tool to change them.
- **Findings require 6A verification, paths require 6B validation, retests require 6C**, and specialist
  results are only signals — none of these can be bypassed.
- **Fail-closed where containment is unproven** (Strix live-target), **degrade honestly** when a dependency
  (AI, Docker, tool, provider) is unavailable, and **never claim completeness** (residual uncertainty is a
  first-class, reported concept).

## Accepted V1 residual risks

1. Local-only single-user auth (no application login) — the explicit V1 deployment boundary.
2. Strix live-target containment not empirically proven in this build → live specialist modes disabled.
3. Large-application coverage is representative/sampled, not exhaustive (reported as residual uncertainty).
4. A local attacker holding both the database and the vault key can decrypt stored secrets.
