# Release checklist

Run before tagging an Audivra release. Everything here is verifiable; an item that cannot pass must be documented
and justified (§76), not skipped silently.

## Validation sweep

- [ ] `pnpm typecheck` — all packages plus tests, scripts and E2E (`tsconfig.tests.json`).
- [ ] `pnpm lint` — clean.
- [ ] `pnpm build` — the web app builds (other packages ship as TypeScript, covered by `pnpm typecheck`).
- [ ] `pnpm test:unit` — green.
- [ ] `pnpm test:integration` — green (real PostgreSQL + fixtures), including:
  - [ ] the export **secret-safety canary** across every export kind + the combined report + diagnostics;
  - [ ] the **fresh-database migration** test (all migrations apply, exactly the expected tables, idempotent re-run);
  - [ ] the **production-readiness** test (diagnostics, owned-only inventory, deterministic report, zero owned
        processes after a clean run).
- [ ] `pnpm test:e2e` — green, including the Phase 6F **golden** (full assessment → client report) and
      **failure/degraded** paths.
- [ ] Docker-gated isolation/egress integration tests — run where Docker is available, or record them as skipped.
- [ ] Website Audit regressions (the original product) — unaffected.

## Product readiness

- [ ] **Version** pinned: `AUDIVRA_VERSION` and the root `package.json` version agree and match the tag.
- [ ] `pnpm run doctor` on a clean environment reports `ready` (or a documented `degraded` for intentionally-absent
      optional components), with every unmet check carrying a remediation.
- [ ] `pnpm run demo` runs end to end against the bundled fixture and writes a client HTML report (no external
      target, no AI, no Docker required).
- [ ] The combined client report exports (JSON + self-contained HTML) are produced from stored state with **no AI
      re-run**, carry the correct schema version, and contain **no secrets** (canary test green).
- [ ] Every list read / export is bounded (§33) — no unpaginated or unbounded query.
- [ ] Resource management is Audivra-owned only — no path performs a global Docker prune (§24/§25).

## Documentation

- [ ] [getting-started.md](getting-started.md) — install, workflow and safety summary current.
- [ ] [operations.md](operations.md) — diagnostics, disk/resource, concurrency, backup/restore/DR, upgrade,
      deployment model current.
- [ ] [known-limitations.md](known-limitations.md) — honest boundaries incl. the V1 product boundaries current.
- [ ] [security-threat-model.md](security-threat-model.md) — threats and V1 residual risks current.
- [ ] [v1-architecture-review.md](v1-architecture-review.md) — KEEP / CLEAN UP / HARDEN / DEFER decisions current.
- [ ] [testing.md](testing.md) — suite rows and the V1 performance baseline current.
- [ ] README / getting-started describe the same supported commands (`pnpm run setup` / `doctor` / `demo`).

## Sign-off

- [ ] The acceptance report ends with `AUDIVRA V1 SECURITY PLATFORM: READY` — or `NOT READY` with a list of real
      blockers only.
- [ ] No V1.1 feature expansion has been started: broader auth, hosted/multi-user deployment, HTTPS egress mediation
      and a load-test harness remain explicitly future work.
