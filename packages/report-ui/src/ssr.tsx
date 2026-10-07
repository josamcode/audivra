/** @jsxRuntime automatic @jsxImportSource react */
/**
 * Server-side rendering entry (Node only). Produces self-contained documents: inline CSS, fonts as
 * data: URIs (Inter, JetBrains Mono, Noto Sans Arabic — all OFL), no scripts, no external requests.
 *
 *   renderClientReportHtml(report, { resolveAsset, mode: 'html' | 'pdf' }): string
 *   renderArtifactHtml(artifact, { resolveAsset, width? }): string   // #artifact-root for PNG capture
 *   renderArtifactSvg(artifact): string | null                        // vector-friendly types only
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Artifact, ClientReport } from '@audivra/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArtifactView, SVG_EXPORTABLE_TYPES } from './artifact-view.tsx'
import { Donut, LineChart, SiteGraphSvg } from './charts/svg-charts.tsx'
import { ClientReportDocument } from './report/document.tsx'
import { barsSvg, escapeXml, heatmapSvg, stackedSvg } from './svg-export.ts'
import { EXPORT_PALETTE } from './theme.ts'
import type { AssetResolver } from './types.ts'

export type { AssetResolver } from './types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
const ARABIC_RANGE =
  'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC'

const FONTS: { family: string; pkg: string; file: string; range: string; weights: string }[] = [
  { family: 'Inter Variable', pkg: '@fontsource-variable/inter', file: 'inter-latin-wght-normal.woff2', range: LATIN_RANGE, weights: '100 900' },
  { family: 'Inter Variable', pkg: '@fontsource-variable/inter', file: 'inter-latin-ext-wght-normal.woff2', range: LATIN_EXT_RANGE, weights: '100 900' },
  {
    family: 'JetBrains Mono Variable',
    pkg: '@fontsource-variable/jetbrains-mono',
    file: 'jetbrains-mono-latin-wght-normal.woff2',
    range: LATIN_RANGE,
    weights: '100 800',
  },
  {
    family: 'Noto Sans Arabic Variable',
    pkg: '@fontsource-variable/noto-sans-arabic',
    file: 'noto-sans-arabic-arabic-wght-normal.woff2',
    range: ARABIC_RANGE,
    weights: '100 900',
  },
]

function packageDir(name: string): string {
  return path.dirname(require.resolve(`${name}/package.json`))
}

let cachedFontCss: string | undefined
let cachedStyles: string | undefined

/** @font-face rules with embedded woff2 data. Cached: fonts never change at runtime. */
export function embeddedFontCss(): string {
  if (cachedFontCss !== undefined) return cachedFontCss
  const rules: string[] = []
  for (const font of FONTS) {
    try {
      const data = readFileSync(path.join(packageDir(font.pkg), 'files', font.file)).toString('base64')
      rules.push(
        `@font-face{font-family:'${font.family}';font-style:normal;font-display:block;font-weight:${font.weights};` +
          `src:url(data:font/woff2;base64,${data}) format('woff2-variations');unicode-range:${font.range};}`,
      )
    } catch {
      // A missing font file falls back to system fonts; never fail the export.
    }
  }
  cachedFontCss = rules.join('\n')
  return cachedFontCss
}

function styles(): string {
  if (cachedStyles !== undefined) return cachedStyles
  const artifactsCss = readFileSync(path.join(here, 'styles', 'artifacts.css'), 'utf8')
  const reportCss = readFileSync(path.join(here, 'styles', 'report.css'), 'utf8')
  cachedStyles = `${artifactsCss}\n${reportCss}`
  return cachedStyles
}

const PDF_PAGE_CSS = `
@page { size: A4; margin: 16mm 15mm 18mm 15mm; }
@page {
  @bottom-left { content: "Audivra"; font: 500 8.5px 'Inter Variable', system-ui, sans-serif; color: #868b94; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 500 8.5px 'Inter Variable', system-ui, sans-serif; color: #868b94; }
}
html, body { background: #ffffff; }
.rp-body .rp-document { margin: 0; border: 0; border-radius: 0; max-width: none; padding: 0; }
`

