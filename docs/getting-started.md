# Getting started with Audivra

> This is the product overview and install guide. The repository `README.md` has local uncommitted edits, so
> the V1 product overview lives here; keep the two in sync when the README is next updated.

## What Audivra is

Audivra is a **local-first platform for website auditing and authorized security assessment**. It runs two
product surfaces over the same engine:

- **Website Audit** — an AI-assisted quality/SEO/UX/accessibility audit of a site (the original product).
- **Authorized Security Assessment** — a deterministic, evidence-backed security engine: authorization +
  scope + policy → durable, isolated capability execution → observations → a Security Graph → hypotheses →
  differential authorization/business comparisons → independent verification → findings → evidence-backed
  attack paths → retesting & historical comparison, plus an optional external specialist engine (Strix) and
  an **autonomous research loop** that orchestrates all of it.

Audivra's governing principle: **deterministic Audivra code owns authority and truth; the AI only reasons and
proposes.** Every AI/tool output is validated before it changes state. See [security-model](security.md) and
[threat model](security-threat-model.md).

## What Audivra is NOT

- Not a one-click "scan the internet" tool — it only tests targets you have declared and authorized, within a
  deterministic scope, under an environment policy.
- Not a guaranteed-complete penetration test — it reports **residual uncertainty** and never claims full
  coverage.
- Not a hosted multi-tenant SaaS in V1 — it is a single-user, local-first application (see
  [known limitations](known-limitations.md)).

## Install & run

```bash
pnpm install          # install workspace dependencies (no large downloads, no Docker pulls)
pnpm run setup        # idempotent: create/migrate the database, prepare local paths + dev vault key
pnpm run doctor             # deterministic environment diagnostics (DB, Docker, disk, provider, tools, worker)
pnpm dev              # run the API + worker + web app
```

Optional components are explicit and never auto-installed:

```bash
pnpm setup:strix        # inspect/prepare the optional Strix specialist engine (disk-checked, no implicit pull)
pnpm run demo                   # create a local demo assessment against the bundled fixture (no external target)
```

Prerequisites: Node + pnpm, PostgreSQL (the repo uses Docker on port 5440 by default), and — for the
container-isolated sensors and the specialist — Docker. Audivra degrades gracefully when Docker, the AI
provider, a tool or the specialist is unavailable (`pnpm run doctor` shows exactly what is usable).

## The assessment workflow

```
Create engagement → choose environment + policy → authorize the target → define scope → declare identities
→ (optional) start an autonomous Research run → observations → Security Graph → hypotheses → comparisons
→ independent verification → findings → attack paths → retest/history → client report
```

See [assessment workflow](security-engagements.md) and [autonomous research](security-research.md).

## Safety model (summary)

- Authorization, scope, environment policy and runtime are deterministic and authoritative; the AI cannot
  change them, access secrets, choose a runtime, verify its own finding, or expand scope.
- Sensors run in hardened, network-controlled containers; the specialist's live-target modes are fail-closed
  (disabled until containment is proven); production defaults are conservative.
- Secrets live in an encrypted vault whose key is separate from the database and never appears in events,
  the graph, exports or AI context.

## Development status

V1 is a complete, validated security platform (Phases 1–6F). It is **local-first and single-user**. The
development status, deployment model and the honest list of what is and is not supported are in
[known limitations](known-limitations.md) and [operations](operations.md).
