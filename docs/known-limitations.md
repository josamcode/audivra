# Known limitations

Honest boundaries of the current version.

## Measurement

- **Lab data only.** Lighthouse and browser timings are lab measurements from this machine and network, not real-user (CrUX/field) data. Comparisons use noise thresholds, but single runs still vary — and they are affected by other load on the machine (e.g. several audits or test suites running at once).
- **"Not found again" is not proof of a fix.** Comparisons are between AI audits; an issue the second audit did not report may be fixed or simply not re-examined.
- **Bounded coverage.** The crawl samples up to `BASELINE_MAX_PAGES` (30) pages and inspects `BASELINE_BROWSER_PAGES` (4) in a real browser; the AI samples by template. Large sites are sampled, not exhaustively audited. "Missing language pair" signals mean "not seen in the sample".
- **Bot protection.** Sites behind bot protection may block Katana, the ZAP spider or the link checker (reported as blocked/inconclusive, never retried harder). Some tracking tags only load after consent and are invisible without interaction.
- **Conversion tracking** is verified only where the AI exercised the action with outgoing requests intercepted; the baseline lists tags present and events sent on load, and marks conversion events as not tested.
- **Journeys stop at the hand-off.** Steps that leave the site or would contact the owner (mailto, WhatsApp, calls, real form submissions) are not activated, so they are marked *unverified*. Journey analysis for older audits uses the stored evidence only and cannot re-check anything.
- **Change Intelligence explains what changed, not always why.** Causes are given only when evidence shows them, labelled *correlated* or *likely* otherwise; a stricter re-rating of an unchanged issue appears as a severity change.

## AI

- Findings are produced by a model. Evidence requirements, the reviewer, deterministic validation and grounding reduce — but do not eliminate — misjudgements; confidence and verification status are shown on every finding.
- The benchmark measures deterministic planted issues on small fixtures; it does not prove quality on every kind of real site, and subjective CRO judgements have no binary ground truth.
- The evidence graph shows stored links only; a relationship the AI did not record (e.g. an observation without linked evidence) is absent rather than guessed. Large neighbourhoods are capped at 36 items.
- The Client Brief is preparation for the user, written from the audit; it cannot know the client's goals, budget or analytics and says so in its questions and uncertainties.
- Annotated screenshots use measured regions when the auditor recorded them; otherwise the planner may mark large, unambiguous areas by eye, which can be imprecise.
- Runs use the user's Claude Code plan; cost figures are API-equivalent estimates reported by the CLI.

## Security engagements

- Phase 1 is a control plane: it authorizes, scopes and decides, and runs no security tests. The only capability
  (`discovery.http-observe`) is passive and exists to prove the pipeline.
- Only *local development* authorization (loopback targets on this machine) is implemented; DNS TXT, well-known
  file, repository, deployment and manual approval are modelled and reported as unavailable. Remote targets
  therefore cannot become ready yet.
- Enforcement is application-level: scope, DNS checks, limits and redirects bind code that uses the broker and its
  scoped HTTP client. OS/network-level containment (sandboxed execution, mediated egress) is a later phase.
- Public-suffix rules are approximated; the audit-trail trigger protects against application writes, not a database
  owner. Details: [security-engagements.md](security-engagements.md).
- In-process executions (Phase 2A) run reviewed capability code in the worker process: not a sandbox. Code that ignores
  the stop signal is abandoned (handles revoked, owned processes terminated) rather than pre-empted. Execution
  concurrency is a platform-wide setting, not yet a per-engagement policy limit.
- Isolated executions (Phase 2B) run in a container with no network, a read-only root and only their workspace
  mounted. Containers share the Docker VM kernel; the artifact budget of a bind-mounted workspace is enforced by
  polling.
- Controlled network egress (Phase 2C) gives a networked isolated execution a single route — an Audivra-controlled,
  execution-private gateway that enforces the trusted scope. **Only HTTP is mediated** (HTTPS `CONNECT` is refused,
  not tunnelled), and containment is proven for this project's Windows + WSL2 + Docker Desktop setup, not asserted as
  universal. Details: [security-executions.md](security-executions.md#phase-2c-limitations).
- Knowledge (Phases 4–5) is a deterministic Security Graph: it records only observed/declared facts and their
  provenance, AI inference never rises above `inferred`, and a relationship no sensor recorded is absent, not guessed.
  Credentials and sessions live in an encrypted vault whose key is separate from the database; the secret itself
  never reaches an event, the graph, an observation, an export or AI context (enforced by canary tests). Differential
  comparisons need positive **and** negative controls to call an access boundary broken — without them the verdict is
  `inconclusive`, never a finding.
- Findings (Phase 6A) are only ever **supported** unless an *independent* check confirms complete evidence; a lone
  scanner or a lone model is never enough, and a provider failure **blocks** rather than guesses. Attack paths
  (Phase 6B) chain only verified findings over real graph edges; a missing connector is kept as an explicit evidence
  gap, never bridged. Retesting (Phase 6C) treats absence as *not-tested*, never as *fixed* — a fix must be proven by
  a working control.
- The specialist engine (Phase 6D, Strix) is **optional and off by default**; its live-target modes are fail-closed
  (disabled until containment is proven for the host), and a specialist signal can only reach a finding through the
  same 6A verification boundary — there is no Strix→finding bypass. The autonomous researcher (Phase 6E) is bounded
  by explicit budgets, prefers cheap deterministic actions, and only ever reaches the specialist as a last resort.
- The combined client report and all exports (Phase 6F) are generated from stored state with **no AI re-run**; they
  are deterministic in content (only generation timestamps vary) and never claim a complete penetration test — every
  report carries its residual-uncertainty / untested-areas section.

## Platform and safety

- On Windows the auditor's shell is not OS-sandboxed (see [security.md](security.md)).
- ZAP and testssl.sh require Docker and large images (pulled only on request by `pnpm run setup -- --with-scanners`); without them those capabilities show as unavailable.
- Client reports are English; Arabic content renders correctly inside them, but the report UI itself is not localized.

## V1 product boundaries

- **Single-user, local-first, no authentication — by design.** Audivra V1 binds to `127.0.0.1` and has no login,
  users, roles or multi-tenancy. Its trust boundary is the local machine and the OS account that runs it: anyone who
  can reach the port is the operator. This is a deliberate, documented V1 decision, not an oversight — the deployment
  model is a trusted single operator on their own machine. The consequences and the conditions under which this must
  change (any shared, hosted or multi-user deployment) are set out in [operations.md](operations.md#deployment-model)
  and the [threat model](security-threat-model.md).
- **The vault key is the one secret you must manage.** It is kept out of the database and out of backups; losing it
  makes stored credentials unrecoverable, and leaking it compromises them. V1 ships a persisted local dev key for
  convenience and tells you (via `pnpm run doctor`) to set `AUDIVRA_SECRET_KEY` for anything beyond local development.
- **No built-in disaster recovery or HA.** Backup/restore is the operator's PostgreSQL responsibility plus the vault
  key; there is no clustering, failover or point-in-time service. The procedure is in [operations.md](operations.md).
- **Resource management is Audivra-owned only.** Disk/cleanup operations act only on containers, networks, workspaces
  and artifacts Audivra created (name-prefixed `audivra-`); Audivra never runs a global Docker prune and never touches
  resources it did not create.
- **No V1.1 feature expansion is implied.** V1 is a complete, validated platform; broader auth, hosted/multi-user
  deployment, HTTPS egress mediation and a load-test harness are explicitly future work, not partially-built V1 code.
