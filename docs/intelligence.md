# Website intelligence

Six connected features on top of the audit: audit templates, journeys, the evidence graph, Change
Intelligence, the Client view and the Client Brief. The rule throughout: **deterministic facts are the
source of truth; AI explains them, and every AI statement is checked against them before it is stored.**

## Audit templates (audit focus)

`packages/contracts/src/templates.ts` defines seven templates: General website (default), Lead generation,
E-commerce, SaaS, Portfolio / personal brand, Arabic / bilingual and Technical deep dive. Each has a
version, a one-line description for the selector, a mission context, priority areas, the journey types to
look for first and a prompt addendum.

- A template is **guidance, not a checklist**. The auditor's prompt gets an "Audit focus" section that says
  so explicitly; the reviewer and finalizer get a one-line focus. Material issues outside the focus are still
  reported.
- New audit → *Audit focus* (default General website). `POST /api/audits { template }` stores
  `audits.template_key` + `template_version`; audits from before templates show none. There is no automatic
  template detection (it would not be reliable from a URL alone).
- The focus appears in the audit header, the client report cover, the JSON export and benchmark results.

## Journeys

A journey is the path a visitor takes to a goal (enquiry, booking, purchase, sign-up…), stored in the
`journeys` table with ordered steps and health per dimension. Types: lead, booking, purchase, signup, demo,
contact, content-discovery, portfolio-contact, support, custom.

- **Steps** carry a label, URL (page steps), kind (page / action / outcome), the action that moves on, the
  conversion type on the converting step, a status — ok, friction, blocked, unverified — a note and evidence.
- **Health** has seven dimensions — visibility, friction, tracking, mobile, performance, accessibility,
  continuity — each healthy / warning / problem / unknown / not assessed, with a one-sentence reason and the
  evidence and findings behind it. **There is no journey score** and no conversion rate.
