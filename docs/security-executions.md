# Security executions (Phase 2A: the durable execution runtime)

Phase 1 ([security-engagements.md](security-engagements.md)) decides *whether* a capability may run. Phase 2A
adds the platform that runs an allowed request **durably**: persisted with an immutable snapshot of the trusted
configuration it was approved under, carried out by the existing pg-boss worker, cancellable, bounded by
Audivra's own timeout and limits, and reconciled after a crash.

> Phase 2A is runtime engineering only. It adds no scanner, no vulnerability test, no active network testing and no
> new security tooling. The only new capability, `diagnostic.runtime-check`, never contacts the target.

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
| Capability | `packages/security/src/capabilities/runtime-check.ts`; `createRuntimeRegistry()` in `catalog.ts` |
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

The list is extensible: a later isolated backend adds its own kinds (sandbox, egress) without changing these.
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

| Step | In-process backend (first implementation) |
| --- | --- |
| `prepare` | create the workspace areas, write `inputs/input.json` |
| `start` | call the reviewed capability implementation with the frozen context and handles |
| `observe` | resolve with its result or error |
| `cancel` | abort the execution's stop signal (graceful) |
| `terminate` | abort and terminate the execution's owned processes, exactly |
| `cleanup` | remove scratch space (idempotent) |

The in-process backend cannot pre-empt JavaScript that ignores the stop signal. The runtime then **abandons** it after
the grace period: its owned processes are terminated, its handles are revoked (no further evidence, processes or
network), and the execution is finished and marked `abandoned` in its exit information. A later isolated backend
(container or VM with the workspace mounted and mediated egress) implements the same six steps with hard
termination, without changes to the execution model.

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
`execution.timed-out`, `execution.cancelled`; `execution.recovered` for reconciliation. Events carry identifiers,
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
an executable or an image (tested). The *Executions* tab lists an engagement's executions and shows one in detail —
status, environment, timestamps, duration, the configuration it was approved under, limits, failure reason, events,
evidence with artifact links — with *Cancel execution* while it can be cancelled. It has no way to start anything.

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

| Guarantee | Phase 2A | Needs the isolation / mediated-egress layer |
| --- | --- | --- |
| An execution runs only what was decided, under the configuration it was approved for | Snapshot persisted, hashed, immutable (trigger), verified and revalidated before start | — |
| Execution and decision cannot be created over HTTP or by a model | Only `CapabilityBroker.submit()` creates executions; job payloads carry an id only | — |
| Timeout and cancellation are Audivra's | Runtime timer and stop path; owned processes terminated exactly | Pre-emption of non-cooperative code (in-process code can only be abandoned) |
| Processes are attributable and terminated exactly | Registry by execution id, PID + creation time; no pattern kills | Sandboxed execution |
| Files stay in the execution workspace | For everything mediated by the runtime (areas, process cwd/output files, evidence) | OS-level confinement of code that writes elsewhere |
| A crashed worker leaves no running execution or orphaned owned process behind | Start-up and redelivery reconciliation, conservative and idempotent | — |

## Known limitations

- The only backend runs reviewed capability code in the worker process: it is not a sandbox. Hard termination,
  filesystem and network containment need the isolated backend.
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
