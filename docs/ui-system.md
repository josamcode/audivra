# Audivra UI system

Audivra is an audit **workbench**: precise, calm, dense, data-first. Think Linear / Sentry / Raycast
in spirit — not a marketing dashboard. This document is the contract for `apps/web`.

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

## Typography

- UI: Inter Variable. Mono (URLs, IDs, refs, metrics, durations): JetBrains Mono Variable. Both are
  bundled locally via Fontsource (no network fonts).
- Scale (custom, compact): `text-2xs` 11px (section labels, refs) · `text-xs` 12px · `text-sm` 13px
  (default UI/table text) · `text-base` 14px (body prose) · `text-lg` 16px (drawer titles, metric values)
  · `text-xl` 20px (page titles). Nothing larger.
- Numbers use `tabular-nums`. Section labels: `SectionLabel` (2xs, uppercase, tracking-wide, subtle).

## Spacing, radius, shadow

- Tailwind's 4px spacing scale only. Page gutter `px-4 sm:px-6`; panel padding `p-4`; table cells
  `h-10 px-3`; gaps between panels `gap-4`, inside toolbars `gap-2`.
- Radius: `rounded-sm` (badges, tags, small controls) · `rounded-md` (buttons, inputs, inner boxes) ·
  `rounded-lg` (panels, modal). `rounded-full` only for dots and bars.
- Shadow: `shadow-popover` (select/tooltip popups) and `shadow-overlay` (drawer/modal). Panels have no
  shadow — borders separate surfaces.
- Arbitrary values are limited to layout grid templates (e.g. `lg:grid-cols-[minmax(0,1fr)_22rem]`) and
  viewport calcs for sticky/scrolling panes. Inline styles only for data-driven bar widths.

## Components

Primitives (`src/components/ui`, built on Base UI where interaction is non-trivial):
`Button`/`buttonVariants`, `Input`/`Label`, `Select` (Base UI), `Tabs`/`TabPanel` (Base UI),
`Sheet` (right drawer) and `Modal` (Base UI Dialog), `Tooltip` (Base UI), `SegmentedControl`,
`Badge`/`Dot`/`tagVariants`, `Skeleton`, `Separator`/`Kbd`.

Product layer (`src/components`):

| Component | Use |
| --- | --- |
| `AppShell` | Sidebar (desktop) / top bar (mobile), runtime status, theme switch |
| `PageHeader`, `Toolbar` | Page title + actions; filter/search bars above tables |
| `Panel`, `PanelHeader`, `PanelBody`, `SectionLabel`, `DefinitionList` | The one bordered container; never nest panels |
| `Metric`, `CountCell` | Compact labelled numbers (no KPI cards) |
| `StatusBadge`, `SeverityBadge`, `FindingTypeBadge`, `ToolStateBadge`, `EvidenceTypeBadge`, `StepIcon`, `Confidence`, `LevelText` | All status vocabulary lives in `badges.tsx` |
| `DataTable` + `useDataTable` | Every table: TanStack Table sorting + filtering, row click, empty/loading states |
| `StageProgress` | Broad stage indicator — never a fake percentage |
| `FindingDrawer` | Finding detail with inline evidence viewer, j/k navigation |
| `EvidenceViewer`, `ArtifactPreview`, `MetadataView`, `ScreenshotViewer` | Generic evidence rendering for any metadata shape; raw JSON only behind “Raw” |
| `ActivityTimeline` | Stage-grouped activity log (actions, tools, concise AI notes) |
| `ToolStatusTable` | Tool registry |
| `EmptyState`, `LoadingState`, `ErrorState`, `Notice` | Every async view has all three states; `Notice` for honest partial/failed explanations |

## Rules

Do:
- Reuse the components above; add a variant before adding a new pattern.
- Keep the URL as state for anything shareable (tab, open finding, selected evidence).
- Show uncertainty honestly: finding type (verified / observation / inference), confidence, skipped
  capabilities, failed stages.
- Check new screens at 1440×900 and 390×844 in light and dark.

Don't:
- Hex/rgb colours, Tailwind palette colours, gradients, glass effects, glow shadows.
- Giant cards, hero sections, KPI walls, decorative charts, coloured icon tiles.
- Raw `<select>`/`<input>` outside `components/ui`, custom modals or dropdowns.
- Dump JSON in the primary UI or show model reasoning anywhere.
