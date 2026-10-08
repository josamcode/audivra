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
- Durable executions (Phase 2A) run reviewed capability code in the worker process: not a sandbox. Code that ignores
  the stop signal is abandoned (handles revoked, owned processes terminated) rather than pre-empted. Execution
  concurrency is a platform-wide setting, not yet a per-engagement policy limit. Details:
  [security-executions.md](security-executions.md#known-limitations).

## Platform and safety

- On Windows the auditor's shell is not OS-sandboxed (see [security.md](security.md)).
- ZAP and testssl.sh require Docker and large images (pulled only on request by `pnpm run setup -- --with-scanners`); without them those capabilities show as unavailable.
- Client reports are English; Arabic content renders correctly inside them, but the report UI itself is not localized.
- No authentication: Audivra is a single-user local tool bound to 127.0.0.1.
