/** @jsxRuntime automatic @jsxImportSource react */
import type { Artifact, ArtifactDataMap, ArtifactType } from '@audivra/contracts'
import { clsx } from 'clsx'
import { BarList, ColumnChart, HeatmapTable, StackedBars } from './charts/bars.tsx'
import { Donut, LineChart, SiteGraphSvg } from './charts/svg-charts.tsx'
import { ArtifactFrame } from './components/frame.tsx'
import { SeverityPill, SrTable } from './components/primitives.tsx'
import { formatDate, formatDelta, formatValue } from './format.ts'
import { ComparisonTableView, MatrixView, PagePerformanceView, TrackingCoverageView } from './artifacts/tables.tsx'
import { FunnelView, JourneyView, TimelineView } from './artifacts/flows.tsx'
import { AnnotatedScreenshotView, BeforeAfterView, EvidenceGalleryView } from './artifacts/media.tsx'
import { MetricGroupView, MetricView } from './artifacts/metrics.tsx'
import { ImpactEffortView, TechMapView } from './artifacts/misc.tsx'
import { CSS_PALETTE, segmentColor } from './theme.ts'
import type { ArtifactViewProps, RenderContext } from './types.ts'

export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  metric: 'Metric',
  metric_group: 'Metrics',
  comparison_bar: 'Comparison',
  comparison_table: 'Comparison table',
  bar_chart: 'Bar chart',
  stacked_bar: 'Stacked bars',
  donut: 'Distribution',
  line_chart: 'Trend',
  trend_metric: 'Trend',
  matrix: 'Matrix',
  heatmap: 'Heatmap',
  tracking_coverage: 'Tracking coverage',
  page_performance: 'Page performance',
  journey: 'Journey',
  funnel: 'Conversion steps',
  site_graph: 'Site structure',
  timeline: 'Timeline',
  evidence_gallery: 'Evidence gallery',
  annotated_screenshot: 'Annotated screenshot',
  before_after: 'Before / after',
  tech_map: 'Technology map',
  impact_effort: 'Impact / effort',
}

/** Types that also export as standalone SVG (vector-friendly). */
export const SVG_EXPORTABLE_TYPES: ReadonlySet<ArtifactType> = new Set([
  'bar_chart',
  'comparison_bar',
  'stacked_bar',
  'donut',
  'line_chart',
  'trend_metric',
  'heatmap',
  'site_graph',
])

