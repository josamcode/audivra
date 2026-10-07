/**
 * @audivra/report-ui — trusted renderers for visual artifacts and the client report.
 *
 *   type AssetResolver = (workspacePath: string, auditId?: string) => string
 *   <ArtifactView artifact resolveAsset mode? onEvidenceClick? onFindingClick? bare? />
 *   <ClientReportDocument report resolveAsset interactive? />
 *   ARTIFACT_TYPE_LABELS, SVG_EXPORTABLE_TYPES
 *
 * Styles: import "@audivra/report-ui/styles/artifacts.css" (components, --av-* variables) and
 * "@audivra/report-ui/styles/report.css" (client report theme + print rules).
 * Server-only rendering (HTML/PDF/PNG/SVG exports) lives in "@audivra/report-ui/ssr".
 */
export { ArtifactView, ARTIFACT_TYPE_LABELS, SVG_EXPORTABLE_TYPES } from './artifact-view.tsx'
export { ClientReportDocument, type ClientReportDocumentProps } from './report/document.tsx'
export { StatTile } from './artifacts/metrics.tsx'
export { SeverityPill, CellMark } from './components/primitives.tsx'
export { LineChart } from './charts/svg-charts.tsx'
export { CSS_PALETTE, EXPORT_PALETTE, type ChartPalette } from './theme.ts'
export {
  formatValue,
  formatDatum,
  formatDelta,
  formatDate,
  formatShortDate,
  thresholdTone,
  shortUrl,
  METRIC_THRESHOLDS,
  type Tone,
} from './format.ts'
export type { ArtifactViewProps, AssetResolver, RenderMode } from './types.ts'
