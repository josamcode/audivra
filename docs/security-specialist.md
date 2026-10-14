# Specialist research-engine integration — Strix (Phase 6D)

Audivra can use the open-source [Strix](https://github.com/usestrix/strix) project as an **optional specialist
research engine**. Strix is never Audivra's brain, authority, scope authority or finding authority, and it
never replaces the Capability Broker, the Security Graph, Audivra verification or Phase 2C containment.

```
Audivra reasoning/planner → specialist capability → Audivra authorization + scope + policy → durable specialist run
  → Strix → structured artifacts → Audivra normalization → observations/candidates → 6A verification
  → findings / graph / attack paths / history
```

**Audivra remains the source of truth.** A Strix result is a *signal*, never a verified finding.

## Why a specialist, not the brain

Strix runs an autonomous offensive agent inside its own Kali-based Docker sandbox with real exploit tooling.
That is powerful but it is exactly why Audivra keeps it subordinate: it produces evidence that Audivra
*normalizes and independently verifies*. Audivra decides scope, authorization, severity, verification, paths
and history; the specialist only researches, within a target set and budget Audivra constructs.

## Reviewed version & license (§0, §18)

| Fact | Value (reviewed) |
| --- | --- |
| Project | `usestrix/strix` (the current official repo; not the archived ones) |
| License | Apache-2.0 |
| Distribution | PyPI `strix-agent`; CLI `strix`; self-update `strix --update` (Releases page is empty — pin by package version) |
| Install | `pipx` / `uv tool` / `pip`, or the installer; **Docker required** |
| Sandbox image | built from `containers/Dockerfile`, base `kalilinux/kali-rolling` (nmap, nuclei, sqlmap, ffuf, httpx, katana, semgrep, a Caido proxy, a browser, a Python exploit runtime, …) |
| CLI inputs | `-t/--target` (dir / GitHub URL / live URL / OpenAPI file / `postman://`), `--target-list`, `--instruction`, `-n/--non-interactive`, `--scan-mode`, `--runs-dir` |
| Output | per-run directory `strix_runs/<run>`; findings carry CVSS + OWASP; structured results preferred over the terminal UI |
| Provider | `STRIX_LLM` (e.g. `anthropic/claude-sonnet-4-6`), `LLM_API_KEY`, optional `LLM_API_BASE`; config in `~/.strix/cli-config.json`; providers incl. OpenAI/Anthropic/Google/… |
| Integrations | Strix Cloud and MCP servers load only on explicit opt-in; the local viewer binds `127.0.0.1` |

The approved CLI version and sandbox image **digest** are pinned at setup (`STRIX_PINNED_CLI_VERSION`,
`STRIX_PINNED_SANDBOX_IMAGE`). Audivra never auto-upgrades; a mismatch is reported as `version-mismatch` and
requires explicit review.

## Integration spike & containment decision (§1, §2, §7)

The spike (host processes, containers, networks, cancellation, cleanup) must be run by an operator against
**local fixtures only** before any live-target mode is enabled. In this build the live-target spike has **not**
been empirically completed, and the Kali sandbox manages its own network, so Audivra **fails closed**:

- **`source-only`** (a reviewed, staged source tree; no target network) is the enabled default.
- **Structured-artifact ingestion** is enabled.
- **`local-controlled-web` / `authorized-staging`** (live target) are **disabled by default**; they are only
  offered when an operator sets `STRIX_LIVE_CONTAINMENT_PROVEN=1` after proving, with local fixtures, that the
  sandbox's target traffic is confined to an Audivra execution network/gateway and that out-of-scope fixtures
  receive zero traffic. **Production is always disabled** (§39). Phase 2C is never weakened to ease this.

Ownership: the Strix CLI runs as an Audivra-owned subprocess (`killOwnedForExecution`, tree-killed on
cancel/timeout). Its sandbox containers are owned by an `audivra-<executionId>-` name prefix and removed by
**exact name** on cleanup — never a wildcard or a global `docker prune`. If an unowned resource appears during
a test run, the test fails and the integration is investigated (§9).

## The specialist-engine boundary (§3–§5)

A small `SpecialistEngine` (`packages/security/src/specialist/engine.ts`) exposes `availability` / `run` /
`cleanup`; it is not a general execution framework. Strix is exposed as one reviewed capability
`specialist.strix-research` (`capability.ts`) so every run is authorized through Audivra's broker (scope +
authorization + policy + environment). **No raw CLI flags, instructions, provider secrets or Docker options
are ever exposed to a model or user** — the only input is a typed scope (`findingIds`/`resourceRefs`/
`stagedSourceRef`) + mode; Audivra builds every flag, budget and network setting (§5, §20, §35).

