# Audivra UI system

Audivra is an audit **workbench**: precise, calm, dense, data-first. Think Linear / Sentry / Raycast
in spirit — not a marketing dashboard. This document is the contract for `apps/web` and for the
visual renderers in `packages/report-ui`.

## Tokens (single source: `apps/web/src/styles.css`)

Tailwind's default palette, radius, shadow and type scales are **removed** (`--color-*: initial` etc.),
so only the tokens below exist. Light and dark values live on `:root` and `.dark`; the theme follows
`prefers-color-scheme` unless the user picks Light/Dark in the sidebar.

| Purpose | Utilities |
| --- | --- |
| Page / surfaces | `bg-background`, `bg-surface` (panels), `bg-surface-muted` (table headers, sidebar), `bg-surface-hover`, `bg-surface-selected` |
| Lines | `border-border`, `border-border-strong` (hover / emphasis) |
| Text | `text-foreground`, `text-muted` (secondary), `text-subtle` (tertiary, labels) |
| Action | `bg-primary` / `text-primary-foreground` (the one primary button style), `text-link`, `ring` (focus) |
| Overlay | `bg-overlay` (drawer/modal backdrop) |

### Colour is semantic only

`critical`, `high`, `medium`, `low`, `info` (severity) and `success`, `running` (status), each with a
`-soft` background (`bg-critical-soft text-critical`). Failed = critical, warning/partial = medium.
Never use colour for decoration, icon backgrounds or emphasis.

Metric tones follow documented thresholds (Lighthouse score ≥90 good / ≥50 needs work; LCP ≤2.5 s /
≤4 s; CLS ≤0.1 / ≤0.25; TBT ≤200 ms / ≤600 ms). Counts > 0 of problems (broken links, console errors)
use the critical tone; zero is `text-subtle`.

### Visual artifact tokens (`--av-*`)

The renderers in `@audivra/report-ui` read only `--av-*` variables (`--av-bg`, `--av-fg`,
`--av-muted`, `--av-subtle`, `--av-border(-strong)`, `--av-accent(-soft)`, the severity/status colours
and their `-soft` variants, `--av-font-sans`, `--av-font-mono`). Three themes exist:

| Context | Where | Behaviour |
| --- | --- | --- |
| App | `apps/web/src/styles.css` (`:root` mapping) | `--av-*` point at the app tokens, so visuals follow light/dark |
| Client report | `.rp-document` / `.rp-standalone` in `report.css` | Pinned to a light print theme — the preview stays “paper” in dark mode |
| Vector export | `EXPORT_PALETTE` in `theme.ts` | Concrete colours, because a standalone SVG cannot resolve CSS variables |

The accent (`--av-accent`, the link blue) is the single neutral series colour; severity colours are
used only when a series *is* a severity.

## Typography

- UI: Inter Variable. Mono (URLs, IDs, refs, metrics, durations): JetBrains Mono Variable. Both are
  bundled locally via Fontsource (no network fonts). Exports embed Inter, JetBrains Mono and Noto Sans
  Arabic as data URIs, so HTML/PDF render identically offline (Arabic included).
- Scale (custom, compact): `text-2xs` 11px (section labels, refs) · `text-xs` 12px · `text-sm` 13px
  (default UI/table text) · `text-base` 14px (body prose) · `text-lg` 16px (drawer titles, metric values)
  · `text-xl` 20px (page titles, KPI strip values). Nothing larger.
- Numbers use `tabular-nums`. Section labels: `SectionLabel` (2xs, uppercase, tracking-wide, subtle).

## Spacing, radius, shadow

- Tailwind's 4px spacing scale only. Panel padding `p-4`; table cells `h-10 px-3`; gaps between panels
  `gap-4`, inside toolbars `gap-2`.
- **One page frame.** Every page's header, tab bar and content use `pageFrame` (`page-header.tsx`:
  `max-w-screen-2xl`, gutter `px-4 sm:px-6`), so edges never move between pages. Full-width bands (tab
  bars, the audit header) apply it to an inner element. Page headers use `pt-5 pb-4`, content after a tab
  bar starts at `pt-4`, and two-column pages share `pageColumns` (main column + 20/22rem rail).
  Sidebar destinations have no breadcrumb; drill-down pages (an audit) show it as the first line.
- Radius: `rounded-sm` (badges, tags, small controls) · `rounded-md` (buttons, inputs, inner boxes) ·
  `rounded-lg` (panels, modal, artifact frames). `rounded-full` only for dots and bars.
- Shadow: `shadow-popover` (select/menu/tooltip popups) and `shadow-overlay` (drawer/modal/dialog).
  Panels have no shadow — borders separate surfaces.
