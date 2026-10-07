# Reports and exports

All exports are generated **on demand from persisted data** (`packages/reporting`). Generating a PDF never re-runs the audit or calls the AI. Files are written to `.local-data/audits/<id>/exports/` and served by `GET /api/audits/:id/export/:kind`; `GET /api/audits/:id/exports` lists what is available (and why something is not).

## One report model, several renderers

```
persisted audit ──► buildClientReport() (insights)  ──► ClientReport (audivra.report.v1)
                       + composer plan when present         │
                                                           ├─► React preview  /audits/:id/report
                                                           ├─► standalone HTML (images inlined as JPEG data URIs)
                                                           └─► PDF (Playwright print of that HTML, A4, page numbers)
```

The client report shows: cover · executive snapshot (5–8 lines) · what matters most · visual evidence · major findings (problem → proof → why it matters → fix) · area highlights · opportunities (impact × effort) · recommended action plan (do first / then / later) · technical appendix (other findings, coverage, technologies, pages, methodology, categorized limitations, full analysis).

It deliberately contains **no** run IDs, session IDs, prompt versions, model names, turn counts, costs or debug logs. A visual that proves a major finding appears with that finding, not twice.

## Export kinds and file names

The file name prefix is a readable site slug (`josamcode.com` → `josamcode`, `books.toscrape.com` → `books-toscrape`).

| Kind | File | Contents |
| --- | --- | --- |
| `pdf` | `<site>-audivra-report.pdf` | client report, A4 |
| `html` | `<site>-audivra-report.html` | self-contained client report (opens offline) |
| `json` | `<site>-audivra-audit.json` | schema `audivra.audit.v1`: audit metadata, coverage, business understanding, page types, executive summary/snapshot, baseline stats, metric catalog, pages, findings (with issue keys), evidence metadata with file references, artifacts, technologies, opportunities, action plan, limitations, tool runs, AI run provenance (role, model, prompt version, turns, termination), comparison. No binary data. |
| `csv-findings` | `<site>-findings.csv` | one row per finding: ref, severity, category, title, type, confidence, verification, affected URLs, evidence, observed, why it matters, business impact, recommendation, effort, issue key (UTF-8 with BOM for Excel) |
| `csv-pages` | `<site>-pages.csv` | page inventory: URL, status, title, page type, lang, dir, depth, source, inspected in browser, finding count |
| `csv-performance` | `<site>-performance.csv` | Lighthouse and browser measurements per page/form factor |
| `csv-broken-links` | `<site>-broken-links.csv` | URL, status, error, kind, internal, found on, evidence — only when broken links exist |
| `bundle` | `<site>-audivra-audit.zip` | everything below |

```
<site>-audivra-audit/
├── README.md            what is where
├── report.pdf, report.html, audit.json
├── csv/                 findings, pages, performance, broken-links
├── screenshots/         every capture from the audit
├── artifacts/           A1-<type>.png (+ .svg where vector-friendly)
├── evidence/            evidence.json index + non-image evidence files
└── technical/
    ├── lighthouse/      raw Lighthouse JSON/HTML
    ├── zap/             ZAP baseline JSON/HTML (passive)
    ├── tls/             testssl.sh JSON
    ├── tool-reports/    axe, Pa11y, httpx, Katana, tool status
    └── baseline/        crawl, SEO, links, localization, link graph, digest
```

Only files that exist are included. Individual visuals: `GET /api/audits/:id/visuals/A3.png` (or `.svg`), `?download=1` for a download.
