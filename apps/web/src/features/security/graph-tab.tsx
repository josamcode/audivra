import {
  FACT_STATUSES,
  GRAPH_ENTITY_KINDS,
  KNOWLEDGE_BASES,
  type FactStatus,
  type GraphEntityKind,
  type GraphNeighbor,
  type KnowledgeBasis,
  type KnowledgeGap,
  type SecurityEngagementDetail,
  type SecurityGraphNode,
  type SecurityGraphProvenance,
} from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { ArrowLeft, ArrowRight, CircleHelp, Loader2, RefreshCw, Share2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { BasisBadge, ENTITY_KIND_LABEL, FactStatusBadge, GAP_KIND_LABEL } from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Metric } from '@/components/metric'
import { DefinitionList, Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState, Notice } from '@/components/states'
import { Button } from '@/components/ui/button'
import { tagVariants } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  graphGapsQuery,
  graphNodeQuery,
  graphNodesQuery,
  graphSummaryQuery,
  isActiveRun,
  queryKeys,
  reasoningRunsQuery,
} from '@/lib/queries'
import { cn } from '@/lib/utils'

/*
 * The Security Graph: what Audivra knows about the application, why it believes it, how confident it is,
 * and what it does not know yet. Entities and their relationships are a table plus an entity rail (a
 * navigable neighbourhood), not a force-directed picture. Observed, derived and AI-inferred facts are
 * always labelled differently; stale, superseded and contradicted facts are kept and shown as such.
 */

const column = createColumnHelper<SecurityGraphNode>()
const columns = [
  column.accessor('kind', {
    header: 'Kind',
    cell: ({ getValue }) => (
      <span className="whitespace-nowrap text-muted">{ENTITY_KIND_LABEL[getValue()]}</span>
    ),
    meta: { className: 'w-1' },
  }),
  column.accessor('label', {
    header: 'Entity',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div
          className={cn(
            'truncate font-medium text-foreground',
            row.original.kind === 'endpoint' || row.original.kind === 'host'
              ? 'font-mono text-xs'
              : undefined,
          )}
        >
          {row.original.label}
        </div>
        <div className="truncate font-mono text-2xs text-subtle">{entitySubtitle(row.original)}</div>
      </div>
    ),
    meta: { className: 'w-full max-w-0' },
  }),
  column.accessor('basis', {
    header: 'Basis',
    cell: ({ getValue }) => <BasisBadge basis={getValue()} />,
    meta: { className: 'w-1' },
  }),
  column.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => <FactStatusBadge status={getValue()} />,
    meta: { className: 'hidden w-1 md:table-cell' },
  }),
  column.accessor('confidence', {
    header: 'Confidence',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs tabular-nums text-muted">{getValue().toFixed(2)}</span>
    ),
    meta: { className: 'hidden w-1 lg:table-cell', align: 'right' },
  }),
  column.accessor((row) => row.tools.join(', '), {
    id: 'tools',
    header: 'Sensors',
    cell: ({ getValue }) => (
      <span className="font-mono text-2xs whitespace-nowrap text-muted">{getValue() || '—'}</span>
    ),
    meta: { className: 'hidden w-1 lg:table-cell' },
  }),
  column.accessor('lastObservedAt', {
    header: 'Last seen',
    cell: ({ getValue }) => (
      <span className="text-xs whitespace-nowrap text-muted" title={formatDateTime(getValue())}>
        {formatRelative(getValue())}
      </span>
    ),
    meta: { className: 'w-1' },
  }),
]

function entitySubtitle(node: SecurityGraphNode): string {
  const a = node.attributes
  if (node.kind === 'endpoint')
    return [
      typeof a.status === 'number' ? `HTTP ${a.status}` : 'not inspected',
      Array.isArray(a.methods) ? a.methods.join(' ') : null,
      node.scopeClass,
    ]
      .filter(Boolean)
      .join(' · ')
  if (node.kind === 'technology')
    return Array.isArray(a.versions) && a.versions.length
      ? `versions ${a.versions.join(', ')}`
      : 'version unknown'
  if (node.kind === 'api-operation') return String(a.concreteUrl ?? a.template ?? '')
  if (node.kind === 'parameter') return `${String(a.location ?? '')} parameter`
  if (node.kind === 'signal') return String(a.templateId ?? a.checkId ?? a.observationType ?? '')
  return node.key
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string
  value: T | 'all'
  options: readonly T[]
  onChange: (v: T | 'all') => void
  render: (v: T) => string
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T | 'all')}
        className="rounded-sm border border-border bg-surface px-1.5 py-1 text-xs text-foreground"
      >
        <option value="all">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {render(o)}
          </option>
        ))}
      </select>
    </label>
  )
}