function DonutView({ data }: { data: ArtifactDataMap['donut'] }) {
  const total = data.items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  return (
    <div className="av-donut">
      <Donut items={data.items} unit={data.unit} palette={CSS_PALETTE} />
      <ul className="av-legend av-legend-col">
        {data.items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <span className="av-swatch" style={{ background: segmentColor(CSS_PALETTE, item.label, index) }} aria-hidden />
            <span className="av-legend-label" dir="auto">
              {item.label}
            </span>
            <span className="av-num av-legend-value">{formatValue(item.value, item.unit ?? data.unit)}</span>
            <span className="av-num av-muted-text">{total > 0 ? `${Math.round((Math.max(0, item.value) / total) * 100)}%` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function LineChartView({ data }: { data: ArtifactDataMap['line_chart'] }) {
  return (
    <div className="av-line">
      {data.series.length > 1 ? (
        <ul className="av-legend">
          {data.series.map((series, index) => (
            <li key={series.label}>
              <span className="av-swatch av-swatch-line" style={{ background: CSS_PALETTE.series[index] }} aria-hidden />
              {series.label}
            </li>
          ))}
        </ul>
      ) : null}
      <LineChart series={data.series} unit={data.unit} palette={CSS_PALETTE} lowerIsBetter={data.lowerIsBetter} />
      <SrTable
        caption="Values per audit"
        head={['Series', 'Audit date', 'Value']}
        rows={data.series.flatMap((s) => s.points.map((p) => [s.label, formatDate(p.x), formatValue(p.value, data.unit)]))}
      />
    </div>
  )
}

function TrendMetricView({ data }: { data: ArtifactDataMap['trend_metric'] }) {
  const points = [...data.points].sort((a, b) => a.x.localeCompare(b.x))
  const last = points[points.length - 1]
  const previous = points[points.length - 2]
  const delta = last && previous ? last.value - previous.value : null
  const improved = delta == null || delta === 0 ? null : data.lowerIsBetter ? delta < 0 : delta > 0
  return (
    <div className="av-trend">
      <div className="av-trend-head">
        <div>
          <div className="av-stat-label" dir="auto">
            {data.label}
          </div>
          <div className="av-trend-value av-num">{last ? formatValue(last.value, data.unit) : '–'}</div>
        </div>
        {delta != null ? (
          <div className={clsx('av-trend-delta av-num', improved == null ? 'av-tone-neutral' : improved ? 'av-tone-good' : 'av-tone-bad')}>
            {formatDelta(delta, data.unit)}
            <span className="av-trend-since">since {formatDate(previous?.x)}</span>
          </div>
        ) : null}
      </div>
      <LineChart series={[{ label: data.label, points }]} unit={data.unit} palette={CSS_PALETTE} lowerIsBetter={data.lowerIsBetter} height={180} />
      <p className="av-axis-note">
        {points.length} audits · {formatDate(points[0]?.x)} → {formatDate(last?.x)}
      </p>
    </div>
  )
}

function SiteGraphView({ data }: { data: ArtifactDataMap['site_graph'] }) {
  const severities = [...new Set(data.nodes.map((n) => (n.findings > 0 ? n.maxSeverity : null)).filter(Boolean))]
  return (
    <div className="av-graph">
      <div className="av-graph-scroll">
        <SiteGraphSvg nodes={data.nodes} edges={data.edges} palette={CSS_PALETTE} />
      </div>
      <div className="av-graph-foot">
        <span className="av-muted-text">
          {data.nodes.length} nodes · {data.totalPages} pages{data.truncated ? ' · aggregated by section' : ''}
        </span>
        {severities.length ? (
          <span className="av-graph-legend">
            Most severe finding:{' '}
            {severities.map((severity) => (severity ? <SeverityPill key={severity} severity={severity} /> : null))}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function BarChartView({ data }: { data: ArtifactDataMap['bar_chart'] }) {
  return data.orientation === 'vertical' ? (
    <ColumnChart items={data.items} unit={data.unit} lowerIsBetter={data.lowerIsBetter} />
  ) : (
    <BarList items={data.items} unit={data.unit} lowerIsBetter={data.lowerIsBetter} />
  )
}

function renderBody(artifact: Artifact, ctx: RenderContext) {
  switch (artifact.type) {
    case 'metric':
      return <MetricView data={artifact.data} />
    case 'metric_group':
      return <MetricGroupView data={artifact.data} />
    case 'comparison_bar':
      return <BarList items={artifact.data.items} unit={artifact.data.unit} lowerIsBetter={artifact.data.lowerIsBetter} />
    case 'comparison_table':
      return <ComparisonTableView data={artifact.data} />
    case 'bar_chart':
      return <BarChartView data={artifact.data} />
    case 'stacked_bar':
      return <StackedBars segments={artifact.data.segments} rows={artifact.data.rows} />
    case 'donut':
      return <DonutView data={artifact.data} />
    case 'line_chart':
      return <LineChartView data={artifact.data} />
    case 'trend_metric':
      return <TrendMetricView data={artifact.data} />
    case 'matrix':
      return <MatrixView data={artifact.data} ctx={ctx} />
    case 'heatmap':
      return <HeatmapTable columns={artifact.data.columns} rows={artifact.data.rows} unit={artifact.data.unit} />
    case 'tracking_coverage':
      return <TrackingCoverageView data={artifact.data} ctx={ctx} />
    case 'page_performance':
      return <PagePerformanceView data={artifact.data} />
    case 'journey':
      return <JourneyView data={artifact.data} ctx={ctx} />
    case 'funnel':
      return <FunnelView data={artifact.data} ctx={ctx} />
    case 'site_graph':
      return <SiteGraphView data={artifact.data} />
    case 'timeline':
      return <TimelineView data={artifact.data} />
    case 'evidence_gallery':
      return <EvidenceGalleryView data={artifact.data} ctx={ctx} />
    case 'annotated_screenshot':
      return <AnnotatedScreenshotView data={artifact.data} ctx={ctx} />
    case 'before_after':
      return <BeforeAfterView data={artifact.data} ctx={ctx} />
    case 'tech_map':
      return <TechMapView data={artifact.data} ctx={ctx} />
    case 'impact_effort':
      return <ImpactEffortView data={artifact.data} ctx={ctx} />
    default:
      return null
  }
}

/** Renders any validated artifact with the shared frame, typography and semantic colors. */
export function ArtifactView({
  artifact,
  resolveAsset,
  mode = 'app',
  onEvidenceClick,
  onFindingClick,
  bare,
  actions,
  className,
}: ArtifactViewProps) {
  const ctx: RenderContext = { mode, resolveAsset, onEvidenceClick, onFindingClick }
  return (
    <ArtifactFrame
      artifact={artifact}
      ctx={ctx}
      bare={bare}
      actions={actions}
      className={clsx(mode === 'report' ? 'av-mode-report' : 'av-mode-app', className)}
    >
      {renderBody(artifact, ctx)}
    </ArtifactFrame>
  )
}
