# Operations

How to run, diagnose, back up, upgrade and deploy Audivra's security platform. Audivra V1 is **local-first and
single-user** — read [Deployment model](#deployment-model) first; it frames everything else.

## Diagnostics: `pnpm run doctor` and `GET /api/security/health`

Both return the same deterministic diagnostics. `pnpm run doctor` prints them for an operator and exits non-zero
only when a **required** check is blocked; `GET /api/security/health` returns the JSON for the UI or monitoring.

The report is **read-only** — it never installs, pulls, prunes or mutates anything. It covers:

| Check | Required | Meaning when unmet |
| --- | --- | --- |
| PostgreSQL | yes | Audivra cannot store or read any state; it cannot run. |
| Database migrations | yes | The security schema is missing; run `pnpm run setup`. |
| Docker | no | Isolated sensors and the specialist cannot run; comparisons and research still work. |
| Disk space | yes | Below `SECURITY_MIN_FREE_DISK_MB` (default 2048) executions are refused. |
| Credential vault key | yes | Identity-aware execution and session establishment are unavailable. |
| AI provider | no | AI reasoning is unavailable; deterministic analysis and verification still work. |
| Specialist engine (Strix) | no | Optional deep research is unavailable; all core capabilities still work. |

Each check carries a **state**, a **consequence** (what is lost) and a concrete **remediation**. The overall state
is `ready` (all required checks ready), `degraded` (only optional gaps) or `blocked` (a required check unmet). The
report also lists the **Audivra-owned resource inventory** (storage used, owned processes, owned containers/networks,
active and unfinished executions) and installed-vs-approved tool versions.

## Disk and resource management

Audivra manages **only resources it created**. Owned containers and networks are name-prefixed `audivra-`; workspaces
and artifacts live under the data directory. Cleanup and inventory operations act on that owned set alone.

- **Audivra never runs a global `docker prune`** and never removes a container, network, image or volume it did not
  create. A foreign container that happens to be running is always left untouched (proven by the isolation/egress
  integration tests).
- Executions are refused when free disk falls below `SECURITY_MIN_FREE_DISK_MB`; `pnpm run doctor` shows current
  headroom. Raise the floor or free space — the doctor's remediation says which.
- Interrupted executions are reconciled, not leaked: a crashed worker's owned containers, networks and processes are
  reclaimed on restart (owned-only). After a clean run the owned-process count returns to zero (gated by the Phase 6F
  resource-leak test).

## Concurrency

`SECURITY_EXECUTION_CONCURRENCY` (default 2, max 16) caps how many security capability executions run at once across
every worker sharing the database; it is also the worker's pg-boss concurrency for the execution queue. It is
**operational capacity, not security policy** — security policy lives in versioned policy profiles. There is no
per-engagement concurrency limit in V1.

## Backup and restore

Two things must be backed up, and they are kept deliberately separate:

1. **PostgreSQL** — all engagement state, graph, findings, reports and audit trail. Use ordinary PostgreSQL backup
   (`pg_dump` / `pg_basebackup` / your managed snapshot). This is the system of record.
2. **The vault key** (`AUDIVRA_SECRET_KEY` / `AUDIVRA_SECRET_KEY_FILE`, or the persisted local dev key under the data
   directory). It is intentionally **kept out of the database**, so a database backup does **not** contain it — back
   it up separately, through your secrets manager.

Restore = restore the database, then provide the **same** vault key. With the database but not the key, stored
credentials/sessions are unrecoverable (everything else restores). With the key but not the database, there is no
state to decrypt. Never put the vault key in the database backup — that would defeat the separation.

### Disaster recovery

V1 has **no built-in HA, clustering or point-in-time service**. DR is: restore PostgreSQL from your most recent
backup, supply the vault key, run `pnpm run setup` (idempotent: it creates/migrates the database), then `pnpm run
doctor` to confirm `ready`/`degraded`. Recovery point and recovery time are whatever your PostgreSQL backup policy
provides.

## Upgrades and migrations

Schema changes are **additive, forward-only** Drizzle migrations. To upgrade:

1. Back up PostgreSQL (and confirm you hold the vault key).
2. Pull the new version and `pnpm install`.
3. `pnpm run setup` (or `pnpm db:migrate`) applies any new migrations. Migrations are idempotent — re-running applies
   nothing new.
4. `pnpm run doctor` confirms the schema is present and the system is `ready`/`degraded`.

Migrations are verified against a **brand-new** database by the Phase 6F migration test (all migrations apply cleanly
and produce exactly the expected schema), so a fresh install and an upgrade exercise the same path.

## Deployment model

Audivra V1 runs as the API + worker + web app against a PostgreSQL database, bound to `127.0.0.1`, for a **single
trusted operator on their own machine**.

- **No authentication, users, roles or multi-tenancy — by design.** The trust boundary is the local machine and the
  OS account that runs Audivra; anyone who can reach the port is the operator. This is a deliberate, documented V1
  decision (see [known-limitations.md](known-limitations.md#v1-product-boundaries) and the
  [threat model](security-threat-model.md)), chosen because Audivra is an operator's own assessment tool, not a shared
  service.
- **What must change before any shared/hosted/multi-user deployment:** real authentication and authorization, network
  exposure hardening (TLS, not raw loopback), per-user isolation of engagements and vaults, and a managed secrets
  source for the vault key. None of this is partially built in V1 — it is future work, to be designed deliberately
  rather than switched on.
- **Secrets:** set `AUDIVRA_SECRET_KEY` (or `_FILE`) from a real secrets source for anything beyond local development;
  the shipped persisted dev key is for local use only. `pnpm run doctor` flags when you are still on the dev key.
- **Optional components** (Docker, AI provider, Strix) are never auto-installed and degrade gracefully; the health
  report always says exactly what is usable.

See also: [getting-started.md](getting-started.md) (install & workflow), [security.md](security.md) (safety model),
[known-limitations.md](known-limitations.md) (honest boundaries), [release-checklist.md](release-checklist.md).
