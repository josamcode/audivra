# V1 architecture review (Phase 6F)

A final audit of the completed security platform before V1. The codebase is mature: zero `TODO`/`FIXME` in
`packages/*/src` and `apps/*/src`, 16 additive migrations, a per-area doc for every subsystem, and 10 security
E2E specs. The guiding rule for 6F (§1, §75): do **not** refactor working systems for style, and add **no** new
security features — only changes that materially improve maintainability, correctness, reliability or
usability.

## KEEP (working, coherent — do not touch)

- The deterministic authority core: scope engine, Capability Broker, environment/risk policy, readiness, the
  isolated-container backend + controlled egress gateway, and `@audivra/tool-runtime` owned-process/container
  registry. These are the security backbone and are consistent across phases.
- The knowledge pipeline: observations → graph projection → hypotheses → comparisons → candidates → 6A
  verification → findings → 6B attack paths → 6C history. Each stage keeps its logic in its own module; the
  6E researcher orchestrates without duplicating any of it.
- The per-area read/report/export services (findings, attack paths, history, specialist) — each builds from
  persisted state with no AI re-run. 6F composes them; it does not replace them.
- The vault secret boundary + redaction + canary tests.
- The durable pg-boss worker-per-queue pattern (one stately queue per subsystem, idempotent recovery).

## CLEAN UP (small, safe, in-scope for 6F)

- **Single source of truth for versions** — surface one `AUDIVRA_VERSION` + the policy/prompt/tool version
  pins in reports and diagnostics (previously implicit). Done in 6F (`packages/config` version + report
  footer + `pnpm doctor`).
- **One operational entry point** — diagnostics were split across `/api/system/ai`, per-engagement readiness
  and tool availability. 6F adds a single `pnpm doctor` + `/api/system/health` aggregation (reusing those
  reads, not replacing them).
- **One client-facing report** — the three per-area reports are composed into one `SecurityReport`
  (executive + technical) rather than asking a client to read three JSON endpoints.

## HARDEN (reliability/safety, in-scope for 6F)

- **Export secret-safety** — extend the canary test to span every security export kind (findings, attack
  paths, history, specialist, the combined report).
- **Resource/disk visibility + owned-only cleanup** — a deterministic audit of Audivra-owned processes,
  containers, networks and workspaces (never a global Docker prune), plus a leak gate asserting no
  `audivra-`/QA leftovers after automated validation.
- **Migration-from-scratch test** — assert all additive migrations apply to a fresh database and every
  expected security table exists.
- **Pagination/bounding audit** — confirm every security list repo clamps with `Math.min(limit, CAP)` so no
  endpoint returns unbounded engagement data (documented in 6F).

## DEFER (explicitly out of V1 scope / 6G+)

- Application login / multi-user tenancy — V1 is local-only by decision (§39); the migration-safe assumptions
  are documented so a future auth model is additive.
- Containerizing the Audivra worker itself (§66) — would conflict with the worker's required host Docker
  control for sensors/specialist; kept on the host, documented.
- Distributed/remote workers (§67) — documented interface boundary only.
- Incremental graph projection (§31) — full-engagement re-projection is fast enough on realistic fixtures;
  kept, with the decision documented, to avoid speculative complexity.
- Real-model benchmark as a CI gate — remains optional/manually invoked (CI uses deterministic fakes).
- Deep performance tuning beyond the measured baseline, and a multi-screen graphical setup wizard — the CLI
  `setup`/`doctor` + the readiness UI are the V1 setup surface.

## Unsafe-default / coupling check

- No dead feature flags or stale compatibility shims were found in the security packages.
- Large downloads (sensor images, Strix sandbox) are never implicit — explicit `setup`/`setup:strix` only.
- Docker operations are always owned-resource-scoped; no code path performs a global `docker prune`.
- Production defaults are conservative (high-impact risk is `opt-in`, production research is non-deep, live
  specialist modes disabled).