- Arbitrary values are limited to layout grid templates (e.g. `lg:grid-cols-[minmax(0,1fr)_22rem]`) and
  viewport calcs for sticky/scrolling panes. Inline styles only for data-driven bar widths.

## Components

Primitives (`src/components/ui`, built on Base UI where interaction is non-trivial):
`Button`/`buttonVariants`, `Input`/`Label`, `Select` (Base UI), `Tabs`/`TabPanel` (Base UI),
`Sheet` (right drawer) and `Modal` (Base UI Dialog), `Menu`/`MenuItem`/`MenuGroup` (Base UI Menu),
`ConfirmDialog` (Base UI AlertDialog, for actions with real cost), `Tooltip` (Base UI),
`SegmentedControl`, `ChoiceList` (a few options that each need a sentence, e.g. the engagement environment), `Switch` (Base UI), `Input`/`Textarea`, `Badge`/`Dot`/`tagVariants`, `Skeleton`, `Separator`/`Kbd`.

Product layer (`src/components`, `src/features`):

| Component | Use |
| --- | --- |
| `AppShell` | Sidebar (desktop) / top bar (mobile), runtime status, theme switch |
| `PageHeader`, `PageFrame` / `pageFrame` / `pageColumns`, `Toolbar` | Page title + actions; the shared page frame and two-column grid; filter/search bars above tables |
| `Panel`, `PanelHeader`, `PanelBody`, `SectionLabel`, `DefinitionList` (`numeric` / `text` / `stacked`) | The one bordered container; never nest panels |
| `Metric`, `CountCell` | Compact labelled numbers |
| KPI strip (overview, history, quality) | One bordered row of 5–6 real counts with a one-line detail each — never a score, never decoration |
| `StatusBadge`, `SeverityBadge`, `FindingTypeBadge`, `ToolStateBadge`, `EvidenceTypeBadge`, `CoverageIcon`, `StepIcon`, `Confidence`, `LevelText`, `ROLE_LABELS`, `ReadinessBadge`, `DecisionBadge`, `ENGAGEMENT_STATUS_LABEL`, `ENVIRONMENT_LABEL` | All status vocabulary lives in `badges.tsx` |
| `DataTable` + `useDataTable` | Every table: TanStack Table sorting + filtering, row click, empty/loading states. Keep `autoResetAll: false`. |
| `StageProgress` | Broad stage indicator (incl. “Visuals & report”) — never a fake percentage |
| `AppArtifact`, `ArtifactExportMenu` | A visual artifact in the app: trusted renderer + evidence/finding links + PNG/SVG export |
| `ExportMenu` | Report (PDF/HTML), data (JSON/CSV) and ZIP bundle downloads with progress toasts |
| `FindingDrawer` | Finding detail: visual proof (its artifacts) or first screenshot, inline evidence viewer, j/k navigation |
| `EvidenceViewer`, `ArtifactPreview`, `MetadataView`, `ScreenshotViewer` | Generic evidence rendering for any metadata shape; annotated/original toggle; citing findings; producing tool run; raw JSON only behind “Raw” |
| `ActivityTimeline` | Stage-grouped log; consecutive actions by one AI role collapse into one row |
| `ToolStatusTable`, `QualityPanel`, `ProcessesPanel` | System → Tools / Quality (benchmark) / Processes |
| `EmptyState`, `LoadingState`, `ErrorState`, `Notice` | Every async view has all three states; `Notice` for honest partial/failed explanations |

## Visual artifacts — AI decides *what*, Audivra renders *how*

The artifact planner chooses which question a visual answers and which evidence it rests on. It never
writes numbers: values are resolved from the metric catalog and recorded evidence by Audivra, then
drawn by the trusted renderers in `@audivra/report-ui` (22 types: metrics, bars, stacked bars, donut,
trends, tables, matrices, heatmap, tracking coverage, page performance, journey, funnel, site graph,
timeline, evidence gallery, annotated screenshot, before/after, tech map, impact/effort).

- Every visual is framed the same way: title, the question it answers, the visual, a one-line
  description, and the evidence (`EV-*`) and findings (`F*`) it rests on — clickable in the app.
- Charts are deterministic SVG or HTML/CSS (no DOM measurement), so the app, HTML, PDF, PNG and SVG
  outputs are the same drawing. Tables and bars stay HTML for selectable text and clean printing.
- Trends use only real audit snapshots (≥ 2), with audit dates on the x axis — nothing interpolated.
- Funnels are journey steps observed in the browser, explicitly “not traffic or conversion rates”.
  Tracking coverage separates “tool present” from “conversion event observed”.
