import type { EvidenceGraph, EvidenceType, GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import {
  AppWindow,
  ArrowRight,
  BarChart3,
  Crosshair,
  FileText,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  Route,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EVIDENCE_TYPE, EvidenceTypeIcon, FindingTypeBadge, JOURNEY_TYPE_LABEL, SeverityBadge } from '@/components/badges'
import { EvidenceViewer } from '@/components/evidence-viewer'
import { Toolbar, ToolbarSpacer } from '@/components/page-header'
import { Panel, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { useAuditNav } from '@/features/audit/audit-nav'
import { RunStatus } from '@/features/audit/runs-tab'
import { formatDuration, pluralize } from '@/lib/format'
import { findingsQuery, graphQuery, journeysQuery, toolRunsQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const NODE_W = 216
const NODE_H = 60
/** Between distance layers (room for the connecting curves). */
const LAYER_GAP = 72
/** Between the wrapped sub-columns of one crowded layer. */
const WRAP_GAP = 16
const ROW_GAP = 12
const MAX_ROWS = 7
const PAD = 4
/** Below this the labels stop being readable; the canvas scrolls instead. */
const MIN_SCALE = 0.6
const DEFAULT_DEPTH = 2
const MAX_DEPTH = 3

const KIND: Record<GraphNodeKind, { label: string; icon: LucideIcon }> = {
  finding: { label: 'Finding', icon: TriangleAlert },
  evidence: { label: 'Evidence', icon: FileText },
  page: { label: 'Page', icon: AppWindow },
  journey: { label: 'Journey', icon: Route },
  tool: { label: 'Tool or AI run', icon: Wrench },
  artifact: { label: 'Visual', icon: BarChart3 },
}

/** How a relationship reads from each end. */
const RELATION: Record<GraphEdgeKind, { out: string; in: string }> = {
  'supported-by': { out: 'Supported by', in: 'Supports' },
  'captured-on': { out: 'Captured on', in: 'Captured here' },
  'produced-by': { out: 'Produced by', in: 'Produced' },
  affects: { out: 'Affects journey', in: 'Affected by' },
  'affects-page': { out: 'Affects page', in: 'Affected by' },
  visualizes: { out: 'Visualizes', in: 'Shown in' },
  'derived-from': { out: 'Derived from', in: 'Used in' },
  'step-evidence': { out: 'Steps backed by', in: 'Backs journey' },
}

const SEVERITY_BORDER: Record<string, string> = {
  critical: 'border-l-critical',
  high: 'border-l-high',
  medium: 'border-l-medium',
  low: 'border-l-low',
  info: 'border-l-info',
}

/** Evidence shows its type's icon; every other node its kind's. */
function NodeIcon({ node, className }: { node: GraphNode; className?: string }) {
  if (node.kind === 'evidence' && node.status && node.status in EVIDENCE_TYPE) {
    return <EvidenceTypeIcon type={node.status as EvidenceType} className={className} />
  }
  const Icon = KIND[node.kind].icon
  return <Icon className={cn('size-3.5 shrink-0 text-subtle', className)} aria-hidden />
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

interface Placed {
  node: GraphNode
  x: number
  y: number
}

interface Layout {
  placed: Map<string, Placed>
  width: number
  height: number
}

/**
 * Left-to-right layers by distance from the focus. Within a layer, nodes follow the average row of
 * the nodes they connect to in the previous layer (fewer crossings); crowded layers wrap into
 * sub-columns so the canvas stays roughly as tall as it is wide.
 */
export function layoutGraph(graph: EvidenceGraph): Layout {
  const layers = new Map<number, GraphNode[]>()
  for (const node of graph.nodes) layers.set(node.distance, [...(layers.get(node.distance) ?? []), node])
  const distance = new Map(graph.nodes.map((n) => [n.id, n.distance]))
  const neighbours = new Map<string, string[]>()
  for (const edge of graph.edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to])
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from])
  }
  const row = new Map<string, number>()
  const deepest = Math.max(0, ...layers.keys())
  for (let d = 0; d <= deepest; d++) {
    const layer = layers.get(d) ?? []
    if (d > 0) {
      const centre = new Map(
        layer.map((node) => {
          const rows = (neighbours.get(node.id) ?? []).filter((id) => distance.get(id) === d - 1).map((id) => row.get(id) ?? 0)
          return [node.id, rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER] as const
        }),
      )
      // Stable sort: ties keep the server's kind order.
      layer.sort((a, b) => centre.get(a.id)! - centre.get(b.id)!)
    }
    layer.forEach((node, i) => row.set(node.id, i))
  }

  const rowsUsed = Math.min(MAX_ROWS, Math.max(1, ...[...layers.values()].map((l) => l.length)))
  const height = PAD * 2 + rowsUsed * NODE_H + (rowsUsed - 1) * ROW_GAP
  const placed = new Map<string, Placed>()
  let x = PAD
  for (let d = 0; d <= deepest; d++) {
    const layer = layers.get(d) ?? []
    const columns = Math.max(1, Math.ceil(layer.length / MAX_ROWS))
    for (let c = 0; c < columns; c++) {
      const column = layer.slice(c * MAX_ROWS, (c + 1) * MAX_ROWS)
      const columnHeight = column.length * NODE_H + Math.max(0, column.length - 1) * ROW_GAP
      const top = PAD + (height - PAD * 2 - columnHeight) / 2
      column.forEach((node, i) => placed.set(node.id, { node, x: x + c * (NODE_W + WRAP_GAP), y: top + i * (NODE_H + ROW_GAP) }))
    }
    x += columns * NODE_W + (columns - 1) * WRAP_GAP + LAYER_GAP
  }
  return { placed, width: x - LAYER_GAP + PAD, height }
}