const SOURCE_LABEL: Record<SecurityGraphProvenance['source'], string> = {
  observation: 'Sensor observation',
  derivation: 'Deterministic derivation',
  'ai-inference': 'AI inference (validated, not observed)',
  'user-declaration': 'Declared by a person',
}

function attributeText(value: unknown): string {
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · ')
  return String(value)
}

function Neighbors({ neighbors, onSelect }: { neighbors: GraphNeighbor[]; onSelect: (id: string) => void }) {
  if (!neighbors.length) return <p className="text-xs text-muted">No relationships.</p>
  const groups = new Map<string, GraphNeighbor[]>()
  for (const n of neighbors)
    groups.set(`${n.direction}|${n.edge.type}`, [...(groups.get(`${n.direction}|${n.edge.type}`) ?? []), n])
  return (
    <div className="flex flex-col gap-2.5">
      {[...groups.entries()].map(([key, items]) => {
        const [direction, type] = key.split('|')
        return (
          <div key={key}>
            <div className="mb-1 flex items-center gap-1.5 font-mono text-2xs text-subtle">
              {direction === 'out' ? (
                <ArrowRight className="size-3" aria-hidden />
              ) : (
                <ArrowLeft className="size-3" aria-hidden />
              )}
              {direction === 'out' ? type : `${type} (from)`}
            </div>
            <ul className="flex flex-col gap-1">
              {items.slice(0, 25).map((n) => (
                <li key={n.edge.id} className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(n.node.id)}
                    className="min-w-0 truncate text-left text-xs text-link hover:underline"
                  >
                    <span className="text-subtle">{ENTITY_KIND_LABEL[n.node.kind]} · </span>
                    <span
                      className={
                        n.node.kind === 'endpoint' || n.node.kind === 'host' ? 'font-mono' : undefined
                      }
                    >
                      {n.node.label}
                    </span>
                  </button>
                  {n.edge.basis !== 'observed' ? <BasisBadge basis={n.edge.basis} /> : null}
                  {n.edge.status !== 'active' ? <FactStatusBadge status={n.edge.status} /> : null}
                </li>
              ))}
              {items.length > 25 ? (
                <li className="text-2xs text-subtle">and {items.length - 25} more</li>
              ) : null}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function GapList({ gaps, onSelect }: { gaps: KnowledgeGap[]; onSelect?: (id: string) => void }) {
  return (
    <ul className="flex flex-col gap-2">
      {gaps.map((g) => (
        <li key={g.id} className="flex items-start gap-2 text-xs">
          <CircleHelp
            className={cn('mt-0.5 size-3.5 shrink-0', g.status === 'open' ? 'text-info' : 'text-subtle')}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="text-foreground text-break">
              {onSelect ? (
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => onSelect(g.subjectId)}
                >
                  {g.question}
                </button>
              ) : (
                g.question
              )}
            </div>
            <div className="text-2xs text-subtle">
              {GAP_KIND_LABEL[g.kind]} · {g.status === 'open' ? 'unknown' : g.status}
              {g.resolution ? ` — ${g.resolution}` : ''}
              {g.status === 'open' && g.answeredBy.length === 0
                ? ' — no shipped capability can answer this yet'
                : ''}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function NodeDetailPanel({
  nodeId,
  active,
  onSelect,
  onHypothesis,
}: {
  nodeId: string
  active: boolean
  onSelect: (id: string) => void
  onHypothesis: (id: string) => void
}) {
  const detail = useQuery(graphNodeQuery(nodeId, active))
  if (detail.isError) {
    return (
      <Panel className="self-start">
        <ErrorState
          title="Could not load the entity"
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </Panel>
    )
  }
  if (!detail.data) {
    return (
      <Panel className="self-start">
        <LoadingState rows={6} />
      </Panel>
    )
  }
  const { node, neighbors, provenance, gaps, hypothesisIds, truncated } = detail.data
  const attributes = Object.entries(node.attributes).filter(([k]) => !['versionByTool'].includes(k))
  return (
    <Panel className="self-start" id="graph-entity">
      <PanelHeader
        title={
          <span className={node.kind === 'endpoint' || node.kind === 'host' ? 'font-mono' : undefined}>
            {node.label}
          </span>
        }
        description={<span className="font-mono text-2xs text-break">{node.key}</span>}
      />
      <PanelBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2" data-testid="graph-entity-status">
          <span className="text-xs text-muted">{ENTITY_KIND_LABEL[node.kind]}</span>
          <BasisBadge basis={node.basis} />
          <FactStatusBadge status={node.status} />
          <span className="font-mono text-xs text-muted tabular-nums" title="Confidence">
            {node.confidence.toFixed(2)}
          </span>
          <span className="text-xs text-muted">
            · {node.corroboration} sensor{node.corroboration === 1 ? '' : 's'}
            {node.tools.length ? ` (${node.tools.join(', ')})` : ''}
          </span>
        </div>
        {node.conflicts.length ? (
          <Notice tone="warning" title="Contradicted — both facts are kept">
            {node.conflicts.map((c) => c.reason).join(' ')}
          </Notice>
        ) : node.statusReason && node.status !== 'active' ? (
          <Notice tone="neutral" title={node.status === 'stale' ? 'Stale' : 'Superseded'}>
            {node.statusReason}
          </Notice>
        ) : null}
        <DefinitionList
          layout="stacked"
          items={[
            ...attributes.map(([k, v]) => ({
              label: k.replace(/^header:/, 'header '),
              value: <span className="font-mono text-xs">{attributeText(v)}</span>,
            })),
            ...(node.scopeClass ? [{ label: 'Scope', value: node.scopeClass }] : []),
            {
              label: 'First observed',
              value: `${formatDateTime(node.firstObservedAt)}${node.firstExecutionId ? ` · ${node.firstExecutionId}` : ''}`,
            },
            {
              label: 'Last observed',
              value: `${formatDateTime(node.lastObservedAt)}${node.lastExecutionId ? ` · ${node.lastExecutionId}` : ''}`,
            },
          ]}
        />
        {gaps.length ? (
          <section className="border-t border-border pt-3">
            <SectionLabel>Unknowns</SectionLabel>
            <GapList gaps={gaps} />
          </section>
        ) : null}
        <section className="border-t border-border pt-3">
          <SectionLabel>Relationships</SectionLabel>
          <Neighbors neighbors={neighbors} onSelect={onSelect} />
          {truncated ? (
            <p className="mt-1 text-2xs text-subtle">Only the most recent relationships are shown.</p>
          ) : null}
        </section>
        <section className="border-t border-border pt-3">
          <SectionLabel>Why Audivra believes this</SectionLabel>
          {provenance.length ? (
            <ul className="flex flex-col gap-2.5" data-testid="graph-provenance">
              {provenance.slice(0, 20).map((p) => (
                <li key={p.id} className="text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-foreground">{SOURCE_LABEL[p.source]}</span>
                    {p.tools.length ? (
                      <span className="font-mono text-2xs text-muted">{p.tools.join(', ')}</span>
                    ) : null}
                    <span className="font-mono text-2xs text-subtle tabular-nums">
                      {p.confidence.toFixed(2)}
                    </span>
                  </div>
                  {p.rationale ? <p className="text-muted text-break">{p.rationale}</p> : null}
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {p.evidenceRefs.map((ref) => (
                      <span key={ref} className={tagVariants({ kind: 'code' })}>
                        {ref}
                      </span>
                    ))}
                    {p.executionIds.slice(-2).map((id) => (
                      <span key={id} className={tagVariants({ kind: 'code' })} title="Execution">
                        {id}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
              {provenance.length > 20 ? (
                <li className="text-2xs text-subtle">and {provenance.length - 20} more sources</li>
              ) : null}
            </ul>
          ) : (
            <p className="text-xs text-muted">No provenance recorded.</p>
          )}
        </section>
        {hypothesisIds.length ? (
          <section className="border-t border-border pt-3">
            <SectionLabel>Hypotheses about it</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {hypothesisIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={tagVariants({ kind: 'ref' })}
                  onClick={() => onHypothesis(id)}
                >
                  {id}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </PanelBody>
    </Panel>
  )
}

export function GraphTab({
  engagement,
  entity,
  onEntity,
  onHypothesis,
}: {
  engagement: SecurityEngagementDetail
  entity?: string
  onEntity: (id: string) => void
  onHypothesis: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const runs = useQuery(reasoningRunsQuery(engagement.id))
  const active = !!runs.data?.some((r) => isActiveRun(r.status))
  const [kind, setKind] = useState<GraphEntityKind | 'all'>('all')
  const [basis, setBasis] = useState<KnowledgeBasis | 'all'>('all')
  const [status, setStatus] = useState<FactStatus | 'all'>('all')
  const [q, setQ] = useState('')
  const summary = useQuery(graphSummaryQuery(engagement.id, active))
  const nodes = useQuery(
    graphNodesQuery(
      engagement.id,
      {
        kind: kind === 'all' ? undefined : kind,
        basis: basis === 'all' ? undefined : basis,
        status: status === 'all' ? undefined : status,
        q: q.trim() || undefined,
      },
      active,
    ),
  )
  const gaps = useQuery(graphGapsQuery(engagement.id, active))
  const rows = nodes.data ?? []
  const current = entity && rows.some((r) => r.id === entity) ? entity : (entity ?? rows[0]?.id ?? null)
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    initialSorting: [{ id: 'kind', desc: false }],
  })
  const rebuild = useMutation({
    mutationFn: () => api.rebuildGraph(engagement.id),
    onSuccess: (result) => {
      toast.success(
        result.nodes.added || result.edges.added
          ? `Graph updated: ${result.nodes.added} new entities, ${result.edges.added} new relationships`
          : 'Graph already up to date',
      )
      void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id, 'graph'] })
      void queryClient.invalidateQueries({ queryKey: queryKeys.graphSummary(engagement.id) })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not rebuild the graph'),
  })
  const s = summary.data
  const open = (gaps.data ?? []).filter((g) => g.status === 'open')
  const resolved = (gaps.data ?? []).filter((g) => g.status === 'resolved').length

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Security graph"
          description="What Audivra knows about the application, projected deterministically from sensor observations. Every fact carries its provenance; AI inferences are labelled and never replace observed facts."
          actions={
            <Button
              size="sm"
              variant="secondary"
              disabled={rebuild.isPending}
              onClick={() => rebuild.mutate()}
              title="Re-project the graph from stored observations (deterministic, idempotent; runs nothing)"
            >
              {rebuild.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Rebuild from observations
            </Button>
          }
        />
        <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
          <Metric label="Entities" value={s?.entities ?? '—'} tone={s?.entities ? 'default' : 'muted'} />
          <Metric
            label="Relationships"
            value={s?.relationships ?? '—'}
            tone={s?.relationships ? 'default' : 'muted'}
          />
          <Metric label="Observed" value={s?.byBasis.observed ?? 0} tone="success" />
          <Metric label="Derived" value={s?.byBasis.derived ?? 0} tone="default" />
          <Metric
            label="Inferred (AI)"
            value={s?.byBasis.inferred ?? 0}
            tone={s?.byBasis.inferred ? 'medium' : 'muted'}
          />
          <Metric
            label="Contradicted"
            value={s?.byStatus.contradicted ?? 0}
            tone={s?.byStatus.contradicted ? 'high' : 'muted'}
          />
          <Metric label="Stale" value={s?.byStatus.stale ?? 0} tone="muted" />
          <Metric
            label="Open unknowns"
            value={s?.gaps.open ?? 0}
            tone={s?.gaps.open ? 'default' : 'muted'}
            hint={s ? `${s.gaps.resolved} answered` : undefined}
          />
        </PanelBody>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_28rem] xl:items-start">
        <Panel>
          <PanelHeader
            title="Entities"
            description="Hosts, endpoints, API operations, parameters, technologies, signals and source files — with how each is known."
            actions={
              <div className="flex flex-wrap items-center gap-3">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search"
                  aria-label="Search entities"
                  className="h-7 w-32 rounded-sm border border-border bg-surface px-2 text-xs text-foreground placeholder:text-subtle"
                />
                <Select
                  label="Kind"
                  value={kind}
                  options={GRAPH_ENTITY_KINDS}
                  onChange={setKind}
                  render={(k) => ENTITY_KIND_LABEL[k]}
                />
                <Select
                  label="Basis"
                  value={basis}
                  options={KNOWLEDGE_BASES}
                  onChange={setBasis}
                  render={(b) => b}
                />
                <Select
                  label="Status"
                  value={status}
                  options={FACT_STATUSES}
                  onChange={setStatus}
                  render={(st) => st}
                />
              </div>
            }
          />
          {nodes.isError ? (
            <ErrorState
              title="Could not load the graph"
              error={nodes.error}
              onRetry={() => void nodes.refetch()}
            />
          ) : (
            <DataTable
              table={table}
              isLoading={nodes.isLoading}
              selectedRowId={current}
              onRowClick={(row) => onEntity(row.id)}
              minWidth="min-w-140"
              empty={
                <EmptyState
                  icon={Share2}
                  title={s?.entities ? 'No entity matches these filters' : 'The graph is empty'}
                  description={
                    s?.entities
                      ? undefined
                      : 'Entities appear as sensor capabilities record observations; the graph is projected after every execution.'
                  }
                />
              }
            />
          )}
        </Panel>
        {current ? (
          <NodeDetailPanel
            key={current}
            nodeId={current}
            active={active}
            onSelect={onEntity}
            onHypothesis={onHypothesis}
          />
        ) : null}
      </div>

      <Panel>
        <PanelHeader
          title="Unknowns"
          description="Explicit knowledge gaps — questions the graph cannot answer yet. Unknown is never treated as false or as secure."
        />
        <PanelBody>
          {gaps.isLoading ? (
            <LoadingState rows={3} />
          ) : open.length ? (
            <div className="flex flex-col gap-3" data-testid="graph-unknowns">
              <GapList gaps={open.slice(0, 40)} onSelect={onEntity} />
              <p className="text-2xs text-subtle">
                {open.length > 40 ? `${open.length - 40} more open · ` : ''}
                {resolved} answered so far
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted">
              {resolved ? `No open unknowns (${resolved} answered).` : 'No unknowns recorded yet.'}
            </p>
          )}
        </PanelBody>
      </Panel>
    </div>
  )
}
