# Security policy

Audivra may audit websites the user does not own. The default behaviour is therefore **passive and non-destructive**, and Audivra must never interfere with anything else running on the user's machine.

## Toward audited sites

| Allowed | Not allowed |
| --- | --- |
| Loading pages, reading HTML/DOM, screenshots, console and network observation | Submitting forms, logging in, creating accounts, purchasing, booking, sending messages |
| Lighthouse, axe-core, Pa11y, link checking (HEAD/GET), bounded crawling | Exploit payloads, injection, fuzzing, brute force, directory busting, authentication attacks |
| ZAP **baseline**: 1-minute spider with form processing and POST disabled + passive rules | ZAP active/full/API scans (denied in the agent's permissions) |
| testssl.sh protocols (`-p`), server defaults (`-S`), preferences (`-P`), first IP only | testssl.sh vulnerability checks (`-U` and friends) |
| Katana depth 2, 2 requests/s, 45 s | High-volume or load-generating requests |
| httpx: one request with fingerprinting | **Nuclei**: installed or not, it is disabled by policy and never run automatically |

When the AI must observe what a submit/contact control does, the prompt requires a Playwright script that records and aborts every non-GET request and navigation away from the site, so nothing reaches the server. Tracking verification follows the same rule: events are observed, never sent.

## Toward the user's machine

- **Process ownership.** Every process Audivra starts is registered (`packages/tool-runtime/src/processes.ts`) with its PID, the OS process creation time, image, tool, audit and owner instance; containers get exact names `audivra-<auditId>-<tool>`. Cancellation and shutdown terminate only these, as process trees rooted at the recorded PID (`taskkill /PID <pid> /T /F` on Windows) or containers by exact name. There is no code path that kills by process name, image or pattern. After a restart, leftovers are reaped only if PID **and** creation time still match, and never while their owning Audivra instance is alive. System → Processes lists everything Audivra started.
- **Workspace boundary.** Each audit has a private workspace. Agent file tools are allowed only inside it (`Read(./**)`, `Write(./**)`, `Edit(./**)`); artifact paths are resolved through `resolveInside()`, which rejects absolute paths and traversal. Exports and evidence serving use the same guard.
- **Agent permissions.** Claude Code runs with `--permission-mode dontAsk` (unlisted tools are denied, never prompted), `--setting-sources project,local` (no user settings, hooks or plugins), `--strict-mcp-config`, `--disable-slash-commands`, and deny rules for data-changing HTTP (`curl -X POST/PUT/PATCH/DELETE`, `-d`, `-F`), offensive tools (nuclei, sqlmap, hydra, nikto, ffuf, gobuster, dirb, wfuzz, ZAP full/API scans), destructive shell commands, publishing/pushing, the Playwright MCP `browser_run_code_unsafe` tool and file uploads.
- **Bounded autonomy.** Time budget, turn cap and tool-call ceilings (browser actions, terminal commands, total). Reaching one ends the run gracefully: the session is resumed once without tools to produce its result. The termination reason is stored.
- **Timeouts** on every external process; cancellation propagates within ~3 s.
- **Secrets and reasoning.** No API keys are needed (local Claude Code login). Thinking blocks are stripped before transcripts are written; the UI shows actions and one-sentence decision notes, never private reasoning. Evidence and notes must not contain credentials or personal data.

## Security engagements

Anything beyond the passive audit above belongs to a **security engagement**: a verified authorization, a strict
scope, an environment and a pinned policy profile, decided by the capability broker for every request and recorded
in an append-only audit trail. Phase 1 builds that control plane only and runs no security tests; the existing
audit tools listed here are not security capabilities and must not be used as such. See
[security-engagements.md](security-engagements.md), including which guarantees are enforced today and which need
the planned isolation and mediated-egress layer. Phase 2A runs allowed requests as durable executions with an
immutable trusted snapshot, Audivra-enforced timeouts and limits, exact process ownership per execution and crash
reconciliation; Phase 2B runs capabilities that declare it in an execution-scoped container — non-root, no
capabilities, read-only root, no network, only the execution's workspace mounted, never the Docker socket
([security-executions.md](security-executions.md)). There is no network-egress layer yet.

## Known limits

- The auditor's **Bash** tool is not OS-sandboxed on Windows (Claude Code's bash sandbox is not available there). File *tools* are scoped to the workspace and the prompt forbids leaving it, but a shell command could technically reach other paths. Running the worker in a container or under a dedicated low-privilege account is the recommended hardening for shared machines.
- Passive checks still send real requests; very small sites may notice the crawl, Katana and the ZAP spider (all rate- and time-bounded). Bot protection may block them; that is reported as incomplete coverage rather than retried harder.