function edgePath(a: Placed, b: Placed): string {
  if (a.x === b.x) {
    // Same column: a short loop out to the right.
    const x = a.x + NODE_W
    const [y1, y2] = [a.y + NODE_H / 2, b.y + NODE_H / 2]
    return `M ${x} ${y1} C ${x + 36} ${y1}, ${x + 36} ${y2}, ${x} ${y2}`
  }
  const [left, right] = a.x < b.x ? [a, b] : [b, a]
  const [x1, y1, x2, y2] = [left.x + NODE_W, left.y + NODE_H / 2, right.x, right.y + NODE_H / 2]
  const bend = Math.min(LAYER_GAP, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

function NodeCard({ placed, focus, active, onSelect }: { placed: Placed; focus: boolean; active: boolean; onSelect: () => void }) {
  const { node } = placed
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={`${KIND[node.kind].label}: ${node.label}${focus ? ' (focus)' : ''}`}
      title={node.label}
      style={{ left: placed.x, top: placed.y, width: NODE_W, height: NODE_H }}
      className={cn(
        'absolute flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-left outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring',
        node.kind === 'finding' && node.severity && cn('border-l-2', SEVERITY_BORDER[node.severity]),
        focus && 'bg-surface-muted',
        active && 'border-ring ring-1 ring-ring',
      )}
    >
      <NodeIcon node={node} className={cn('mt-0.5', focus && 'text-foreground')} />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-xs leading-4 font-medium text-foreground" dir="auto">
          {node.label}
        </span>
        <span className="mt-0.5 block truncate text-2xs text-subtle">{node.sublabel ?? KIND[node.kind].label}</span>
      </span>
    </button>
  )
}

/** The selected node's relationships, grouped by how they read from this node. */
function Connections({ graph, node, onSelect }: { graph: EvidenceGraph; node: GraphNode; onSelect: (id: string) => void }) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const groups = new Map<string, GraphNode[]>()
  for (const edge of graph.edges) {
    if (edge.from !== node.id && edge.to !== node.id) continue
    const other = nodes.get(edge.from === node.id ? edge.to : edge.from)
    if (!other) continue
    const label = edge.from === node.id ? RELATION[edge.kind].out : RELATION[edge.kind].in
    groups.set(label, [...(groups.get(label) ?? []), other])
  }
  if (!groups.size) return null
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      {[...groups].map(([label, others]) => (
        <div key={label}>
          <SectionLabel>{label}</SectionLabel>
          <ul className="-mx-1.5 flex flex-col">
            {others.map((other) => {
              return (
                <li key={other.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(other.id)}
                    className="flex w-full cursor-pointer items-start gap-2 rounded-sm px-1.5 py-1 text-left text-sm hover:bg-surface-hover"
                  >
                    <NodeIcon node={other} className="mt-0.5" />
                    <span className="min-w-0 flex-1 truncate text-foreground" dir="auto">
                      {other.label}
                    </span>
                    {other.kind === 'page' || other.kind === 'tool' ? null : (
                      <span className="shrink-0 font-mono text-xs text-muted">{other.ref}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

function Summary({ auditId, node, actions }: { auditId: string; node: GraphNode; actions: ReactNode }) {
  const nav = useAuditNav()
  const findings = useQuery({ ...findingsQuery(auditId), enabled: node.kind === 'finding' })
  const journeys = useQuery({ ...journeysQuery(auditId), enabled: node.kind === 'journey' })
  const toolRuns = useQuery({ ...toolRunsQuery(auditId), enabled: node.kind === 'tool' })

  if (node.kind === 'evidence') {
    return (
      <>
        <EvidenceViewer key={node.ref} auditId={auditId} evidenceRef={node.ref} />
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </>
    )
  }
  if (node.kind === 'finding') {
    const finding = findings.data?.find((f) => f.ref === node.ref)
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {finding ? <SeverityBadge severity={finding.severity} /> : null}
          {finding ? <FindingTypeBadge type={finding.type} short /> : null}
          <span className="font-mono text-xs text-muted">{node.ref}</span>
        </div>
        <p className="text-sm font-medium text-foreground" dir="auto">
          {finding?.title ?? node.label}
        </p>
        {finding ? (
          <p className="line-clamp-6 text-sm text-muted" dir="auto">
            {finding.observed}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => nav?.openFinding(node.ref)}>
            Open finding
            <ArrowRight />
          </Button>
          {actions}
        </div>
      </>
    )
  }
  if (node.kind === 'journey') {
    const journey = journeys.data?.journeys.find((j) => j.ref === node.ref)
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{journey ? JOURNEY_TYPE_LABEL[journey.type] : 'Journey'}</Badge>
          {journey?.isPrimary ? <Badge tone="neutral">Primary</Badge> : null}
          <span className="font-mono text-xs text-muted">{node.ref}</span>
        </div>
        <p className="text-sm font-medium text-foreground" dir="auto">
          {node.label}
        </p>
        {journey ? (
          <p className="text-sm text-muted" dir="auto">
            {journey.goal}
          </p>
        ) : null}
        {journey ? (
          <p className="text-xs text-muted" dir="auto">
            {journey.steps.map((s) => s.label).join(' → ')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => nav?.openJourney(node.ref)}>
            Open journey
            <ArrowRight />
          </Button>
          {actions}
        </div>
      </>
    )
  }
  if (node.kind === 'tool') {
    const run = toolRuns.data?.find((t) => t.id === node.ref)
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {node.status ? <RunStatus status={node.status} /> : null}
          {run?.durationMs != null ? <span className="text-xs text-muted">{formatDuration(run.durationMs)}</span> : null}
        </div>
        <p className="text-sm font-medium text-foreground">{node.label}</p>
        <p className="text-sm text-muted">{run?.purpose ?? node.sublabel}</p>
        {run?.url ? <p className="font-mono text-xs break-all text-muted">{run.url}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => nav?.openTab('runs')}>
            Open runs
          </Button>
          {actions}
        </div>
      </>
    )
  }
  if (node.kind === 'page') {
    return (
      <>
        <p className="font-mono text-sm break-all text-foreground">{node.url ?? node.label}</p>
        {node.sublabel ? <p className="text-sm text-muted">{node.sublabel}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => node.url && nav?.showPageFindings(node.url)}>
            Findings on this page
          </Button>
          {actions}
        </div>
      </>
    )
  }
  return (
    <>
      <p className="text-sm font-medium text-foreground">{node.label}</p>
      {node.sublabel ? <p className="text-xs text-muted">{node.sublabel}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => nav?.openTab('visuals')}>
          Open visuals
        </Button>
        {actions}
      </div>
    </>
  )
}

/**
 * Why Audivra believes something: the stored relationships around one finding, evidence item,
 * journey or page. Nothing in the graph is inferred.
 */
export function EvidenceGraphView({
  auditId,
  focus,
  origin,
  onFocusChange,
  viewSwitch,
}: {
  auditId: string
  focus: string
  /** Where the graph was opened, once the user has re-centred it. */
  origin: string | null
  onFocusChange: (focus: string, origin: string | null) => void
  viewSwitch: ReactNode
}) {
  const [depth, setDepth] = useState(DEFAULT_DEPTH)
  const [selection, setSelection] = useState<{ focus: string; id: string } | null>(null)
  const [fit, setFit] = useState(true)
  const [width, setWidth] = useState(0)
  const frame = useRef<HTMLDivElement>(null)
  const graph = useQuery(graphQuery(auditId, focus, depth))
  const findings = useQuery(findingsQuery(auditId))
  const journeys = useQuery(journeysQuery(auditId))

  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const data = graph.data
  const placed = useMemo(() => (data ? layoutGraph(data) : null), [data])
  const selectedId = selection?.focus === focus ? selection.id : null
  const activeId = selectedId && placed?.placed.has(selectedId) ? selectedId : (data?.focus ?? null)
  const active = activeId ? placed?.placed.get(activeId)?.node : undefined
  const scale = placed && fit && width ? Math.max(MIN_SCALE, Math.min(1, width / placed.width)) : 1
  const touches = (edge: GraphEdge) => edge.from === activeId || edge.to === activeId

  const focusNode = data?.nodes.find((n) => n.id === data.focus)
  const options = [
    ...(findings.data ?? []).map((f) => ({ value: `finding:${f.ref}`, label: clip(`${f.ref} · ${f.title}`, 72) })),
    ...(journeys.data?.journeys ?? []).map((j) => ({ value: `journey:${j.ref}`, label: clip(`${j.ref} · ${j.name}`, 72) })),
  ]
  if (!options.some((o) => o.value === focus)) {
    options.unshift({ value: focus, label: focusNode ? clip(`${KIND[focusNode.kind].label} · ${focusNode.label}`, 72) : focus })
  }

  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <Select label="Focus" value={focus} onValueChange={(next) => onFocusChange(next, null)} options={options} className="w-full sm:w-auto sm:max-w-md" />
        <ToolbarSpacer />
        {data ? (
          <span className="text-xs text-muted tabular-nums">
            {pluralize(data.nodes.length, 'item')} · {pluralize(data.edges.length, 'link')}
          </span>
        ) : null}
        {viewSwitch}
      </Toolbar>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Evidence graph"
            description={
              data
                ? `Stored links only, up to ${data.depth} ${data.depth === 1 ? 'step' : 'steps'} from the focus${data.truncated ? ' · some items left out to stay readable' : ''}.`
                : 'Stored links only: what supports a finding, where it was captured and what produced it.'
            }
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!data?.expandable || depth >= MAX_DEPTH}
                  onClick={() => setDepth((d) => Math.min(MAX_DEPTH, d + 1))}
                  aria-label="Expand one more step"
                >
                  <Plus />
                  <span className="hidden sm:inline">Expand</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={depth === DEFAULT_DEPTH && !origin && !selectedId}
                  onClick={() => {
                    setDepth(DEFAULT_DEPTH)
                    setSelection(null)
                    if (origin) onFocusChange(origin, null)
                  }}
                  aria-label="Reset the graph"
                >
                  <RotateCcw />
                  <span className="hidden sm:inline">Reset</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setFit((f) => !f)} aria-pressed={fit} aria-label={fit ? 'Show at actual size' : 'Fit to view'}>
                  {fit ? <Maximize2 /> : <Minimize2 />}
                  <span className="hidden sm:inline">{fit ? 'Actual size' : 'Fit view'}</span>
                </Button>
              </>
            }
          />
          <div ref={frame} className="overflow-auto p-3">
            {graph.isError ? (
              <ErrorState title="Could not build the graph" error={graph.error} onRetry={() => void graph.refetch()} />
            ) : !placed || !data ? (
              <LoadingState rows={5} />
            ) : (
              <div
                style={{ width: placed.width * scale, height: placed.height * scale }}
                className={cn('relative mx-auto transition-opacity', graph.isPlaceholderData && 'opacity-60')}
                data-testid="evidence-graph-canvas"
              >
                <div
                  style={{ width: placed.width, height: placed.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
                  className="absolute top-0 left-0"
                >
                  <svg width={placed.width} height={placed.height} className="absolute inset-0 overflow-visible" aria-hidden>
                    {[...data.edges]
                      .sort((a, b) => Number(touches(a)) - Number(touches(b)))
                      .map((edge) => {
                        const a = placed.placed.get(edge.from)
                        const b = placed.placed.get(edge.to)
                        if (!a || !b) return null
                        return (
                          <path
                            key={edge.id}
                            d={edgePath(a, b)}
                            fill="none"
                            className={touches(edge) ? 'stroke-foreground' : 'stroke-border-strong'}
                            strokeWidth={touches(edge) ? 1.5 : 1}
                          />
                        )
                      })}
                  </svg>
                  {[...placed.placed.values()].map((p) => (
                    <NodeCard
                      key={p.node.id}
                      placed={p}
                      focus={p.node.id === data.focus}
                      active={p.node.id === activeId}
                      onSelect={() => setSelection({ focus, id: p.node.id })}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </Panel>
        <Panel className="self-start xl:sticky xl:top-4">
          <PanelHeader
            title={active ? KIND[active.kind].label : 'Details'}
            description={active ? (active.distance === 0 ? 'Graph focus' : `${active.distance} ${active.distance === 1 ? 'step' : 'steps'} from the focus`) : undefined}
          />
          <div className="flex flex-col gap-4 p-4 xl:max-h-[calc(100dvh-8rem)] xl:overflow-y-auto">
            {active && data ? (
              <>
                <div className="flex flex-col gap-3">
                  <Summary
                    auditId={auditId}
                    node={active}
                    actions={
                      active.id === data.focus ? null : (
                        <Button size="sm" variant="ghost" onClick={() => onFocusChange(active.id, origin ?? focus)}>
                          <Crosshair />
                          Center graph here
                        </Button>
                      )
                    }
                  />
                </div>
                <Connections graph={data} node={active} onSelect={(id) => setSelection({ focus, id })} />
              </>
            ) : (
              <EmptyState compact title="Select an item to inspect it" />
            )}
          </div>
        </Panel>
      </div>
    </div>
  )
}

/** What to centre the graph on when nothing is chosen: the selected evidence, else the top finding. */
export function defaultGraphFocus(options: { evidenceRef?: string | null; findingRefs: string[]; evidenceRefs: string[] }): string | null {
  if (options.evidenceRef) return `evidence:${options.evidenceRef}`
  if (options.findingRefs[0]) return `finding:${options.findingRefs[0]}`
  if (options.evidenceRefs[0]) return `evidence:${options.evidenceRefs[0]}`
  return null
}