## Provider & secrets (§15, §16, §44, §45)

The LLM provider for Strix is a **separate trusted profile** resolved outside AI-visible state; only a profile
id and model label are persisted — the key is read from the environment only when launching the subprocess and
never appears in events, artifacts or the graph. A refusal from Audivra's own provider does **not** run Strix
(Phase 3C refusal semantics are preserved); Strix runs only when its capability is independently selected and
policy permits it. Telemetry and external integrations (Strix Cloud, web search, remote report services) are
disabled by default in the launch env; any data that could leave the machine is documented here and off unless
explicitly configured.

## Durable run, ingestion & the verification boundary (§21–§31)

A run is a first-class durable record (`security_specialist_runs`): engine + pinned version, Audivra-built
mode/targets, the owning execution, provider profile id + model, lifecycle state, bounded artifact refs and
the per-result imports. The structured artifact is stored as bounded evidence (untrusted external-tool data).
Each native result is normalized into an **observation** (`web-signal` for a URL, `source-finding` for a
source location), recorded as a `tool-heuristic` from tool `strix` with confidence 0.5 — the engine's own
severity/category are kept only as source metadata, never copied into Audivra severity.

**A Strix result is never written to `security_findings` as verified.** A single-tool specialist observation
is not finding-worthy; it becomes a candidate only through the existing 6A corroboration/comparison doors (two
independent tools on the same observation → a candidate → verification → finding). Out-of-scope results are
dropped (a discovered target is never authorized, §13). Strix relationship/narrative claims are source
evidence only — they go through 6B path validation, not directly into an attack path (§31). Strix reruns feed
6C retests; they do not create a parallel history (§32). Entity resolution maps results to graph entities by
normalized URL / source path, or raises a gap rather than attaching to the wrong entity (§29).

## Availability, coverage & honesty (§17, §33, §34, §43)

Availability is one of `ready / needs-setup / missing / version-mismatch / provider-not-configured /
docker-unavailable / disabled / error`; a missing engine degrades gracefully and Audivra's own sensors and
reasoning keep working. Specialist coverage is reported **separately** from deterministic sensors, with the
explicit caveat that a clean or partial run never means the application is secure. A provider-unavailable,
budget-stopped, cancelled or failed run is represented as such and is never interpreted as a clean target.

## API, UI & planner (§35–§38)

Bounded APIs: availability, run list/detail, signals, coverage, request, cancel — and nothing for raw flags,
instructions, secrets or Docker. The web Specialist section shows availability/version/modes, runs with their
completion state, imported signals and any Audivra finding a signal eventually corroborated, and artifacts,
keeping Audivra terminology primary. The Phase 4/5 planner may propose the specialist as one typed capability
with `cost-class: very-high`; it is never the default action — cheaper focused capabilities are preferred when
they can resolve the same uncertainty.

## Testing (§40–§53)

A **deterministic fake engine** (same adapter contract, no Docker/provider) carries the unit tests, the
integration test and the benchmark and CI — the normal suite never needs paid AI or Docker. The optional
real-Strix fixture test runs only when explicitly configured, never in CI, never against an external host, and
cleans up exactly its owned resources. See [testing.md](testing.md).

## Setup (§19)

Nothing is installed or pulled during `pnpm install`, startup, dev or the test suite. Run the explicit setup
(`pnpm setup:strix` to inspect; `pnpm setup:strix --confirm` to perform the disk-checked sandbox-image pull);
it never prunes Docker. Enable with `STRIX_ENABLED=true` and a configured provider profile.

## Limitations

- Live-target containment is not empirically proven in this build → live modes are disabled (fail-closed).
- Cross-process live cancellation of a running engine relies on the wall-clock timeout + startup reconcile;
  same-process cancel (tests, single-process backend) is immediate.
- The exact `strix_runs/<run>` result schema is reviewed and mapped per pinned version by the adapter.
- Not built here (Phase 6E+): a final autonomous-researcher orchestration, running Strix on every assessment,
  replacing Audivra hypotheses with Strix reasoning, or a large specialist-agent hierarchy (§55).
