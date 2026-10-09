# Security executions (Phase 2A: the durable runtime · Phase 2B: the isolated backend · Phase 2C: controlled egress)

Phase 1 ([security-engagements.md](security-engagements.md)) decides *whether* a capability may run. Phase 2A
adds the platform that runs an allowed request **durably**: persisted with an immutable snapshot of the trusted
configuration it was approved under, carried out by the existing pg-boss worker, cancellable, bounded by
Audivra's own timeout and limits, and reconciled after a crash. Phase 2B adds the **isolated container backend**
behind the same lifecycle: capabilities that declare it run in an approved, execution-scoped container
([below](#phase-2b-the-isolated-container-backend)). Phase 2C adds **controlled network egress**: a capability
that declares it reaches the network only through an Audivra-controlled, execution-private gateway that enforces
the trusted scope ([below](#phase-2c-controlled-network-egress)).

> Phases 2A, 2B and 2C are runtime engineering only. They add no scanner, no vulnerability test, no active network
> testing and no new security tooling. The new capabilities — `diagnostic.runtime-check` (in-process),
> `diagnostic.isolated-check` (isolated, no network) and `diagnostic.egress-check` (isolated, scoped egress) — only
> prove the platform; the first two never contact anything, and the third only requests the engagement's own
> in-scope target plus deliberately out-of-scope probes that are denied.
>
> **Phase 2C mediates HTTP egress; it does not provide HTTPS/CONNECT mediation, and containment is proven for this
> project's Windows + WSL2 + Docker Desktop setup, not asserted for arbitrary operating systems.** See the
> [guarantees and limitations](#phase-2c-limitations) below.

```
request ─► Capability Broker ─► decision (persisted) ─► [allowed] execution + trusted snapshot (persisted, hashed)
        ─► pg-boss job { executionId } ─► worker: ExecutionRuntime
        ─► verify snapshot → revalidate authority → resource preflight → workspace → ExecutionBackend
        ─► owned processes · evidence with provenance · lifecycle events ─► cleanup ─► final state
```

## Where it lives

| Layer | Location |
| --- | --- |
| Contracts | `packages/contracts/src/security-execution.ts` — statuses, transitions, failure kinds, snapshot, API views |
| Persistence | `security_executions` (migration `0004_security_executions`), `packages/database/src/repo/security-executions.ts`, queue `security-execution` in `queue.ts` |
| Runtime | `packages/security/src/execution/` — `snapshot`, `runtime`, `backend`, `workspace`, `artifacts`, `processes`, `handles`, `control` (cancellation), `service` (API reads), `store`, `submit` |
| Broker | `CapabilityBroker.submit()` in `packages/security/src/broker.ts` |
| Capability | `packages/security/src/capabilities/runtime-check.ts`, `isolated-check.ts`; `createRuntimeRegistry()` in `catalog.ts` |
| Isolated backend (2B) | `packages/security/src/execution/container-backend.ts`, approved runtimes in `runtimes.ts`, reviewed executor programs in `packages/security/executors/` (`executors.ts`) |
| Controlled egress (2C) | the gateway source `packages/security/gateway/main.ts` (bundled by `gateway-bundle.ts`), the network lifecycle in `container-backend.ts`, the networked executor `executors/egress-check.mjs` and capability `capabilities/egress-check.ts` |
| Worker | `apps/worker/src/security-executions.ts`, wired in `apps/worker/src/main.ts` |
| Process ownership | `reapStaleProcessesForExecution`, `liveOwnedForExecution` in `packages/tool-runtime/src/processes.ts` |
| API | `apps/server/src/routes-security.ts` (inspect and cancel only) |
| UI | *Executions* tab of an engagement (`apps/web/src/features/security/executions-tab.tsx`) |
| Operator script | `pnpm security:runtime-check <engagementId> [--hold <s>] [--note <text>] [--wait]` |

## The execution record

`security_executions` is a first-class entity, separate from the engagement: an engagement's status is a label for
people; an execution's status describes one run. Columns: id (`sx_…`), engagement, capability id and version,
status, environment, the configuration version it was approved against, correlation id, requester (actor), the id
of the allowing `capability.allowed` event, the **snapshot** and its **hash**, the pg-boss job id, the **runner**
(worker instance, host, PID and process start time, backend), heartbeat, cancellation request (time and actor),
the **result** persisted when the work ended, **exit** information, **failure** classification, and created /
started / finished / updated timestamps.

### Lifecycle

```
queued ──► preparing ──► running ──► finalizing ──► succeeded | failed | timed-out
  │            │            │                         (interrupted, if the worker dies)
  │            ├────────────┴──► cancelling ──► cancelled   (failed on cleanup failure; interrupted on shutdown)
  │            └──► failed (preflight)
  └──► cancelled (before it started) · failed (could not be queued)
```

| From | Allowed next states |
| --- | --- |
| `queued` | `preparing`, `cancelled`, `failed` |
| `preparing` | `running`, `finalizing`, `cancelling`, `failed`, `interrupted` |
| `running` | `finalizing`, `cancelling`, `failed`, `interrupted` |
| `finalizing` | `succeeded`, `failed`, `timed-out`, `interrupted` |
| `cancelling` | `cancelled`, `failed`, `interrupted` |
| `succeeded`, `failed`, `timed-out`, `cancelled`, `interrupted` | — (final) |

`finalizing` means the work ended (succeeded, failed or timed out) and the runtime is stopping owned resources,
checking artifacts and cleaning up; the result is persisted with that transition. `cancelling` means a cancellation
was requested and the runtime is stopping the work.

Every state change is a **guarded update** naming the states it may start from and, for a held execution, the
worker that must hold it (`updateSecurityExecution(db, id, { from, ownerId }, patch)`). A cancellation, a recovery
and a duplicate job delivery therefore cannot overwrite each other.

**Database guarantees** (trigger `security_executions_guard`): the snapshot, its hash and the identity columns
(engagement, capability and version, environment, configuration version, correlation id, requester, decision event,
creation time) can never be updated, and a row in a final state can never be updated at all.

### Failure classification

| Kind | Meaning | Example rules |
| --- | --- | --- |
| `preflight-failed` | Refused before anything ran | `execution.snapshot-invalid`, `execution.config-changed`, `execution.authorization-withdrawn`, `execution.engagement-not-runnable`, `execution.outside-window`, `execution.capability-changed`, `execution.input-invalid`, `resources.disk-low` |
| `executor-failed` | The capability reported an error | `executor.error`, `http.scope-violation`, `http.budget-exceeded` |
| `timeout` | Audivra's wall-clock limit was reached | `runtime.timeout` |
| `cancelled` | Stopped on request (a person, or Audivra when the engagement was paused/closed) | `execution.cancelled`, `execution.cancelled-before-start` |
| `artifact-limit` | Over budget or an invalid artifact | `artifact.budget-exceeded`, `artifact.outside-execution`, `artifact.type-not-declared`, `workspace.path-escape`, `workspace.link-escape` |
| `process-limit` | More processes than allowed | `runtime.process-limit` |
| `worker-interrupted` | The worker stopped while it ran | `runtime.worker-interrupted`, `runtime.shutdown` |
| `cleanup-failed` | Owned resources could not be stopped or the workspace not cleaned | `cleanup.failed` |
| `internal` | Unexpected platform error | `runtime.internal-error`, `execution.enqueue-failed` |
| `runtime-unavailable` | The backend the execution requires is not available — never replaced by another | `runtime.backend-unavailable`, `runtime.image-unavailable`, `runtime.docker-unavailable`, `resources.runtime-unavailable` |
| `runtime-failed` | The isolated runtime could not prepare, start or observe the container | `container.create-failed`, `container.start-failed`, `container.observe-failed`, `container.name-conflict` |
| `resource-limit` | A limit enforced at the container boundary was hit | `container.memory-limit` |

A non-zero exit of the executor is `executor-failed` (`container.exit-code`), an invalid result
`container.result-invalid`; a runtime registry change after the decision is `preflight-failed`
(`execution.runtime-changed`). The list stays extensible (an egress layer will add its own kinds).
Failure messages are redacted and bounded before they are stored.

## The trusted snapshot

When the broker accepts an allowed request it persists, once, the configuration the decision relied on:
engagement id and configuration version (and status), environment, authorization state and the ids of the
authorizations used, scope version, hash and full manifest, policy profile key and version with the effective risk and
mutation permissions, capability id/version/implementation/name/classes/declared evidence types, the **effective
limits**, the derived **runtime limits**, the capability input exactly as validated by its strict schema, the allowed
targets, the actor, and the allowing decision (event id, rule, time). The SHA-256 of its canonical JSON is stored
beside it.

The worker builds the executor's frozen context and all handles **from the snapshot only**. Before every run it
verifies the hash, the schema (strict — unknown fields are rejected) and that the snapshot agrees with its row. Job
payloads carry only the execution id, and neither a request nor a model has a field through which to replace any of
these values.

At start the runtime **revalidates authority** — it can only refuse, never widen or substitute current
configuration: the engagement must still exist and not be paused, completed, cancelled or invalid; its configuration
version must be the one the decision was made against (any change to environment, policy, scope, authorization or
lifecycle makes the approval stale — request again); every authorization the decision used must still be verified
and unexpired; the snapshot's testing window must be open. Then the Phase 1 resource preflight runs again (free disk,
engagement artifact budget, container images never pulled).

While an execution runs, pausing, completing or cancelling its engagement cancels it (checked every few seconds).

## Durable execution on pg-boss

- Queue `security-execution`, policy `exclusive` with `singletonKey = executionId`: a second send for the same
  execution while its job exists is a no-op. The job id is chosen before sending, so `execution.queued` is always
  recorded before a worker can start.
- The worker (`apps/worker/src/security-executions.ts`) claims a job's execution with a guarded `queued → preparing`
  transition inside a transaction holding an advisory lock, provided fewer than `SECURITY_EXECUTION_CONCURRENCY`
  executions are active across every worker sharing the database (also the queue's local concurrency). A claim that
  finds the limit reached waits; the execution stays `queued`.
- A delivery for an execution that is not `queued` never starts it again. `retryLimit: 2` lets pg-boss redeliver a job
  lost with a crashed worker: a never-started execution is then run; one that had started is reconciled (below).
- The worker heartbeats every held execution (`heartbeat_at`) and watches its record for a cancellation.
- On `SIGINT`/`SIGTERM` running executions are interrupted (owned processes terminated, cleanup, `interrupted`)
  before the remaining owned processes are killed.

Heavy work never runs in a Fastify request: the API only reads and requests cancellation.

## Execution backends

`ExecutionBackend` (`packages/security/src/execution/backend.ts`) is the seam for *how* an execution is carried
out. The runtime owns everything that must not depend on it — snapshot, lifecycle, timeout, cancellation, limits,
evidence, events, recovery — and asks the backend to:

| Step | `InProcessBackend` | `IsolatedContainerBackend` (2B) |
| --- | --- | --- |
| `prepare` | create the workspace areas, write `inputs/input.json` | check the pinned image (never pull), stage `inputs/` (program input + reviewed program), `docker create` |
| `start` | call the reviewed `execute` with the frozen context and handles | `docker start`; an owned `docker wait` helper observes the exit |
| `observe` | resolve with its result or error | inspect the exit, cap the output, read `outputs/result.json` (bounded), run the host-side `collect` |
| `cancel` | abort the execution's stop signal | SIGTERM through the container's init (the program may flush) |
| `terminate` | abort and terminate the owned processes, exactly | SIGKILL the exact container (if still running) |
| `cleanup` | remove scratch space (idempotent) | remove the exact container, verify it is gone, remove scratch space (idempotent; throws if anything remains) |
| `resume` | nothing outlives the worker | recovery: report the container's state without starting, reading or changing anything |

Phase 2B extended the interface only where recovery and observability needed it: a `resume` step, optional
`ownedResources` / `removeOwnedResource` for reconciling containers of final executions, an event sink in the spec
and container facts on the exit. The lifecycle is the Phase 2A one; there is no second lifecycle.

The in-process backend cannot pre-empt JavaScript that ignores the stop signal. The runtime then **abandons** it after
the grace period: its owned processes are terminated, its handles are revoked (no further evidence, processes or
network), and the execution is finished and marked `abandoned` in its exit information. An isolated execution has
no such gap: its container is killed.

## Workspace

```
.local-data/security/<engagement>/executions/<execution>/
  inputs/     written by the runtime (validated input)
  outputs/    files the capability produces
  artifacts/  files the capability produces for evidence
  tmp/        scratch space — removed at cleanup
```

Every path the runtime hands out or accepts is resolved inside the execution directory: absolute paths, drive
letters, NUL bytes, traversal and symbolic links or junctions leading out are refused (`workspace.path-escape`,
`workspace.link-escape`). Process working directories are workspace areas; stdout/stderr files are confined to
`outputs/`. Cleanup is idempotent and keeps `outputs/` and `artifacts/` (evidence points at them). Artifact paths stay
relative to the engagement workspace, as in Phase 1, so they keep pointing at the execution that produced them.

## Process ownership

Capabilities start processes only through `handles.processes.run()`: registered in the ownership registry under the
execution id (PID + OS creation time + image), confined to the workspace, given the execution's stop signal, and
counted against the process limit. Cancellation, timeout, shutdown and cleanup terminate **exactly** these
registry entries (`killOwnedForExecution`), as process trees rooted at the recorded PID. There is no killing by
name, image, pattern or wildcard anywhere.

Recovery reconciles a crashed worker's records with `reapStaleProcessesForExecution(executionId)` — the same
verification as the start-up reaper (the owning instance must be gone; PID **and** creation time and image must still
match) limited to that execution's records; records of other executions, audits and live instances are never
touched.

Observation (Windows): Node starts child processes inside a kill-on-close job object, so the OS ends a crashed
worker's in-process children with it; recovery then finds them already gone. On Linux/macOS, or for detached
processes and containers, they survive as orphans and are terminated by the verified reconciliation above. Both
cases are tested.

## Cancellation

```
POST /api/security/executions/:id/cancel
  queued              → cancelled at once (nothing ran)
  preparing / running → cancelling → worker sees it within ~1 s → graceful stop (signal)
                        → after the grace period, exact termination of owned processes
                        → evidence registration closed → cleanup → cancelled
  cancelling / cancelled → no change (idempotent, 202)
  finalizing / final     → 409
```

Cancelling execution A never affects execution B or any process the execution does not own (tested with real
processes).

## Timeout

The wall-clock limit is Audivra's, not the capability's: `snapshot.runtime.timeoutSeconds`, counted from the moment
the worker takes the execution. When it fires the runtime sends the graceful stop, waits the grace period, terminates
the owned processes exactly, and records `timed-out` (`runtime.timeout`), even if the capability ignores the request.

## Crash and restart recovery

At start-up the worker runs `recover()` before the general process reaper (so orphans are attributed to their
execution), and the same reconciliation runs when a job is redelivered for an execution whose worker is gone. A
worker is alive if, on this host, a process with its PID exists *and* started when the recorded worker did (on another
host: a heartbeat within two minutes). Executions of live workers are never touched.

| Found | Action |
| --- | --- |
| `queued`, job lost | job sent again (`execution.recovered`, `requeued`) |
| `finalizing` with a stored result (completed work awaiting finalization) | finished from the result: budget check, cleanup, final state |
| `cancelling` | the requested cancellation is completed |
| `preparing` / `running` | `interrupted` (`worker-interrupted`); **never re-run** — the work may have had effects |
| still-running owned process | verified by PID + creation time + image, terminated, recorded `reaped` |
| dead owned process | recorded `gone` |

The execution is first adopted with a guarded update (a second recovering worker loses the race), so recovery is
idempotent: a second pass changes nothing.

## Evidence and artifacts

Evidence uses the existing `evidence` table and engagement-owned rows. The runtime registers evidence only while the
execution is running, only of a type the capability declared, with metadata under 64 KB and, for an artifact, only a
regular file inside this execution's workspace (not `inputs/` or `tmp/`) that fits the remaining artifact budget. The
artifact's size and SHA-256 are added; provenance (execution, correlation, capability and implementation, allowing
decision, environment, scope version/hash, configuration version, policy profile, authorization ids, sensitivity) is
filled in by the runtime, never by the capability. `security_execution_id` links every row to its execution.

Runtime events (`security_events`) and target evidence stay separate. The artifact endpoint serves only files
registered as evidence, small text inline and redacted, everything else as a download.

## Limits

```
policy profile ceilings ─► engagement (can only narrow) ─► decision ─► snapshot.limits ─► runtime
```

| Runtime limit | Derived from | Enforced |
| --- | --- | --- |
| `timeoutSeconds` | `limits.executionTimeoutSeconds` (≤ the capability's `timeoutProfile.maxSeconds`) | runtime timer, exact termination |
| `maxArtifactBytes` | `limits.maxArtifactMb` | at every registration and on the execution's files at finalization |
| `maxProcesses` | capability `resourceProfile.spawnsProcesses` (0, or 4) | `handles.processes` |
| `cancelGraceSeconds` | platform constant (5) | stop path |
| request count, rate, concurrency, response size | `limits.*` | the Phase 1 scoped HTTP client, built from the snapshot |
| execution concurrency | `SECURITY_EXECUTION_CONCURRENCY` (operational capacity, default 2) | claim under an advisory lock |

There is no second limits model: every runtime value is computed from the Phase 1 effective limits or registered
metadata by `runtimeLimitsFor()`.

## Events

Appended to the Phase 1 `security_events` with the execution id: `capability.requested` and `capability.allowed` /
`capability.denied` (the decision), then `execution.requested` (snapshot hash, limits, targets), `execution.queued`
(job id), `execution.preparing`, `execution.started`, `execution.cancel-requested` (with the actor),
`execution.cleanup-started`, `execution.cleanup-completed`, and one of `execution.completed`, `execution.failed`,
`execution.timed-out`, `execution.cancelled`; `execution.recovered` for reconciliation. Isolated executions add one
event per container step: `execution.container-preparing`, `-created`, `-started`, `-exited` (exit code, memory
limit, duration), `-stop-requested`, `-terminated`, `-removed` and `-cleanup-failed`. Events carry identifiers,
states and short summaries — never raw logs — and are redacted at the persistence boundary.

## API and UI

| Endpoint | Purpose |
| --- | --- |
| `GET /api/security/engagements/:id/executions` | list (status, capability, environment, timestamps, duration, failure) |
| `GET /api/security/executions/:id` | detail: trusted configuration (without the input), limits, runner, result summary, exit, failure |
| `GET /api/security/executions/:id/events` | the execution's audit-trail entries |
| `GET /api/security/executions/:id/evidence` | its evidence with provenance |
| `GET /api/security/executions/:id/artifacts/*` | a registered artifact |
| `POST /api/security/executions/:id/cancel` | request cancellation (idempotent) |

There is deliberately no endpoint that creates, runs, retries or changes an execution, and none that takes a command,
an executable, an image or a container option (tested). The *Executions* tab lists an engagement's executions and
shows one in detail — status, environment, the runtime (in-process, or isolated container with its runtime and
resource profile), the container's outcome and whether cleanup removed it, timestamps, duration, the configuration
it was approved under, limits, failure reason, events, evidence with artifact links — with *Cancel execution* while it
can be cancelled. It has no way to start anything. The detail's `trusted.isolation` reports the mode, runtime id and
version, network and container limits.

## The runtime check

`diagnostic.runtime-check` (passive, read-only, `requiresNetwork: false`, `spawnsProcesses: true`) proves the whole
chain: it holds an owned, idle child process (Node itself) for `holdSeconds`, writes
`artifacts/runtime-check.txt`, registers it as `tool-result` evidence and returns structured metadata. Its single
target is the engagement's own URL, so the request is scope-checked like any other, but nothing is sent to it.

It is registered with the execution runtime (`createRuntimeRegistry()`), not in the security capability catalog shown
to people and agents (`createDefaultRegistry()`), because it assesses nothing. Platform code requests it through the
broker; for people, `pnpm security:runtime-check <engagementId> [--hold <s>] [--wait]` does the same and follows the
result (the worker must be running).

## Guarantees today vs. later

| Guarantee | Phases 2A / 2B | Needs a later layer |
| --- | --- | --- |
| An execution runs only what was decided, under the configuration it was approved for | Snapshot persisted, hashed, immutable (trigger), verified and revalidated before start; it records the execution mode, the pinned image and the container limits | — |
| Execution and decision cannot be created over HTTP or by a model | Only `CapabilityBroker.submit()` creates executions; job payloads carry an id only | — |
| An isolated capability never runs outside its container | No in-process implementation exists for it; selection from the snapshot only; no fallback; in-process path refuses it | — |
| Timeout and cancellation are Audivra's | Runtime timer and stop path; owned processes and the exact container terminated | Pre-emption of non-cooperative *in-process* code (it can only be abandoned) |
| Processes and containers are attributable and terminated exactly | Registry by execution id (PID + creation time); containers by derived name + labels; no pattern kills, no pruning | — |
| Files stay in the execution workspace | In-process: everything mediated by the runtime. Isolated: enforced by the container — only the execution's areas are mounted | OS-level confinement of in-process code |
| Network access is in scope | In-process: the scoped HTTP client. Isolated: no network at all | The controlled egress layer (isolated capabilities that need the network) |
| A crashed worker leaves no running execution, orphaned process or container behind | Start-up and redelivery reconciliation, conservative and idempotent | — |

## Phase 2B: the isolated container backend

### Execution modes and backend selection

A capability declares how it must be carried out — `execution: { mode, runtime }` in its metadata:

| Mode | Backend | For |
| --- | --- | --- |
| `in-process` (default when omitted) | `InProcessBackend` | trusted, lightweight **platform** capabilities: reviewed code that needs Audivra's in-process handles, e.g. `discovery.http-observe` (whose network access *is* the scoped HTTP client) and `diagnostic.runtime-check` |
| `isolated-container` | `IsolatedContainerBackend` | anything that runs tool or target-facing code later phases add; the capability names an **approved runtime id** (`node-sandbox`), never an image, path or option |

The implementation must match the mode exactly (checked at registration): an in-process capability provides
`execute`; an isolated one provides a reviewed executor `program` (a file in `packages/security/executors/`),
`programInput` and a host-side `collect` — and **no** `execute`, so it cannot run in-process at all. Isolated
capabilities must name an approved runtime, may not require the network (no egress layer yet), may not name an
image and start no host processes.

**Selection is deterministic and cannot be downgraded.** The broker records the mode, the approved runtime with its
digest-pinned image and the container limits in the trusted snapshot. The worker picks the backend from the verified
snapshot, checks that the registered capability still declares the same mode and that the approved runtime is
unchanged, and otherwise refuses (`execution.capability-changed`, `execution.runtime-changed`). A mode the worker has
no backend for fails with `runtime-unavailable` — it is never run another way. Requests have no field for a backend
(strict schemas), and `CapabilityBroker.execute()` (the in-process path used by tests and the agent gateway) refuses
isolated capabilities at the decision (`runtime.isolation-required`). All of this is tested.

### Approved runtimes

`packages/security/src/execution/runtimes.ts` is the whole registry — versioned code, like policy profiles:

| Id | Image | Purpose | Limits |
| --- | --- | --- | --- |
| `node-sandbox` v1 | `node:24-alpine` pinned `node@sha256:ebfe2f90…ec1c1` (≈ 242 MB, already present for the egress spike) | runs Audivra's reviewed Node.js executor programs | 256 MB memory, no swap · 0.5 CPU · 64 PIDs · 16 MB `/tmp` |

Images are never pulled. The broker's resource preflight refuses an isolated capability whose pinned image is not
present (`resources.runtime-unavailable`, with the explicit `docker pull …@sha256:…` command and a reminder to check
free disk first), and the backend checks again before creating anything.

### Container identity and ownership

Each isolated execution gets exactly one container, named `audivra-<execution id>` (e.g. `audivra-sx-4igqx3var89wxv`)
— derived, never chosen, so it needs no storage — with labels `audivra.owner=security-execution`,
`audivra.execution`, `audivra.engagement`, `audivra.capability` and `audivra.runtime` (identifiers only; no secrets in
names, labels or the environment — the container gets no environment from Audivra). A container is treated as an
execution's only when its exact name **and** its labels match that execution **and** this database has that
execution; everything else (other installations sharing the Docker daemon, unrelated containers) is left alone.

The worker alone talks to Docker, through the docker CLI as owned helper processes of the execution (tool
`runtime:docker`; the long-running `docker wait` is persisted in `owned_processes`, short commands stay in the
in-memory registry). Helper processes are not capability processes: they are excluded from the execution's process
counts, and killing one never touches the container.

### Filesystem boundary

```
.local-data/security/<engagement>/executions/<execution>/       (the Phase 2A workspace — no other location)
  inputs/     → /audivra/inputs     read-only   program input (input.json) and the reviewed program
  outputs/    → /audivra/outputs    read-write  result.json, container.log, anything the program writes
  artifacts/  → /audivra/artifacts  read-write  files meant to become evidence
  tmp/        (not mounted; the container gets a private 16 MB tmpfs at /tmp)
```

Nothing else is mounted: not the repository, the user's home, other executions' or engagements' workspaces, unrelated
Audivra data, the host root or the Docker socket. The root filesystem is read-only. Inputs are staged before start
and only contain what the program needs (`programInput`, e.g. `{ marker, holdSeconds, note }`) — never the trusted
snapshot, authorization, scope, policy, engagement state or any credential; the control plane stays outside.

### Container security profile

| Setting | Value |
| --- | --- |
| user | non-root: the worker's own uid:gid on POSIX hosts (65534 if the worker is root), `1000:1000` on Windows; root is refused |
| capabilities | `--cap-drop ALL` (effective set 0), no `--cap-add` |
| privilege escalation | `--security-opt no-new-privileges`; Docker's default seccomp profile stays on; never `--privileged` |
| namespaces | private PID and IPC (`--ipc private`), no host PID/IPC/UTS/user namespace, `--hostname audivra-executor` |
| network | `--network none` (only `lo`) |
| filesystem | `--read-only` root, `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m`, the three bind mounts above |
| process | `--init` (signals reach the program; zombies are reaped), `--restart no` |
| output | `json-file` log driver capped at 1 MB × 1 file |
| image | digest-pinned reference of the approved runtime |

Every value comes from `containerCreateArgs()`, one function, unit-tested flag by flag. The integration test reads
the same profile back from `docker inspect` and from inside the container (uid, read-only root and inputs, writable
`/tmp` and outputs, no Docker socket or host paths, only `lo`, cgroup `memory.max` / `pids.max` / `cpu.max`,
capabilities and `NoNewPrivs`).

### Resource limits

```
policy profile → effective limits ┐
approved runtime profile ─────────┴→ trusted snapshot (runtime + isolation.container) → runtime → container
```

| Limit | Source | Enforced by |
| --- | --- | --- |
| wall-clock timeout | `limits.executionTimeoutSeconds` | the runtime: SIGTERM, grace, SIGKILL of the exact container |
| memory (no swap) | runtime profile | Docker cgroup (`--memory`, `--memory-swap`); an OOM kill is `resource-limit` |
| CPU | runtime profile | Docker cgroup (`--cpus`) |
| PIDs | runtime profile | Docker cgroup (`--pids-limit`) |
| `/tmp` size | runtime profile | tmpfs size |
| artifact budget | `limits.maxArtifactMb` | the runtime — bind mounts cannot be quota'd by Docker Desktop, so a watchdog measures the workspace every few seconds and stops an execution that outgrows its budget (`artifact.budget-exceeded`), registration checks every artifact, finalization checks the total |
| execution concurrency | `SECURITY_EXECUTION_CONCURRENCY` | the claim (unchanged) |

### Cancellation, timeout and shutdown

Cancellation and timeout follow the Phase 2A path: the runtime sends the graceful stop (`docker kill --signal
SIGTERM` to the exact container; the program can write what it knows — `diagnostic.isolated-check` leaves
`result.json` with `status: stopped`), waits the grace period, kills the container (`docker kill`) if it is still
running, records the state, cleans up (container removed, verified) and finishes `cancelled` / `timed-out`. Files
the program flushed stay in the workspace but a stopped execution registers no evidence. Repeated cancellation is
safe; cancelling A never affects B or any other container (tested with a running unrelated container).

On worker shutdown, running isolated executions are stopped the same way and finish `interrupted`
(`runtime.shutdown`) with their container removed; nothing else is touched and nothing global is cleaned.

### Recovery

At start-up (and on a redelivered job) the runtime reconciles executions of a worker that is gone — Docker keeps
their containers running — and then containers left by executions that are already final:

| Found | Action |
| --- | --- |
| container still running | stopped (graceful, then exact kill) and removed; execution `interrupted`, never re-run |
| container exited, execution never finalized | **collected**: its output goes through the same `collect` + validated registrar path, then the normal finalization (`succeeded` / `failed`) |
| execution `finalizing` with a stored result | finished from the result; container removed |
| execution `cancelling` | container stopped and removed; `cancelled` |
| container created but never started | removed; `interrupted` |
| execution running but container gone | `interrupted` ("its container no longer exists") |
| execution final but its container remains (crash before removal, failed cleanup) | container removed by exact name (`execution.recovered`, `container-removed`) |
| labelled container of no execution in this database | left untouched (reported) |
| Docker not reachable | reconciliation of that execution is deferred, not guessed |

Adoption is a guarded update, so a second recovering worker loses the race; a second pass changes nothing.

### Output, artifacts and evidence

Container output is bounded: `docker logs --tail 400`, at most 64 KB kept as `outputs/container.log`, a 1 KB redacted
tail in the run metadata; `result.json` is read only if it is a regular file of at most 64 KB inside `outputs/`. The
container never creates evidence: after it exits, the capability's host-side `collect` validates the result (schema,
the execution's own marker) and registers artifacts through the Phase 2A registrar (regular file, inside this
execution, declared evidence type, budget) with the execution id in the provenance. Redaction applies to events, API
responses and served artifacts as before.

### Cleanup

Idempotent and exact: remove the container by name after its labels prove ownership, confirm it is gone, remove the
scratch space. If removal fails the failure is persisted (`cleanup-failed`, `execution.container-cleanup-failed`), the
container is not reported as removed (`exit.runtime.container.removed: false`), and its derived name and labels are
all a later reconciliation needs to remove it.

### Measured overhead

Windows 11, Docker Desktop 29.8 (WSL 2), median of 5 runs with `holdSeconds: 0`:

| | in-process `diagnostic.runtime-check` | isolated `diagnostic.isolated-check` |
| --- | --- | --- |
| whole execution (`run()`) | 168 ms | 1 825 ms |
| preparing → started | 16 ms | 648 ms (image check + `docker create` ≈ 483 ms) |
| work | 129 ms (one owned `node` child) | 792 ms (`docker start` ≈ 313 ms, run → exit observed ≈ 458 ms) |
| cleanup | 3 ms | 374 ms (container removal ≈ 370 ms) |

Isolation costs about 1.6 s per execution on this machine, almost all of it docker CLI round trips.

### Phase 2B limitations

- **No network egress layer yet.** Isolated containers have no network; capabilities that need it cannot be
  isolated in this version and the in-process scoped client remains their only path.
- Containers share the Docker VM's kernel (namespaces, cgroups, seccomp): process isolation, not a virtual machine.
- The artifact budget is enforced by polling the bind-mounted workspace (every few seconds), so a fast writer can
  overshoot briefly before it is stopped; Docker Desktop offers no quota for bind mounts.
- One approved runtime, pinned by digest. On a machine without that exact image, isolated capabilities are refused
  until it is pulled explicitly.
- Container control goes through the docker CLI (≈ 0.3 s per call on Docker Desktop).
- On Windows, Node ends a crashed worker's child processes with it (a kill-on-close job object); the docker CLI
  helpers die too, but containers keep running under Docker and are reconciled as above.

## Phase 2C: controlled network egress

A `none`-network isolated capability runs with `--network none`. A capability that declares
`execution.network: 'scoped-egress'` (and `requiresNetwork: true`) reaches the network **only** through an
Audivra-controlled gateway that is private to its execution and enforces the trusted scope. The executor is never
trusted to self-enforce scope, and neither a request nor a model can broaden it.

```
executor container ──(only reachable peer)──► gateway container ──► approved destination
  on the execution-private INTERNAL network            on the internal network + a private EGRESS network
  (no DNS for and no route to anything else)           (runs the real Phase 1 scope engine)
```

### The two networks

Each scoped-egress execution owns two Docker bridge networks, created before the executor so its only route exists
from the moment it starts:

- **internal** `audivra-net-<execution id>` — created `--internal` (no external route). The executor and the
  gateway are both attached; the gateway joins it with the network alias `egress`.
- **egress** `audivra-egr-<execution id>` — an ordinary private bridge the gateway is also attached to, so the
  gateway (and only the gateway) can reach approved destinations.

The executor is attached to the **internal network only**. On this project's Windows + WSL2 + Docker Desktop
setup this was verified to mean: it can resolve and reach the gateway alias `egress`, but it cannot resolve any
external name (Docker's embedded DNS does not forward external queries on an internal network) and has no route to
the host, the Docker bridge gateway, or the internet (a raw-IP connect returns `ENETUNREACH`; a name is
`EAI_AGAIN`). The executor's only usable path is the gateway. The networked diagnostic self-checks this: direct
connects to `host.docker.internal` and `8.8.8.8` fail, and the fixtures confirm zero traffic reaches them.

### The gateway

`packages/security/gateway/main.ts` is a small HTTP forward proxy. It is **bundled with esbuild** (cached under
`<data>/security/.gateway/`), so it carries the *real* Phase 1 scope engine — scope is interpreted in exactly one
place, never reimplemented. It runs in the same approved runtime image (no new image), with the same hardening as
an executor: non-root, `--cap-drop ALL`, `no-new-privileges`, read-only root, private tmpfs, memory/CPU/PID
limits, no Docker socket. It mounts **only** its own `.gateway` directory (the bundled program, the trusted policy
and its decision log) — never the executor's inputs/outputs/artifacts, the repository, host paths or secrets. It is
given no Audivra credential and no database access.

For each request the gateway:

1. accepts only **absolute-form** HTTP (a classic forward proxy); anything else is denied;
2. accepts only `GET`/`HEAD`; **`CONNECT` and every other method are denied** (HTTPS tunnelling is not mediated in
   this phase — it is refused, never passed through);
3. takes a slot from the execution's **request budget** (total, per-second rate, concurrency) from the snapshot;
4. evaluates the URL by name with `evaluateUrl` (scheme, host, subdomain rules, **port**, exclusions, dependencies);
5. resolves the host itself (the executor has no external DNS) and evaluates **every resolved address** with
   `evaluateNetworkDestination` (loopback / private / link-local / IPv6-local are refused unless the scope's
   `networks` list them, the destination is that IP literal, or it is a `localhost` name — a public name that
   resolves to an internal address is refused);
6. connects to an address it just approved (pinned; no second lookup), rewriting the `Host` header. On Docker
   Desktop a loopback destination is dialled through `host.docker.internal` (the only way to reach a host service);
   the scope *decision* uses the real address, only the physical dial target is translated.

The gateway **does not follow redirects itself**: it returns the 3xx to the executor, whose client follows it with a
**new request back through the gateway**, which re-evaluates the new destination. An out-of-scope redirect target is
therefore denied and receives zero traffic — proven with a fixture that 302-redirects out of scope.

### Policy flow and no downgrade

```
engagement scope + effective limits ──► trusted execution snapshot ──► gateway policy.json (manifest + limits)
```

The network profile is declared by the capability, resolved at decision time, and recorded in the snapshot
(`isolation.network`). The gateway is given **only** `{ manifest, limits }` from the snapshot, staged read-only; the
executor never receives it and could not change it. A request has no field for a network, a host, a port or a
backend (strict schemas), and `CapabilityBroker.execute()` (the in-process path) refuses networked isolated
capabilities. The worker picks the backend and the profile from the verified snapshot and never falls back. All of
this is tested.

### Observability

Network decisions are **policy-level, not packet capture**. The gateway appends a bounded JSONL decision log
(`.gateway/gateway.jsonl`, at most 2000 entries) with, per decision: time, decision, rule, host, port, resolved
address. On exit it writes a summary. The runtime records `execution.network-preparing`, `execution.gateway-started`,
`execution.network-ready` and a final `execution.network-summary` (counts: requested / allowed / denied, and denials
by rule) in the append-only security events, plus `execution.network-cleanup-failed` if teardown is incomplete. The
counts and the gateway/network state are on the execution's `exit.runtime.network` and shown in the UI.

### Ownership, cancellation, cleanup and recovery

Every network resource carries the same ownership labels as containers (`audivra.owner=security-execution`,
`audivra.execution`, `audivra.engagement`, `audivra.role`) and a name derived from the execution id. Cancellation
and timeout stop the executor **and** the gateway and remove both networks; cleanup removes, by exact name after the
labels prove ownership, the executor container, the gateway container, then the two networks (containers first — a
network with an attached container cannot be removed), and is idempotent. Recovery lists owned containers and
networks, reconciles a crashed execution's resources exactly, removes resources left by final executions, and leaves
any labelled resource that belongs to no execution of this database untouched. Two executions never share a gateway
or a network; cancelling one leaves the other running. All of this is proven with real Docker.

### Measured overhead

Windows + Docker Desktop, median of 4 runs:

| | isolated, no network (2B) | scoped egress (2C) |
| --- | --- | --- |
| whole execution (`run()`) | ~1.9 s | ~12.3 s |
| prepare → started | ~0.66 s | ~3.77 s (network + gateway setup ~3.1 s; gateway-ready → executor-started ~0.2 s) |
| cleanup | ~0.38 s | ~2.27 s (removing the gateway container and two networks as well) |

Scoped egress adds roughly 3 s of setup and 1.9 s of cleanup over a network-less isolated execution, almost all of
it docker CLI round trips for the two networks and the gateway container. The `diagnostic.egress-check` run time
also includes its own ~3 s containment self-check (a deliberate direct-connect attempt that times out).

### Phase 2C limitations

- **Only HTTP is mediated.** HTTPS via `CONNECT` is refused, not tunnelled; there is no TLS interception. A networked
  capability in this phase speaks plaintext HTTP to the gateway. HTTPS mediation is later work.
- **Containment is proven for Windows + WSL2 + Docker Desktop**, the project's environment, via the probes and the
  zero-traffic fixture tests above. It is not asserted as universal containment for arbitrary operating systems or
  Docker configurations; the guarantee rests on Docker's `--internal` network having no external route.
- The executor reaches a **host** loopback service through `host.docker.internal` (a Docker Desktop convenience for
  local fixtures and dev targets); the scope decision still uses the real address.
- The gateway shares the Docker VM kernel with the executor (namespaces/cgroups), like any container here — process
  isolation, not a VM.
- The request budget, rate and concurrency are enforced by the gateway from the snapshot; they bound HTTP requests
  through the gateway, not raw packets (the executor has no raw route anyway).
- One approved runtime image is reused for the gateway; there is no separate, smaller gateway image.

## Phase 3A: security sensors

A **sensor** is an approved external security tool (httpx, katana, Semgrep) run as a first-class Audivra capability.
A sensor is never raw CLI, shell or arbitrary-image access: each tool gets one reviewed *adapter*, and the tool runs
only through the existing control plane —

```
Security capability → Capability Broker → durable execution → isolated runtime → approved tool adapter → structured output → evidence + observations
```

Audivra owns authorization, scope, execution, limits, parsing, evidence, provenance and the result state; the tool is
only a sensor. A tool signal never becomes a verified finding on its own.

### The sensor adapter

`packages/security/src/sensors/adapter.ts` defines `SensorAdapter` and `defineSensor()`. An adapter declares the
approved runtime, the observation types it produces, a **strict** input schema (unknown fields rejected), the targets
the request contacts (scope-checked by the broker before execution), and three reviewed steps:

- `stage(context, input, into)` — optional; writes the input files the tool reads into the execution's read-only
  `inputs/` area (e.g. Semgrep's staged source and ruleset).
- `buildArgs(context, input, io)` — the **exact** argument vector for the tool, built by Audivra from validated input
  only. No user- or model-supplied argument ever reaches the tool. For a networked sensor it adds `-proxy <gateway>`.
- `normalize({ raw, evidenceRef, handles, … })` — parses the tool's native structured output into observations.

`defineSensor()` turns the adapter into a `SecurityCapability` whose `collect` (run on the host after the container
exits) registers the tool's raw output as a bounded `tool-result` artifact (evidence), runs `normalize`, and returns a
structured `SensorResult`. Because a sensor is a `tool` runtime, its container has **no in-process `execute`** and no
reviewed Node program — only `[--entrypoint <tool>, …buildArgs]` in the approved image.

A sensor tool's **own exit code is data**, not an execution failure: `collect` runs regardless of the exit code and
classifies the outcome (Semgrep, for instance, exits 1 when it has findings — a successful run). Only a real runtime
failure (OOM, cancellation, an unobservable container) fails the execution.

### Observations (not findings)

A `SecurityObservation` (`packages/contracts/src/security-observation.ts`) is a normalized, evidence-backed **signal**
about an asset — a signal a later reasoning/verification layer may correlate and act on. It is **not** a finding.
Types: `technology`, `endpoint`, `http-response`, `http-header`, `redirect`, `form`, `tls-config`, `dependency`,
`source-finding`, `service`.

- **Provenance.** Every observation carries one or more *contributions*, each recording the execution id, capability
  id, tool, exact tool version (the pinned image reference, by digest), the backing evidence ref (`EV-n`), a
  confidence and a timestamp. The raw tool output is always reachable through the evidence ref.
- **Deduplication.** The stable key is `type:asset:subject` on normalized values (`observations.ts`:
  `normalizeAsset`/`normalizeSubject`). A second sensor — or a later run — reporting the same fact merges onto the
  existing row: the contribution and evidence accrue, the highest confidence wins, provenance is never lost, and the
  same fact is not duplicated. Serialized per key by a row lock (`security_observations`, migration `0005`).
- **Scope classification.** A discovered destination (a redirect target, a crawled link) is classified against the
  engagement scope by the Phase 1 scope engine — `in-scope` / `out-of-scope` / `third-party` / `unknown`. Being
  observed **never authorizes** a destination; only `in-scope` destinations are eligible for later capabilities.
- Observations are recorded only through `handles.observations`, which refuses any capability that is not a declared
  sensor. Content is redacted at the persistence boundary, like evidence.

### Sensor result and coverage states

One run returns a `SensorResult` with a state: `success`, `partial` (some, possibly bounded, output), `failed`,
`unavailable` (image missing) or `skipped`. These feed coverage. `SecurityService.sensorCoverage(engagementId)` maps
each shipped sensor's most recent execution onto the shared `CoverageStatus` vocabulary (`ran`/`partial`/`skipped`/
`failed`/`unavailable`); a sensor that has not run is reported `skipped` — explicit, never silently omitted.

### Networked sensors and scope safety

`discovery.http-inspect` (httpx) and `discovery.crawl` (katana) are `scoped-egress`: they reach targets only through
the execution's Phase 2C gateway, which enforces the trusted scope on every request. httpx runs **without following
redirects**; katana's own crawl scope is pinned to the seed host and it is told to emit — not follow — out-of-scope
destinations. A discovered out-of-scope destination is therefore recorded and classified but **never contacted**; the
integration tests assert the out-of-scope fixture receives zero traffic. The gateway is Audivra's bundled Node program
and always runs in the Node runtime, never in the sensor's tool image.

### Tool availability and installation

Approved runtimes (`runtimes.ts`) pin each tool image **by digest**; images are never pulled implicitly (not at
install, startup or test time). `sensorRuntimeStatuses()` surfaces each sensor in the existing **System → Tools** view
under "Security sensors": `ready` (image present), `needs-setup` (missing — shown with its exact pull hint),
`unavailable` (Docker down) or `error`. A missing sensor reduces coverage; it never crashes an assessment — the
execution finishes with an `unavailable`/`failed` `SensorResult`.

### The tool portfolio (integrated vs. deferred)

| Tool | Status | Notes |
| --- | --- | --- |
| **httpx** | Integrated | `discovery.http-inspect`. HTTP inspection via the gateway; JSON output → response/header/technology/redirect observations. |
| **katana** | Integrated | `discovery.crawl`. Bounded same-site crawl via the gateway; JSONL → endpoint/form/technology observations, each scope-classified. |
| **Semgrep CE** | Integrated | `source.static-analysis`. Offline static analysis of a staged source tree with Audivra's reviewed, in-repo ruleset; JSON → `source-finding` observations. |
| **testssl.sh** | **Deferred** | Raw TLS inspection. The Phase 2C gateway mediates **HTTP only** (`CONNECT` is refused, no TLS interception), so a scoped-egress sensor cannot mediate testssl's raw TLS handshakes. testssl remains available in the Website Audit path; a sensor needs either HTTPS/`CONNECT` mediation (later gateway work) or a reviewed direct-TLS egress exception. |
| **Trivy** | **Deferred** | Vulnerability/dependency scanning depends on a vulnerability database. The sensor runtimes have **no network** (and a networked sensor only reaches in-scope engagement targets through the gateway — not a public vuln-DB host). Integrating Trivy needs a pre-staged, version-pinned offline DB or an authorized egress exception to its DB host; both are deliberate, reviewable decisions deferred to a later phase. |
| **OSV-Scanner** | **Deferred** | Same reason as Trivy: it queries the OSV database over the network, which the scoped-egress model does not permit to a non-scope host. Deferred pending offline DB staging or an authorized egress exception. |

The deferrals are a direct consequence of the Phase 2C guarantee (HTTP-only, scope-limited egress) and the no-implicit-
network stance — not missing adapters. Each becomes a straightforward adapter once its prerequisite (HTTPS mediation,
or staged/authorized vuln-DB access) exists.

### Read-only observation API and UI

- `GET /api/security/engagements/:id/observations` (filters: `type`, `asset`, `scopeClass`),
  `…/observations/summary`, `…/sensor-coverage`, and `GET /api/security/executions/:id/observations`.
- The engagement's **Observations** tab shows the summary, sensor coverage, a scope-classified discovery table with
  type/scope filters, and each execution's observations inline on the Executions tab. All read-only.

### Measured overhead

Windows + Docker Desktop. A sensor run is dominated by container start for the (large) tool images; the adapter's
parsing and evidence/observation recording are milliseconds. Representative end-to-end `run()` times from the
integration suite: httpx inspect ~6–9 s, katana crawl ~15–25 s (bounded by its crawl duration), Semgrep analysis
~6–10 s. Networked sensors add the Phase 2C gateway setup (~3 s) and cleanup (~2 s) measured above.

### Phase 3A limitations

- **testssl, Trivy and OSV-Scanner are deferred** for the technical reasons in the portfolio table above.
- Observations are signals, not findings: there is no correlation/verification layer yet (a later phase turns
  correlated, verified observations into findings).
- Sensor inputs are explicit (a URL, a staged file set); wiring one sensor's discovered `in-scope` endpoints as another
  sensor's input (discovery → inspection chaining) is deliberate future orchestration, not automatic.
- The sensor tool images are large (~1–1.6 GB each) and reuse the Node runtime for the gateway; there is no slimmer,
  purpose-built sensor image yet.

## Known limitations

- The in-process backend runs reviewed capability code in the worker process: it is not a sandbox. It is meant for
  trusted platform capabilities; isolation-requiring capabilities declare `isolated-container`.
- Execution concurrency is an operational, platform-wide setting; a per-engagement execution concurrency limit in
  the policy profiles is future work.
- A running execution keeps the snapshot it started with when the engagement configuration changes (only pausing,
  completing or cancelling the engagement stops it).
- The engagement artifact budget is checked before each execution; one execution may then use its own full budget,
  so the engagement total can exceed the budget by at most one execution's worth.
- The process limit counts processes started per execution, not processes alive at once.
- Evidence and owned-process rows reference executions by id without a foreign key: Phase 1's in-process
  `CapabilityBroker.execute()` (tests and the agent gateway) still records evidence for executions that have no
  `security_executions` row.