- Charts carry text alternatives (an `aria-label` summary or a visually hidden data table).
- Don't add a chart where a sentence or a table answers the question better.

## Client report

`ClientReportDocument` renders the client report for the Client view (`/audits/:id/client`, screen
variant: wider, slightly larger type, no app chrome), the standalone HTML export and the PDF (Chromium
print). The Client view is the same component on the light paper theme; the PDF adds A4 page rules, page numbers and expands collapsed sections. The report model
contains no run IDs, prompt versions or model details. Because exports render with browser defaults,
the app restores those defaults inside `.rp-document` and `.av-frame` (see `styles.css`), so the
preview cannot drift from the exported files.

## Screens

- **Audits (home)** — answers “what needs my attention?”: a five-cell summary strip (audits, active work,
  websites, findings in the latest audits, average duration), *Running now* only while work is in flight
  (real stages), recent audits (site mark, status, start/duration, severity summary, severity-history trend,
  search and filters), priority follow-ups; rail: system health (worker, database, Claude, tools), recent
  activity, sites with repeat issues. Benchmark audits are hidden unless the header switch is on (URL `?benchmark=true`);
  local targets are tagged and never counted as websites. No audits yet → one empty state plus system health.
- **Overview** — first viewport answers “what state is this site in?”: status/visual-report notices,
  KPI strip (findings, verified share, pages, evidence, coverage, change since last audit), executive
  take with “View full analysis”, what matters most (top risks), featured visuals (or key baseline
  measurements), top opportunities, limitations grouped by kind; side column: severity and categories,
  business at a glance, coverage per capability, technologies.
- **Journeys** — journey list (type, primary, step/health summary) and detail: goal, steps as a vertical
  flow (status markers, notes, evidence chips), seven health dimensions with reasons (never a score),
  findings on the journey. Audits without journeys get an honest empty state and *Analyze journeys*.
- **Evidence → Graph** — layered stored-link graph around one item with a side panel (item + connections in
  plain words), *Expand*, *Reset*, *Fit view*; neutral strokes, the selection's links in foreground colour.
- **Findings**, **Visuals** (by placement, filterable, PNG/SVG export), **Evidence**, **Pages**
  (inventory: HTTP, language/direction, source, browser-inspected, findings per page),
  **History** ("What changed since the previous audit?" insight cards with kind and basis, change summary,
  finding and journey changes, measurement deltas, technology/tracking/coverage changes, before/after
  screenshots, issue timelines, trends, audits of the site), **Activity**, **Runs**.
- **Client view** — *Internal | Client* toggle in the audit header; the client report without app chrome,
  section links, PDF/HTML download and a menu for JSON, CSV and the ZIP bundle.
- **Client brief** — right sheet from the audit header: Quick brief · Meeting prep · Talking points ·
  Technical brief, references open the item, *Copy brief*, *Copy talking points*, *Regenerate*.
- **Security** — engagement list (readiness, environment, status, policy) and *New engagement* (environment chosen
  deliberately); an engagement has Overview (readiness checklist computed from requirements, capability catalog),
  Scope (structured editor validated by the shared schema, *Check a URL* by name and resolved address), Authorization
  (records, revoke, every method with its availability), Policy (environment, profile, effective risk/mutation classes
  and limits) and Audit trail (append-only events; decisions expand into their checks). There is no action that runs
  a test or a capability.
- **System** — Tools (state, version, how provided, detail, re-check), Quality (benchmark runs, per
  fixture detail, run with confirmation), Processes (processes and containers Audivra owns).

## Rules

Do:
- Reuse the components above; add a variant before adding a new pattern.
- Keep the URL as state for anything shareable (tab, open finding, selected evidence, page filter,
  compared audit, system tab, benchmark visibility).
- Show uncertainty honestly: finding type (verified / observation / inference), confidence, coverage
  that did not run and why, failed stages, limitations by kind.
- Confirm actions that spend AI usage or run long jobs (benchmark); show progress for generated files.
- Check new screens at 1440×900, 1920×1080 and 390×844 in light and dark, and the report in print.

Don't:
- Hex/rgb colours, Tailwind palette colours, gradients, glass effects, glow shadows (the only
  concrete colours are `EXPORT_PALETTE`, for standalone SVG).
- Health scores, invented numbers, estimated trends or ROI claims.
- Giant cards, hero sections, KPI walls, decorative charts, coloured icon tiles.
- Raw `<select>`/`<input>` outside `components/ui`, custom modals or dropdowns.
- Dump JSON in the primary UI or show model reasoning anywhere.
