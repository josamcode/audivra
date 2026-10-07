# Audivra — AI Website Auditor

A local-first audit workstation: paste a URL, click **Start Full Audit**, and an autonomous AI auditor investigates the site with a real browser, a terminal, the project's auditing tools and its own throwaway scripts. Every important claim is backed by recorded evidence. A second AI pass reviews the draft adversarially, the auditor re-verifies what was challenged, and the result is a structured, evidence-linked audit in a professional workspace UI.

```
URL → deterministic baseline → AI Auditor (browser · terminal · scripts · evidence)
    → AI Reviewer → focused verification pass → Finalizer → findings + evidence + activity
```

## Quick start (Windows, macOS, Linux)

Requirements: Node.js ≥ 22.12, pnpm, Docker (or your own PostgreSQL), and — for the AI — an installed and logged-in [Claude Code](https://claude.com/claude-code) CLI (`claude auth status` → `loggedIn: true`).

```bash
pnpm install
pnpm run setup     # .env, PostgreSQL (docker compose if needed), migrations, Chromium, optional tools
pnpm dev           # API :4310 + worker + UI :4300
```

Open http://127.0.0.1:4300.

> Use `pnpm run setup`, not `pnpm setup` — the latter is a pnpm built-in that modifies your global PNPM_HOME.

Other commands: `pnpm tools` (print the tool registry), `pnpm fixture` (serve the deliberately flawed test
site on :4321), `pnpm build && pnpm start` (built UI via `vite preview`), and
`pnpm --filter @audivra/server dev:watch` / `pnpm --filter @audivra/worker dev:watch` for auto-restart while
developing (the worker restart interrupts running audits; pg-boss retries the interrupted stage).

No API key is needed: the AI runs through your local, already-authenticated Claude Code CLI. If Claude is unavailable, audits still run the full baseline and say clearly that the AI investigation did not run.

## What an audit does

1. **Baseline** (deterministic, cheap facts — treated as leads, never as conclusions): HTTP/redirects/security headers, TLS, robots.txt + sitemaps, a bounded same-site crawl (SEO metadata, headings, canonicals, hreflang, lang/dir, structured data), link/resource checking, Lighthouse (mobile) on the start page, and real-browser inspection of a spread of page types at desktop 1440×900 and mobile 390×844 (screenshots, console errors, failed requests, horizontal overflow, axe-core accessibility, tracking/analytics signals, technology hints, conversion-surface inventory).
2. **AI Auditor**: works out what the business is and what its primary conversion is, decides what deserves investigation, drives a real browser (Playwright MCP), runs tools (`lighthouse`, `linkinator`, `katana`, `httpx`, `curl`, Node + Playwright scripts it writes itself), and records evidence through an evidence MCP server. Returns a schema-validated draft.
3. **AI Reviewer**: challenges unsupported claims, overconfidence, inflated severity, duplicates, vague fixes and missed areas — reading the cited evidence itself.
4. **Verification pass** (bounded, one by default): if the reviewer asked for checks, the auditor resumes its own session and re-verifies.
5. **Finalizer**: merges, de-duplicates and orders findings and writes the executive summary — under deterministic guards: it cannot invent findings, cite evidence its sources never cited, or escalate severity beyond what the draft/reviewer supported.

Every finding has severity, category, type (`verified` / `supported-observation` / `inference`), calibrated confidence, verification status, affected pages, why it matters, business impact, a concrete fix with effort, an optional client-work opportunity — and links to evidence (`EV-…`) you can open in the UI.

## Architecture

```
apps/
  web/        React + Vite + TanStack Router/Query/Table + Tailwind v4 + Base UI (shadcn-style)
  server/     Fastify REST API, SSE live events (Postgres LISTEN/NOTIFY), artifact serving
  worker/     pg-boss stage jobs: baseline → investigation → review → revision → finalize
packages/
  contracts/  Zod schemas shared by everything (findings, evidence, agent outputs, DTOs)
  config/     env, paths (with traversal guards), Pino logger
  database/   Drizzle schema + migrations, repositories, pg-boss queues, event log
  tool-runtime/ process execution (execa, timeouts, tree-kill), tool registry/detection
  audit-core/ per-audit workspace, evidence/event context, deterministic baseline modules
  ai-runtime/ AgentProvider seam, Claude Code CLI provider, evidence MCP server, roles, output validation
prompts/      auditor-system.md, reviewer-system.md, finalizer-system.md (versioned product assets)
fixtures/site deliberately flawed test website
e2e/          Playwright end-to-end tests
```

See [docs/architecture.md](docs/architecture.md) and [docs/ui-system.md](docs/ui-system.md).

## Configuration (`.env`)

| Variable                                                                     | Default                                             | Purpose                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                                                               | `postgres://audivra:audivra@127.0.0.1:5440/audivra` | App database (bundled docker-compose DB on port 5440) |
| `AUDIVRA_AI`                                                                 | `claude`                                            | `off` = baseline-only audits                          |
| `AUDITOR_MODEL` / `REVIEWER_MODEL` / `FINALIZER_MODEL`                       | empty                                               | Claude model alias or ID; empty = Claude Code default |
| `AUDITOR_EFFORT` / `REVIEWER_EFFORT` / `FINALIZER_EFFORT`                    | `high` / `high` / `medium`                          | Claude Code `--effort`                                |
| `AUDITOR_TIMEOUT_MINUTES`                                                    | `60`                                                | Auditor time budget (verification pass gets half)     |
| `AUDITOR_MAX_TURNS`                                                          | `400`                                               | Hard turn cap                                         |
| `AUDIT_MAX_REVISIONS`                                                        | `1`                                                 | Verification passes after review (0 disables)         |
| `BASELINE_MAX_PAGES` / `BASELINE_MAX_LINK_CHECKS` / `BASELINE_BROWSER_PAGES` | `30` / `200` / `4`                                  | Baseline bounds                                       |

## Safety model

Audits may target sites you do not own, so the default behaviour is passive:

- The auditor runs with Claude Code permissions **on** (`--permission-mode dontAsk`): only listed tools are allowed, everything else is denied without prompting. File writes are scoped to the audit workspace (`Write(./**)`), and deny rules block data-changing HTTP requests (`curl -X POST`, `-d`, `-F`, …), active scanners (nuclei, sqlmap, nikto, ffuf, ZAP full/API scans, …) and destructive commands.
- The prompt forbids form submissions, purchases, account creation, logins and contacting the business; when a control's behaviour must be observed it has to be done with all non-GET requests and external navigations blocked.
- User settings, hooks, plugins and skills are not loaded into audit runs (`--setting-sources project,local`, `--disable-slash-commands`, `--strict-mcp-config`).
- Nuclei is disabled; ZAP/testssl are passive-only and optional.
- Private model reasoning is never persisted: thinking blocks are stripped from transcripts, and the Activity timeline shows only actions and one-sentence decision notes.

This is not a hardened sandbox: the auditor has a real shell in its workspace. A future version can add container isolation.

## Tests

```bash
pnpm test:unit          # schemas, validation/evidence linkage, parsers, signals, paths, activity
pnpm test:integration   # real PostgreSQL: repositories, API, full pipeline on the fixture (fake AI provider for failure paths)
pnpm test:e2e           # Playwright: real UI + API + worker + baseline on the fixture site (AI off)
pnpm test:e2e:ai        # Playwright: full AI audit with the local Claude Code runtime
```

## Data

Runtime data lives in `.local-data/` (git-ignored): one workspace per audit at `.local-data/audits/<id>/` with `baseline/`, `screenshots/`, `browser/`, `network/`, `tools/`, `scripts/`, `notes/`, `agent/` (prompts, redacted transcripts, outputs) and `final/audit.json`. PostgreSQL stores audits, steps, pages, tool runs, evidence (with artifact pointers), findings and their evidence links, agent runs (model, prompt version, turns, cost, validation notes) and the activity log.