function documentShell(title: string, body: string, extraCss = '', bodyClass = 'rp-body'): string {
  return (
    '<!doctype html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    `<meta name="generator" content="Audivra"><title>${escapeXml(title)}</title>` +
    `<style>${embeddedFontCss()}\n${styles()}\n${extraCss}</style>` +
    `</head><body class="${bodyClass}">${body}</body></html>`
  )
}

export function renderClientReportHtml(
  report: ClientReport,
  options: { resolveAsset: AssetResolver; mode: 'html' | 'pdf' },
): string {
  const markup = renderToStaticMarkup(
    <ClientReportDocument report={report} resolveAsset={options.resolveAsset} interactive={options.mode === 'html'} />,
  )
  const title = `${report.title || `Website audit — ${report.site.domain}`}`
  return documentShell(title, markup, options.mode === 'pdf' ? PDF_PAGE_CSS : '', `rp-body rp-mode-${options.mode}`)
}

export function renderArtifactHtml(
  artifact: Artifact,
  options: { resolveAsset: AssetResolver; width?: number },
): string {
  const width = options.width ?? 960
  const markup = renderToStaticMarkup(
    <div id="artifact-root" className="rp-standalone" style={{ width }}>
      <ArtifactView artifact={artifact} resolveAsset={options.resolveAsset} mode="report" />
    </div>,
  )
  return documentShell(artifact.title, markup, 'html,body{margin:0;background:#ffffff;}', 'rp-artifact-body')
}

function wrapSvg(inner: string, artifact: Artifact): string {
  // Ensure a namespace and a title on React-rendered SVG roots.
  const titled = inner.replace(/^<svg([^>]*)>/, (_m, attrs: string) => {
    const withNs = attrs.includes('xmlns=') ? attrs : `${attrs} xmlns="http://www.w3.org/2000/svg"`
    return `<svg${withNs}><title>${escapeXml(artifact.title)}</title>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n${titled}`
}

/** Standalone SVG with concrete colors for chart-like artifacts; null when the type isn't vector-friendly. */
export function renderArtifactSvg(artifact: Artifact): string | null {
  if (!SVG_EXPORTABLE_TYPES.has(artifact.type)) return null
  const palette = EXPORT_PALETTE
  switch (artifact.type) {
    case 'bar_chart':
    case 'comparison_bar':
      return `<?xml version="1.0" encoding="UTF-8"?>\n${barsSvg(artifact.title, artifact.data.items, artifact.data.unit, palette, artifact.data.lowerIsBetter)}`
    case 'stacked_bar':
      return `<?xml version="1.0" encoding="UTF-8"?>\n${stackedSvg(artifact.title, artifact.data.segments, artifact.data.rows, palette)}`
    case 'heatmap':
      return `<?xml version="1.0" encoding="UTF-8"?>\n${heatmapSvg(artifact.title, artifact.data.columns, artifact.data.rows, artifact.data.unit, palette)}`
    case 'donut':
      return wrapSvg(renderToStaticMarkup(<Donut items={artifact.data.items} unit={artifact.data.unit} palette={palette} size={320} />), artifact)
    case 'line_chart':
      return wrapSvg(
        renderToStaticMarkup(
          <LineChart series={artifact.data.series} unit={artifact.data.unit} palette={palette} lowerIsBetter={artifact.data.lowerIsBetter} />,
        ),
        artifact,
      )
    case 'trend_metric':
      return wrapSvg(
        renderToStaticMarkup(
          <LineChart
            series={[{ label: artifact.data.label, points: artifact.data.points }]}
            unit={artifact.data.unit}
            palette={palette}
            lowerIsBetter={artifact.data.lowerIsBetter}
          />,
        ),
        artifact,
      )
    case 'site_graph':
      return wrapSvg(renderToStaticMarkup(<SiteGraphSvg nodes={artifact.data.nodes} edges={artifact.data.edges} palette={palette} />), artifact)
    default:
      return null
  }
}
