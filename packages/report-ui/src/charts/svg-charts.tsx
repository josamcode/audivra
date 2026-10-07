/** @jsxRuntime automatic @jsxImportSource react */
import type { Datum, HistoryPoint, Severity, ValueUnit } from '@audivra/contracts'
import { Graph, layout } from '@dagrejs/dagre'
import { formatShortDate, formatValue, truncateToWidth } from '../format.ts'
import { segmentColor, type ChartPalette } from '../theme.ts'

/* Deterministic SVG charts: no DOM measurement, so they render identically in SSR, the app and PDF. */

export function Donut({
  items,
  unit,
  palette,
  size = 168,
}: {
  items: Datum[]
  unit: ValueUnit
  palette: ChartPalette
  size?: number
}) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  const radius = 54
  const stroke = 18
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <svg
      viewBox="0 0 160 160"
      width={size}
      height={size}
      role="img"
      aria-label={items.map((i) => `${i.label}: ${formatValue(i.value, i.unit ?? unit)}`).join(', ')}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="80" cy="80" r={radius} fill="none" style={{ stroke: palette.bgMuted }} strokeWidth={stroke} />
      {total > 0
        ? items.map((item, index) => {
            const length = (Math.max(0, item.value) / total) * circumference
            const dash = `${Math.max(0, length - 1.5)} ${circumference}`
            const element = (
              <circle
                key={`${item.label}-${index}`}
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                strokeWidth={stroke}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                transform="rotate(-90 80 80)"
                style={{ stroke: segmentColor(palette, item.label, index) }}
              />
            )
            offset += length
            return element
          })
        : null}
      <text
        x="80"
        y="78"
        textAnchor="middle"
        style={{ fill: palette.fg, fontFamily: palette.fontMono, fontSize: 18, fontWeight: 600 }}
      >
        {formatValue(total, unit)}
      </text>
      <text x="80" y="96" textAnchor="middle" style={{ fill: palette.muted, fontFamily: palette.fontSans, fontSize: 10 }}>
        total
      </text>
    </svg>
  )
}

function niceTicks(min: number, max: number, count = 4, options: { integer?: boolean; floor?: number } = {}): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1
    min -= pad
    max += pad
  }
  // Counts and scores never go below zero, and counts never get fractional ticks.
  if (options.floor !== undefined) min = Math.max(options.floor, min)
  const span = max - min
  const step0 = span / count
  const magnitude = 10 ** Math.floor(Math.log10(step0))
  const residual = step0 / magnitude
  let step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude
  if (options.integer) step = Math.max(1, Math.round(step))
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)))
  return ticks
}

function utcTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

export interface LineSeries {
  label: string
  points: HistoryPoint[]
}

/**
 * Line chart over audit snapshots. X positions are the actual audit dates in order (categorical,
 * evenly spaced); only real points are drawn — nothing is interpolated or extrapolated.
 */
export function LineChart({
  series,
  unit,
  palette,
  lowerIsBetter,
  width = 640,
  height = 220,
  compact = false,
}: {
  series: LineSeries[]
  unit: ValueUnit
  palette: ChartPalette
  lowerIsBetter?: boolean
  width?: number
  height?: number
  compact?: boolean
}) {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort()
  const values = series.flatMap((s) => s.points.map((p) => p.value))
  const zeroBased = unit === 'count' || unit === 'score' || unit === 'percent'
  const minValue = Math.min(...values, zeroBased ? 0 : Infinity)
  const maxValue = Math.max(...values)
  const ticks = compact
    ? [Math.min(...values), maxValue]
    : niceTicks(minValue, maxValue, 4, { integer: unit === 'count', floor: zeroBased ? 0 : undefined })
  const domainMin = Math.min(ticks[0] ?? 0, minValue)
  const domainMax = Math.max(ticks[ticks.length - 1] ?? 1, maxValue)
  const margin = compact ? { top: 10, right: 10, bottom: 10, left: 10 } : { top: 26, right: 18, bottom: 32, left: 60 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom
  // Inner inset keeps the first/last points (and their labels) clear of the axis labels.
  const inset = compact ? 6 : 36
  const x = (date: string) =>
    margin.left + inset + (dates.length <= 1 ? (plotW - 2 * inset) / 2 : (dates.indexOf(date) / (dates.length - 1)) * (plotW - 2 * inset))
  const y = (value: number) =>
    margin.top + (domainMax === domainMin ? plotH / 2 : (1 - (value - domainMin) / (domainMax - domainMin)) * plotH)
  const text = { fontFamily: palette.fontSans, fontSize: 11 }
  // Several audits on one day are told apart by time; long histories thin their labels (anchored on
  // the latest audit) instead of overlapping them.
  const sameDay = new Set(dates.map((d) => d.slice(0, 10))).size < dates.length
  const dateLabel = (date: string) => (sameDay ? `${formatShortDate(date)} ${utcTime(date)} UTC` : formatShortDate(date))
  const maxLabels = Math.max(2, Math.floor((plotW - 2 * inset) / (sameDay ? 108 : 54)) + 1)
  const labelStep = Math.max(1, Math.ceil(dates.length / maxLabels))
  const showDate = (index: number) => (dates.length - 1 - index) % labelStep === 0
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={series
        .map((s) => `${s.label}: ${s.points.map((p) => `${formatShortDate(p.x)} ${formatValue(p.value, unit)}`).join(', ')}`)
        .join('; ')}
      xmlns="http://www.w3.org/2000/svg"
      className="av-svg"
    >
      {compact
        ? null
        : ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={y(tick)}
                y2={y(tick)}
                style={{ stroke: palette.border }}
                strokeWidth={1}
              />
              <text x={margin.left - 8} y={y(tick) + 4} textAnchor="end" style={{ ...text, fill: palette.subtle }}>
                {formatValue(tick, unit)}
              </text>
            </g>
          ))}
      {compact
        ? null
        : dates.map((date, index) =>
            showDate(index) ? (
              <text
                key={date}
                x={x(date)}
                y={height - 10}
                textAnchor="middle"
                style={{ ...text, fill: palette.muted }}
              >
                {dateLabel(date)}
              </text>
            ) : null,
          )}
      {series.map((s, index) => {
        const color = palette.series[index % palette.series.length] ?? palette.accent
        const sorted = [...s.points].sort((a, b) => a.x.localeCompare(b.x))
        const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
        return (
          <g key={s.label}>
            <path d={path} fill="none" style={{ stroke: color }} strokeWidth={compact ? 1.75 : 2} strokeLinejoin="round" />
            {sorted.map((p, i) => (
              <g key={`${p.auditId}-${p.x}`}>
                <circle cx={x(p.x)} cy={y(p.value)} r={compact ? 2.5 : 3.5} style={{ fill: palette.bg, stroke: color }} strokeWidth={2} />
                {compact || (sorted.length > 8 && i !== 0 && i !== sorted.length - 1) ? null : (
                  <text
                    x={x(p.x)}
                    y={y(p.value) - 9}
                    textAnchor="middle"
                    style={{ ...text, fill: palette.fg, fontFamily: palette.fontMono, fontSize: 10.5 }}
                  >
                    {formatValue(p.value, unit)}
                  </text>
                )}
              </g>
            ))}
          </g>
        )
      })}
      {lowerIsBetter && !compact ? (
        <text x={width - margin.right} y={12} textAnchor="end" style={{ ...text, fill: palette.subtle, fontSize: 10 }}>
          Lower is better
        </text>
      ) : null}
    </svg>
  )
}