- **During an audit**: the auditor discovers and walks the important journeys (`AuditDraft.journeys`, findings
  point at them with `journeyIds`); the reviewer challenges each one (`journeyReview`); the finalizer keeps the
  supported ones, gives each a stable `journeyKey` (reusing the previous audit's keys for the same journey) and
  orders the primary journey first.
- **Validation** (`checkJourneys` in `validate.ts`): evidence must exist (and, for final journeys, be cited by
  their source journeys); a friction/blocked step without evidence becomes *unverified*; a healthy / warning /
  problem verdict without evidence or findings becomes *unknown*; a journey without any valid evidence is
  dropped; at most one journey is primary. Malformed journey keys are cleaned before schema validation.
- **Audits from before journeys** show "Journey analysis not available for this audit." with *Analyze
  journeys*: the journey analyst (`journey-analyst:v1`) maps journeys from the stored crawl, evidence and
  findings — read-only tools, no browser — and links existing findings to them. Nothing is backfilled
  automatically.

## Evidence graph

`GET /api/audits/:id/graph?focus=finding:F3&depth=2` (`packages/insights/src/graph.ts`) builds the
neighbourhood of one finding, evidence item, journey, page, run or visual from stored relationships only:
finding → evidence (*supported by*), evidence → page (*captured on*) and → tool or AI run (*produced by*),
finding → journey (*affects*), finding → page (*affects page*), journey → evidence (*step evidence*), visual →
finding / evidence (*visualizes*, *derived from*).

- Default depth 2, *Expand* to 3, at most 36 nodes (nearest first; `truncated` says when items were left out).
- Pages, runs, visuals and journeys are **context hubs**: shown, but only walked through when they are the
  focus — otherwise the home page or an impact/effort matrix would pull in the whole audit. The walk itself goes
  finding ↔ evidence.
- UI: Evidence tab → *Graph* (also *Evidence graph* in the finding drawer and journey detail). Layered
  left-to-right layout, selection highlights links, the side panel shows the item (the full evidence viewer for
  evidence) and its connections in plain words, *Center graph here*, *Reset*, *Fit view* / *Actual size*.
  Focus, origin and view are in the URL.

## Change Intelligence

The comparison with the previous audit (`buildComparison`) is deterministic and stays the source of truth:
finding changes (matched by issue key, then similarity), metrics with noise thresholds, technologies,
**tracking tools**, **journeys** (matched by key, then type and path; path, primary, step-status and health
changes), coverage and before/after screenshots. **Finding timelines** follow each issue across all of a site's
audits: *detected*, *not found* or *detected again*.

- The change analyst (`change-analyst:v1`, no tools) interprets those facts: a headline, a short summary and up
  to ten insights (regression, improvement, new issue, not found again, persistent, journey, tracking, metric,
  technology, coverage), each with a basis — **verified**, **observed**, **correlated** or **likely** — and
  references to findings, journeys, metrics and evidence.
- `validateChangeAnalysis` keeps only references that exist and drops any insight the facts do not support for
  its kind (a "regression" needs a regressed/new finding, a regressed metric or a changed journey; "not found
  again" needs a finding the comparison did not find again). A "not found again" insight is never *verified*,
  and a title claiming a fix is reworded to "Not found again: …".
- It runs automatically in the presenting stage of a new audit (before the report composer, which uses it) and
  on demand (*Generate change intelligence* / *Regenerate*). During presenting the comparison uses the audit's
  final facts: coverage is recomputed from the steps, finding totals count once finalization completed, and the
  stage still in progress is not reported as a coverage change.
- UI: History → "What changed since the previous audit?" (headline, summary, insight cards), then the summary
  counts, finding changes, journey changes, measurements, technology/tracking/coverage, screenshots, issue
  timelines, trends and the site's audits. The Overview shows the headline under "Since the previous audit".

## Client view

`/audits/:id/client` (the old `/report` URL redirects there; *Internal | Client* in the audit header) renders the
same `ClientReport` document as the PDF and HTML exports — shared content decisions — in a wider screen variant,
without the app sidebar, runtime status or navigation. Section links, PDF/HTML/data exports.

The report model (`audivra.report.v2`) adds the audit focus, the primary journey (plus at most one more, steps
and judged dimensions, never a score) and "What changed since the previous audit" (the interpretation above the
deterministic comparison). It contains no run IDs, session IDs, prompt versions, model names, turn counts, local
paths, shell commands, reviewer mechanics or benchmark data; `clientSafeText` strips paths and commands the AI
quoted while describing observations.

## Client Brief

Header → *Client brief*. One generation (`client-brief:v1`, no tools, on request) produces four views from the
finalized audit — **Quick brief**, **Meeting prep**, **Talking points**, **Technical brief** — stored in
`client_briefs` (one per audit; *Regenerate* replaces it). Every issue, proof point and journey cites the audit
(F*, EV-*, J*); `validateClientBrief` drops references that do not exist and rejects a brief that cites no real
finding. *Copy brief* copies the current view as Markdown, *Copy talking points* the points. Nothing is sent
anywhere: no email, CRM or ROI figures. The brief is preparation for the user and is not shown in the Client
view.

## On-demand jobs

Journey analysis, Change Intelligence and the Client Brief run on the worker through the `audit-enrich` queue
(`{ auditId, kind }`, one job per audit and kind at a time, no automatic retries). `GET` on each endpoint
returns the result plus a status (running, last error, last completed, available and why not); the UI polls
while a job runs. Each run is an ordinary AI run (Runs tab, Activity log, prompt version stored); a worker
restart closes interrupted on-demand runs as failed.

| Endpoint | Returns |
| --- | --- |
| `GET/POST /api/audits/:id/journeys` | journeys (primary first, with linked findings) · queue journey analysis |
| `GET /api/audits/:id/graph?focus=&depth=` | `EvidenceGraph` (404 when the focus does not exist) |
| `GET/POST /api/audits/:id/changes` | comparison, stored interpretation, timelines · queue Change Intelligence |
| `GET/POST /api/audits/:id/brief` | stored brief · queue (re)generation |
