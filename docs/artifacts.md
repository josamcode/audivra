# Visual artifacts

> The AI decides **what** should be visualized. Audivra decides **how** it is rendered — and **where every number comes from**.

An artifact is a structured, validated visual representation of evidence or an insight. It is not a finding (a conclusion) and not evidence (proof); it is a view onto them. Findings and artifacts link to each other, and every factual artifact links back to evidence.

## Flow

```
Artifact Planner (prompts/planner-system.md)
   │  ArtifactSpec[]: type, title, question, evidenceIds, findingIds, placement, data
   ▼
Resolver (packages/insights/src/artifacts.ts)
   │  numbers  → metric catalog value (metricKey)  or  literal found in the cited evidence (±5%, unit conversions)
   │  images   → evidence with an image file; regions converted to image fractions and clipped
   │  refs     → unknown evidence/finding IDs dropped; a factual visual without evidence is rejected
   │  history  → trend/line charts only from ≥ 2 real audits; before/after only from real screenshot pairs
   │  data     → validated against the per-type Zod schema (contracts/src/artifacts.ts)
   ▼
Stored Artifact (A1, A2, … per audit)  →  rendered by packages/report-ui in the app, HTML, PDF, PNG and SVG
```

Specs that cannot be grounded are rejected with a recorded reason (`agent/artifact-resolution.json`, and an Activity note). If the planner is unavailable or yields fewer than two usable visuals, deterministic specs built from measured data fill the gap (`fallbackArtifactSpecs`) and are marked `createdBy: system`.

## The metric catalog

`buildMetricCatalog()` extracts measured numbers from evidence metadata into keyed entries the planner can reference instead of typing numbers:

| Key pattern | Source |
| --- | --- |
| `lighthouse:<path>:<mobile\|desktop>:<performance\|accessibility\|bestPractices\|seo\|lcp\|fcp\|tbt\|cls\|si\|tti\|ttfb\|weight>` | Lighthouse reports (baseline and any the auditor saved under `tools/lighthouse/`) |
| `browser:<path>:<desktop\|mobile>:<ttfb\|dcl\|load\|lcp\|cls\|requests\|transfer\|thirdParties>` | real-browser inspection |
| `axe:<path>:<violations\|nodes>`, `console:<path>:errors`, `network:<path>:failures`, `mobile:<path>:scrollWidth` | baseline browser checks |
| `links:<checked\|broken\|brokenInternal\|inconclusive>`, `crawl:<pages\|discovered>`, `seo:<…>` | crawl and link checking |
| `tls:daysRemaining`, `tracking:detected`, `zap:<high\|medium\|low\|informational>` | TLS, tracking, ZAP |
| `evidence:<EV-ref>:<name>` | any number the auditor recorded under `metadata.metrics` |

The auditor prompt asks for `metadata.metrics` (numbers with the unit in the name) and `metadata.regions` (CSS-pixel boxes from `getBoundingClientRect()`) so its own measurements become chartable and its screenshots annotatable with exact coordinates.

## Types

| Group | Types | Notes |
| --- | --- | --- |
| Metrics | `metric`, `metric_group` | headline numbers |
| Comparison | `comparison_bar`, `comparison_table` | e.g. English vs Arabic homepage |
| Distribution | `bar_chart`, `stacked_bar`, `donut` | donut only for true parts of a whole |
| Trend | `line_chart`, `trend_metric` | only with ≥ 2 real audits of the site |
| Matrix | `matrix`, `heatmap` | qualitative coverage, page × check |
| Specialised | `tracking_coverage`, `page_performance` | tag present vs conversion event observed; Lighthouse table built from the catalog |
| Flows | `journey`, `funnel` | steps and friction only — never invented traffic or conversion rates |
| Structure | `site_graph`, `tech_map`, `timeline` | built from crawl graph, technologies, audit records |
| Media | `evidence_gallery`, `annotated_screenshot`, `before_after` | annotations are rendered overlays, never edited images |
| Planning | `impact_effort` | opportunities by impact and effort (qualitative) |

Placement: `overview` (at most two featured visuals), `report` (client narrative), `appendix` (technical support).

## Rendering and export

All renderers live in `packages/report-ui` and are pure React (no data fetching), so the app, the standalone HTML report, the PDF (Playwright print of that HTML) and the PNG export (`GET /api/audits/:id/visuals/A3.png`, device scale 2) are pixel-consistent. Vector-friendly types also export as SVG (`A3.svg`). Colours come from a fixed token set; there is no AI-generated HTML, SVG or CSS anywhere.
