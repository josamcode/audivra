# Audivra — AI Website Auditor

A local-first audit workstation: paste a URL, click **Start Full Audit**, and an autonomous AI auditor investigates the site with a real browser, a terminal, a set of passive auditing tools and its own throwaway scripts. Every important claim is backed by recorded evidence. A second AI pass reviews the draft adversarially, the auditor re-verifies what was challenged, and a planning step turns the result into a visual, client-ready report — with exports, history and before/after comparison.

```
URL → deterministic baseline (crawl · Lighthouse · browser · axe/Pa11y · ZAP passive · testssl · httpx · Katana)
    → AI Auditor (browser · terminal · scripts · evidence) → AI Reviewer → verification pass → Finalizer
    → Artifact Planner + Report Composer → findings · evidence · visuals · client report · exports · history
```

## Quick start (Windows, macOS, Linux)

Requirements: Node.js ≥ 22.12, pnpm, Docker (or your own PostgreSQL), and — for the AI — an installed and logged-in [Claude Code](https://claude.com/claude-code) CLI (`claude auth status` → `loggedIn: true`). No API key or API billing is needed: the AI runs through your local Claude Code login.

```bash
pnpm install
pnpm run setup                       # .env, PostgreSQL, migrations, Chromium, Katana/httpx
pnpm run setup -- --with-scanners    # optional: ZAP baseline + testssl.sh Docker images (~3.8 GB)
pnpm run setup -- --with-sitespeed   # optional: sitespeed.io image (~5 GB)
pnpm dev                             # API :4310 + worker + UI :4300
```

Open http://127.0.0.1:4300.

> Use `pnpm run setup`, not `pnpm setup` — the latter is a pnpm built-in that modifies your global PNPM_HOME.

| Command                           | What it does                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`                        | API, worker and UI                                                                  |
| `pnpm test`                       | unit + integration suites (`test:unit`, `test:integration`)                         |
| `pnpm test:e2e` / `test:e2e:ai`   | Playwright E2E with AI off / with the local Claude Code runtime                     |
| `pnpm typecheck` / `pnpm lint`    | TypeScript (packages, tests, scripts) / ESLint                                      |
| `pnpm benchmark`                  | audit-quality benchmark on the fixture sites (also from System → Quality)           |
| `pnpm fixture -- --variant=v1,v2,healthy` | serve the fixture sites on :4321+                                           |
| `pnpm present <auditId>`          | regenerate deterministic visuals for an audit (no AI)                               |
| `pnpm tools`                      | print the tool registry                                                             |

## What an audit does

1. **Baseline** — cheap, deterministic facts, treated as leads: HTTP/redirects/security headers, TLS handshake, robots + sitemaps, a bounded crawl (SEO metadata, hreflang reciprocity, lang/dir, mixed-language UI, structured data), link checking, Lighthouse (mobile), real-browser inspection at 1440×900 and 390×844 (screenshots, console errors, failed requests, overflow, axe-core, tracking tags *and the events they actually send*, technology hints, conversion surface), plus optional scanners: **Pa11y** (HTML_CodeSniffer), **httpx** (Wappalyzer fingerprints), **Katana** (bounded discovery), **ZAP baseline** (passive: 1-minute spider without form submission + passive rules) and **testssl.sh** (protocols, certificate, cipher preference — no vulnerability probes). Every capability ends up in an explicit coverage table: ran / partial / skipped / failed / unavailable / not applicable, with a reason.
2. **AI Auditor** — works out the business, its model and primary conversion, decides what deserves investigation (effort proportional to importance and uncertainty), drives a real browser, runs tools and its own scripts, and records evidence. Safety ceilings (time, turns, browser actions, commands) end a runaway run gracefully: the agent is asked for its result instead of being cut off.
3. **AI Reviewer** — challenges unsupported factual and business claims, severity inflation, duplicates, false positives, scanner noise, findings contradicted by browser evidence, weak evidence, unnecessary findings and missing high-value investigation — adversarial, not nitpicky.
4. **Verification pass** — the auditor resumes its own session to settle what the reviewer challenged.
5. **Finalizer** — merges and orders findings under deterministic guards (no invented findings, no new evidence, no severity escalation) and assigns stable **issue keys** so later audits recognise the same issue.
6. **Presenting** — the **Artifact Planner** decides which insights deserve a visual and which stay text; Audivra resolves every number from measured data or the cited evidence and rejects anything it cannot ground. The **Report Composer** selects the client narrative: snapshot, top risks, proof per finding, action plan.

## Visuals, reports, exports and history

- **Visual artifacts** (22 types: metrics, comparisons, charts, matrix/heatmap, tracking coverage, page performance, journey, funnel, site graph, timeline, evidence gallery, annotated screenshot, before/after, tech map, impact-effort). The AI decides *what* to show; Audivra decides *how* and *where every number comes from*. See [docs/artifacts.md](docs/artifacts.md).
- **Client report** at `/audits/:id/report` — one report model rendered by the same components in the app, standalone HTML and PDF. No run IDs, prompt versions, model details or debug data.
- **Exports** (no AI re-run): PDF, standalone HTML, JSON (`audivra.audit.v1`), CSV (findings, pages, performance, broken links), a ZIP bundle, and PNG/SVG per visual. See [docs/exports.md](docs/exports.md).
- **History** — audits of the same site are grouped; the History tab compares with the previous audit (new / resolved / improved / regressed / unchanged findings, metric deltas beyond lab noise, technology and coverage changes, before/after screenshots) and draws trends only from real audits. See [docs/comparison.md](docs/comparison.md).
- **Security engagements (foundation)** — authorized security assessments as first-class records: target and environment (production, staging, isolated lab), verified authorization, a strict machine-enforced scope, versioned environment/risk policy profiles, a computed readiness state and an append-only decision audit trail. A capability broker decides every capability request deterministically; a model can only *request*. Allowed requests run as durable executions on the worker (immutable trusted snapshot, Audivra-enforced timeout and limits, exact process ownership, cancellation, crash recovery); capabilities that declare it run in an execution-scoped container (no network, read-only root, only their workspace mounted). The only executable diagnostics never contact the target, and no security tests run. See [docs/security-engagements.md](docs/security-engagements.md) and [docs/security-executions.md](docs/security-executions.md).
- **Website intelligence** — an *audit focus* (template) per audit; **journeys** walked by the auditor with evidence per step and seven health dimensions (no scores); an **evidence graph** of stored links around any finding; **Change Intelligence** that explains the comparison with the previous audit (validated against it, never calling "not found again" fixed); a **Client view** without internals; and an on-request **Client Brief** (quick brief, meeting prep, talking points, technical brief). See [docs/intelligence.md](docs/intelligence.md).

## Architecture

```
apps/
  web/        React + Vite + TanStack Router/Query/Table + Tailwind v4 (audit workspace UI)
  server/     Fastify REST API, SSE live events, artifact/visual/export serving
  worker/     pg-boss stages: baseline → investigation → review → revision → finalize → presenting; benchmark runner
packages/
  contracts/  Zod schemas (findings, evidence, agent outputs, artifacts, report, history, coverage, exports)
  config/     env, paths (traversal guards), logger
  database/   Drizzle schema + migrations, repositories, queues, process registry, benchmark runs
  tool-runtime/ process execution with ownership registry, tool registry/detection
  audit-core/ workspace, evidence context, baseline modules and scanners
  ai-runtime/ provider seam, Claude Code CLI provider (bounded autonomy), MCP servers, roles, validation
  security/   security engagements: scope engine, authorization, environment/risk policy, readiness, capability registry and broker, durable execution runtime
  insights/   metric catalog, artifact resolver/grounding, coverage, comparison, history, report model, benchmark scoring
  report-ui/  shared React renderers for artifacts and the client report (app, HTML, PDF, PNG, SVG)
  reporting/  exports: PDF/HTML/JSON/CSV/ZIP, artifact PNG/SVG
prompts/      auditor, reviewer, finalizer, planner and composer prompts (versioned product assets)
fixtures/site three fixture sites (v1 flawed, v2 partly fixed, healthy) + benchmark ground truth
fixtures/scope a boring local server for scope decisions (redirects, ports, host names)
```

More: [architecture](docs/architecture.md) · [website intelligence](docs/intelligence.md) · [security engagements](docs/security-engagements.md) · [security executions](docs/security-executions.md) · [artifacts](docs/artifacts.md) · [exports](docs/exports.md) · [comparison & trends](docs/comparison.md) · [security policy](docs/security.md) · [testing & benchmark](docs/testing.md) · [known limitations](docs/known-limitations.md) · [UI system](docs/ui-system.md)

## Configuration (`.env`)

| Variable                                                                     | Default                                             | Purpose                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`                                                               | `postgres://audivra:audivra@127.0.0.1:5440/audivra` | App database (bundled docker-compose DB on port 5440)      |
| `AUDIVRA_AI`                                                                 | `claude`                                            | `off` = baseline-only audits                               |
| `AUDITOR_MODEL` / `REVIEWER_MODEL` / `FINALIZER_MODEL` / `PRESENTER_MODEL`   | empty                                               | Claude model alias or ID; empty = Claude Code default      |
| `AUDITOR_EFFORT` / `REVIEWER_EFFORT` / `FINALIZER_EFFORT` / `PRESENTER_EFFORT` | `high` / `high` / `medium` / `medium`             | Claude Code `--effort`                                     |
| `AUDITOR_TIMEOUT_MINUTES` / `AUDITOR_MAX_TURNS`                              | `60` / `400`                                        | Investigation time budget and turn cap                     |
| `AUDITOR_MAX_BROWSER_ACTIONS` / `AUDITOR_MAX_COMMANDS` / `AUDITOR_MAX_TOOL_CALLS` | `300` / `200` / `600`                          | Safety ceilings (then the agent is asked to write up)      |
| `AUDIT_MAX_REVISIONS`                                                        | `1`                                                 | Verification passes after review (0 disables)              |
| `BASELINE_MAX_PAGES` / `BASELINE_MAX_LINK_CHECKS` / `BASELINE_BROWSER_PAGES` | `30` / `200` / `4`                                  | Baseline bounds                                            |
| `BASELINE_SCANNERS`                                                          | `httpx,katana,pa11y,zap,testssl`                    | Optional baseline scanners (empty disables all)            |
| `SECURITY_MIN_FREE_DISK_MB`                                                  | `2048`                                              | Security capability executions are refused below this free space (policy itself lives in versioned profiles, not here) |
| `SECURITY_EXECUTION_CONCURRENCY`                                             | `2`                                                 | Security executions active at once across workers sharing the database (operational capacity, not policy) |

## Safety in one paragraph

Audits are passive by default: no form submissions, logins, purchases or messages; no active scanning (Nuclei is disabled by policy; ZAP runs only its baseline passive mode with form handling off; testssl.sh runs no vulnerability probes); modest request rates. Agents run with Claude Code permissions on, user settings/plugins/hooks not loaded, file writes scoped to the audit workspace and deny rules for data-changing requests and offensive tools. Every process Audivra starts is recorded (PID + OS creation time, or exact container name) and only those are ever terminated — never by process name or pattern. Private model reasoning is never stored. Details and limits: [docs/security.md](docs/security.md).

## Data

Runtime data lives in `.local-data/` (git-ignored): one workspace per audit at `.local-data/audits/<id>/` (baseline, screenshots, browser, network, tools, scripts, notes, agent transcripts without thinking, final audit, exports). PostgreSQL stores audits, steps, pages, tool runs, evidence, findings (with issue keys and evidence links), artifacts, agent runs (model, prompt version, turns, termination reason, tool calls), owned processes, benchmark runs and the activity log.
