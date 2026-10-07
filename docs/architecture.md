# Architecture

## Principle

```
Execution infrastructure = code        Intelligence = model + prompts
```

The code provides a browser, a terminal, a workspace, tools, evidence recording, persistence, job
lifecycle, safety boundaries, validation and UI. It contains **no** semantic audit logic such as
`checkCheckout()` or `if ecommerce then …`. The AI auditor decides what the business is, what to
investigate, which journeys to run, which tools or scripts to use, and how severe things are. The
deterministic baseline only gathers cheap facts, which the prompts explicitly treat as leads.

## Processes

| Process     | Entry                                | Responsibility                                                              |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------- |
| API server  | `apps/server/src/main.ts`            | REST API, SSE relay of activity events, artifact serving, enqueueing jobs   |
| Worker      | `apps/worker/src/main.ts`            | Runs durable pipeline stages from pg-boss queues                            |
| Web         | `apps/web` (Vite)                    | Audit workspace UI                                                          |
| Agent runs  | `claude -p …` children of the worker | Auditor / Reviewer / verification pass / Finalizer                          |
| MCP servers | children of each agent run           | `browser` (official Playwright MCP) and `audit` (evidence + activity notes) |

## Pipeline (durable)

Each stage is a separate pg-boss job (queues `audit-baseline`, `audit-investigation`, `audit-review`,
`audit-revision`, `audit-finalize`). A stage persists its step status and enqueues the next stage.
Long AI stages use pg-boss heartbeats, so a crashed worker's job is retried after restart; stages that
already completed are skipped when a job is delivered again.

```
preparing+baseline ──► investigation ──► review ──► [revision] ──► finalizing ──► done
       │ AI off/unavailable ─────────────────────────────────────►┘
```

Failure semantics:

- **Baseline / preparation failure** (e.g. target unreachable) → audit `failed` (`required-capability`).
- **Optional tool failure** (Lighthouse crash, axe error) → tool run `failed`/`skipped`, recorded in
  `baseline.skippedCapabilities`; the audit continues.
- **Auditor failure** → audit `partial`; all baseline evidence and anything the agent recorded stays.
  Retry from the UI re-runs from the failed stage.
- **Reviewer failure** → review step `failed`, no revision, finalize with findings marked `unreviewed`.
- **Verification-pass failure** → finalize from the reviewed draft.
- **Finalizer failure** → deterministic fallback (`fallbackFinal`) applies the reviewer's decisions to the
  draft and labels the summary as auto-assembled; audit `partial`.
- **Cancellation** → a 3-second watcher aborts the stage; agent process trees are killed (`taskkill /T`
  on Windows).

## AI runtime

`AgentProvider` (`packages/ai-runtime/src/provider.ts`) is the seam for future providers. The MVP
provider, `ClaudeCliProvider`, runs the installed, authenticated Claude Code CLI:

```
claude -p --output-format stream-json --verbose
       --append-system-prompt-file prompts/<role>-system.md
       --json-schema <Zod-generated JSON Schema>
       --permission-mode dontAsk --tools … --allowedTools … --disallowedTools …
       --mcp-config agent/mcp-<role>.json --strict-mcp-config
       --setting-sources project,local --disable-slash-commands --no-chrome
       [--model …] [--effort …] [--max-turns …] [--resume <auditor session>]
```

- The task prompt is sent on stdin; the audit workspace is the working directory.
- `stream-json` events are turned into concise Activity entries (`Browser: Opened …`, `Terminal: …`,
  `Created script scripts/x.mjs`). Thinking blocks are stripped before the transcript is written.
- The final `structured_output` is validated again with Zod (`packages/contracts/src/agent-outputs.ts`).
- The verification pass resumes the auditor's own session (`--resume`), so it keeps its context.

| Role              | Tools                                                              | MCP                  | Output         |
| ----------------- | ------------------------------------------------------------------ | -------------------- | -------------- |
| Auditor           | Bash, Read/Write/Edit (workspace), Glob, Grep, WebFetch, TodoWrite | browser, audit       | `AuditDraft`   |
| Reviewer          | Read (workspace), Glob, Grep                                       | audit (read + notes) | `ReviewResult` |
| Verification pass | as Auditor                                                         | browser, audit       | `AuditDraft`   |
| Finalizer         | none                                                               | none                 | `FinalAudit`   |

### Deterministic guards on AI output (`validate.ts`)

- Evidence references that do not exist are rejected; a finding left without evidence is downgraded
  to `inference` with confidence ≤ 0.5.
- Final findings must derive from draft findings (`sourceFindingIds`), may only cite evidence their
  sources cited, and cannot be escalated above the draft/reviewer severity.
- All adjustments are recorded on the AgentRun (`validation`) and surfaced in the Activity log.

The verification pass runs when the reviewer reports material gaps, asks for any finding to be
verified, or names a high-importance missing area (bounded by `AUDIT_MAX_REVISIONS`).

## Evidence

Evidence is a first-class row (`evidence` table) with a per-audit reference (`EV-12`), type, source
(`baseline`/`auditor`/`reviewer`), URL, summary, compact metadata and an optional workspace-relative
artifact path. The baseline creates evidence directly; agents create it through the `audit` MCP server's
`record_evidence` tool, which validates that artifacts exist inside the workspace. Findings link to
evidence through `finding_evidence`.

## Live updates

The worker writes every activity event to `audit_events` and calls `pg_notify('audivra_events',
{auditId, id})`. The API server LISTENs, reads new rows and pushes them over SSE
(`/api/audits/:id/stream`, `Last-Event-ID` resume). The UI appends events and batches query
invalidations.

## Workspace layout

```
.local-data/audits/<id>/
  baseline/   summary.md (digest given to the AI), crawl/seo/links/localization JSON, http/robots
  screenshots/  baseline + agent screenshots
  browser/    per-page rendered DOM and inspection reports; Playwright MCP output
  network/    request lists
  tools/      lighthouse/, axe/, registry.json, agent tool output
  scripts/    scripts the auditor wrote
  notes/      auditor notes
  agent/      role prompts, redacted stream transcripts, raw outputs, draft.json, review.json
  final/      audit.json
```

Artifact paths are always workspace-relative and resolved through `resolveInside()`, which rejects
absolute paths and traversal.
