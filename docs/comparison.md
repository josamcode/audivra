# History, comparison and trends

## Site identity

Audits of the same site are grouped by `siteKey`: the host without `www.`, plus a non-default port (`https://www.example.com/en` and `http://example.com` → `example.com`). Benchmark audits carry `benchmark: true` and never mix with real site history.

## Comparing two audits

`GET /api/audits/:id/comparison[?with=<auditId>]` (default: the previous finished audit of the same site) returns `AuditComparison` (`packages/insights/src/compare.ts`):

- **Findings** are matched in two passes:
  1. **Issue key** — the finalizer gives every finding a stable kebab-case key (`www-certificate-mismatch`) and is shown the previous audit's keys so it reuses them for the same underlying issue. Same key ⇒ same issue, whatever the wording.
  2. **Similarity** for findings without keys (e.g. audits from before keys existed): 0.3 × same category + 0.5 × title-token Jaccard + 0.2 × affected-path Jaccard, threshold 0.55, best pairs first. Two findings with different keys are never matched.

  Matched findings are `unchanged` (same severity), `improved` (lower severity) or `regressed` (higher); unmatched current findings are `new`, unmatched previous ones `resolved`.
- **Metrics** (start-page Lighthouse scores and LCP/CLS/TBT/weight, broken links, console errors, failed requests, axe violations, finding counts) are compared with **noise thresholds** — e.g. 3 points for the performance score, 150 ms for LCP, 20 KB for weight — so lab jitter is reported as unchanged.
- **Technologies** added/removed, **coverage** per capability before/after.
- **Before/after screenshots**: the same page path and viewport captured in both audits (baseline captures preferred).

## Trends

`GET /api/sites/:siteKey/history` returns every finished audit of the site and series for performance, LCP, accessibility, broken links, findings, critical+high findings, verified findings, pages discovered and tracking tools. A series appears **only with at least two real audits that measured it** (`MIN_TREND_POINTS = 2`); nothing is interpolated or estimated. The Artifact Planner can only chart trends from these series.

## In the UI

The History tab shows the change summary, finding changes (with links to the earlier finding), metric changes beyond noise, technology and coverage changes, before/after screenshots, trend charts and the site's audit list, and lets you pick which earlier audit to compare with. The first audit of a site shows an explanatory empty state instead of a fake trend.
