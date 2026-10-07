# Testing and the quality benchmark

## Suites

| Command | What it covers |
| --- | --- |
| `pnpm test:unit` | contracts; AI output validation (evidence linkage, severity clamps, issue keys, fallbacks); baseline parsers; scanner parsers (ZAP, testssl, httpx, Katana, Pa11y — from real captured output); tracking events; localization signals (hreflang reciprocity, mixed-language UI); artifact grounding (catalog values, literal values must appear in evidence, NaN, unknown refs, trends need ≥ 2 audits, CSS-px → image-fraction regions); comparison (issue keys, similarity, improved/regressed, metric noise, before/after pairing); report-plan sanitizing; benchmark scoring; process ownership (spawns real processes: kills only the cancelled audit's, survives PID reuse, never reaps a live owner's); report rendering |
| `pnpm test:integration` | real PostgreSQL and the fixture site: repositories; API; the full pipeline with a scripted AI provider (planner grounding, composer sanitizing, prompt versions, ceilings and wrap-up options, presenting fallbacks, restart safety); baseline with optional scanners; every export format generated from persisted data (PDF magic bytes, HTML free of internal IDs, JSON schema, CSV, ZIP layout) without re-running anything |
| `pnpm test:e2e` | Playwright: real UI + API + worker + baseline on the fixture site with AI off |
| `pnpm test:e2e:ai` | Playwright: a full AI audit with the local Claude Code runtime |
| `pnpm typecheck` | all packages plus tests, scripts and E2E (`tsconfig.tests.json`) |

Integration and E2E tests use their own databases (`audivra_test`, `audivra_e2e`) and data directories; they never touch development data.

## Fixture sites

`fixtures/site/server.mjs` serves three variants (`pnpm fixture -- --variant=v1,v2,healthy`):

- **v1** — "Nile Smile Dental": planted SEO, broken-link, JavaScript, mobile-overflow, accessibility, Arabic RTL/mixed-language, tracking and security-header problems.
- **v2** — the same site partly fixed (meta description, JS error, broken links) with two new problems (a `noindex` contact page and a ~4.3 MB hero image). Run after v1 on the same port it exercises comparison: resolved, new and persisting issues.
- **healthy** — "Atlas Physio", bilingual EN/AR with correct RTL, reciprocal hreflang, labels, alt text and security headers. Used to measure false positives.

## Benchmark

`fixtures/site/expectations.json` holds the ground truth: per fixture, the planted issues (case-insensitive patterns over title/description/observation, acceptable severity band, expected evidence), claims known to be **absent** (a matching non-info finding is a false positive), and **tolerated** environment facts (e.g. plain HTTP on 127.0.0.1). Subjective expectations (e.g. "thin trust content") are reported but never scored.

`pnpm benchmark` (or System → Quality → Run benchmark) runs a full audit of each fixture and stores per fixture: known issues found/missed, false positives (with reasons), unsupported findings (no evidence), severity-band accuracy, evidence linkage, duration and auditor turns — together with the prompt versions used, so runs are only compared when prompts match. Each run makes real AI calls (roughly 10–25 minutes per fixture).