export interface GraphNodeInput {
  id: string
  label: string
  depth: number
  kind: 'page' | 'group'
  pageCount?: number
  findings: number
  maxSeverity: Severity | null
}

const NODE_W = 176
const NODE_H = 30

/** Layered (left → right) site graph laid out with dagre; nodes tinted by their most severe finding. */
export function SiteGraphSvg({
  nodes,
  edges,
  palette,
}: {
  nodes: GraphNodeInput[]
  edges: { from: string; to: string }[]
  palette: ChartPalette
}) {
  const graph = new Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 8, ranksep: 44, marginx: 8, marginy: 8 })
  graph.setDefaultEdgeLabel(() => ({}))
  const ids = new Set(nodes.map((n) => n.id))
  for (const node of nodes) graph.setNode(node.id, { width: NODE_W, height: NODE_H })
  for (const edge of edges) {
    if (ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to) graph.setEdge(edge.from, edge.to)
  }
  layout(graph)
  const meta = graph.graph() as { width?: number; height?: number }
  const width = Math.max(NODE_W + 16, Math.ceil(meta.width ?? NODE_W))
  const height = Math.max(NODE_H + 16, Math.ceil(meta.height ?? NODE_H))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const text = { fontFamily: palette.fontSans, fontSize: 11 }
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width }}
      role="img"
      aria-label={`Site structure with ${nodes.length} nodes`}
      xmlns="http://www.w3.org/2000/svg"
      className="av-svg av-graph-svg"
    >
      {graph.edges().map((edge) => {
        const points = (graph.edge(edge) as { points?: { x: number; y: number }[] }).points ?? []
        if (points.length < 2) return null
        const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
        return <path key={`${edge.v}-${edge.w}`} d={d} fill="none" style={{ stroke: palette.borderStrong }} strokeWidth={1} />
      })}
      {nodes.map((node) => {
        const position = graph.node(node.id) as { x?: number; y?: number } | undefined
        if (position?.x == null || position.y == null) return null
        const x = position.x - NODE_W / 2
        const y = position.y - NODE_H / 2
        const severity = node.maxSeverity
        const fill = severity && node.findings > 0 ? palette.severitySoft[severity] : palette.bg
        const stroke = severity && node.findings > 0 ? palette.severity[severity] : palette.borderStrong
        const label = node.kind === 'group' && node.pageCount ? `${node.label} · ${node.pageCount} pages` : node.label
        const badge = node.findings > 0 ? String(node.findings) : ''
        const labelWidth = NODE_W - 16 - (badge ? 22 : 0)
        return (
          <g key={node.id}>
            <title>{`${byId.get(node.id)?.label ?? node.id}${node.findings ? ` — ${node.findings} finding(s)` : ''}`}</title>
            <rect
              x={x}
              y={y}
              width={NODE_W}
              height={NODE_H}
              rx={5}
              style={{ fill, stroke }}
              strokeWidth={1}
              strokeDasharray={node.kind === 'group' ? '3 2' : undefined}
            />
            <text x={x + 8} y={y + NODE_H / 2 + 4} style={{ ...text, fill: palette.fg }}>
              {truncateToWidth(label, labelWidth, 11)}
            </text>
            {badge ? (
              <g>
                <rect
                  x={x + NODE_W - 24}
                  y={y + 7}
                  width={17}
                  height={16}
                  rx={3}
                  style={{ fill: severity ? palette.severity[severity] : palette.muted }}
                />
                <text
                  x={x + NODE_W - 15.5}
                  y={y + 18.5}
                  textAnchor="middle"
                  style={{ ...text, fontFamily: palette.fontMono, fontSize: 10, fontWeight: 600, fill: palette.bg }}
                >
                  {badge}
                </text>
              </g>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}
