import type {
  CheckResult,
  EvidenceCheck,
  ReasoningRun,
  SecurityEngagementDetail,
  SecurityHypothesis,
  SecurityHypothesisDetail,
} from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Ban, CheckCircle2, Circle, Lightbulb, Loader2, Sparkles, XCircle } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  ActionStatusBadge,
  ENTITY_KIND_LABEL,
  GAP_KIND_LABEL,
  HypothesisStatusBadge,
  ReasoningRunStatusBadge,
  STOP_REASON_LABEL,
} from '@/components/badges'
import { DataTable, useDataTable } from '@/components/data-table'
import { Toolbar } from '@/components/page-header'
import { Metric } from '@/components/metric'
import { DefinitionList, Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState, Notice } from '@/components/states'
import { tagVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { api } from '@/lib/api'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import {
  hypothesesQuery,
  hypothesisQuery,
  isActiveRun,
  reasoningCoverageQuery,
  reasoningRunsQuery,
} from '@/lib/queries'
import { cn } from '@/lib/utils'

/*
 * Hypotheses: the claims Audivra is investigating, ranked by what investigating them would teach, with the
 * evidence that supports or contradicts each one and the capability proposed to gather more. A hypothesis
 * is never a verified vulnerability. Starting a run asks Audivra to reason within a strict budget; any
 * action it proposes is validated and decided by the Capability Broker — this page never runs a capability.
 */

const isOpen = (status: SecurityHypothesis['status']) =>
  !['disproved', 'confirmed-signal', 'exhausted'].includes(status)

const CATEGORY_LABEL: Record<SecurityHypothesis['category'], string> = {
  'attack-surface': 'Attack surface',
  technology: 'Technology',
  'endpoint-behavior': 'Endpoint behavior',
  'api-surface': 'API surface',
  configuration: 'Configuration',
  'evidence-gap': 'Evidence gap',
  'signal-confirmation': 'Signal confirmation',
  'object-boundary': 'Object boundary',
  'role-boundary': 'Role boundary',
  'tenant-boundary': 'Tenant boundary',
  'function-level': 'Function-level access',
  'field-boundary': 'Field boundary',
  'session-boundary': 'Session boundary',
  'business-rule': 'Business rule',
}

const column = createColumnHelper<SecurityHypothesis>()
const columns = [
  column.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => <HypothesisStatusBadge status={getValue()} />,
    meta: { className: 'w-1' },
  }),
  column.accessor('claim', {
    header: 'Claim',
    cell: ({ row }) => (
      <div className="min-w-0 py-1">
        <div className="truncate font-medium text-foreground">{row.original.claim}</div>
        <div className="truncate text-2xs text-subtle">
          {CATEGORY_LABEL[row.original.category]} · {row.original.impact} impact ·{' '}
          {row.original.subjectEntityIds.length} entit
          {row.original.subjectEntityIds.length === 1 ? 'y' : 'ies'}
        </div>
      </div>
    ),
    meta: { className: 'w-full max-w-0' },
  }),
  column.accessor('confidence', {
    header: 'Confidence',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs tabular-nums text-muted">{getValue().toFixed(2)}</span>
    ),
    meta: { className: 'hidden w-1 sm:table-cell', align: 'right' },
  }),
  column.accessor((row) => row.supportingObservationIds.length, {
    id: 'evidence',
    header: 'Evidence',
    cell: ({ row }) => (
      <span
        className="font-mono text-xs whitespace-nowrap tabular-nums text-muted"
        title="Supporting / contradicting observations"
      >
        {row.original.supportingObservationIds.length}
        <span className="text-subtle"> / </span>
        <span className={row.original.contradictingObservationIds.length ? 'text-critical' : undefined}>
          {row.original.contradictingObservationIds.length}
        </span>
      </span>
    ),
    meta: { className: 'hidden w-1 2xl:table-cell', align: 'right' },
  }),
  column.accessor((row) => row.expectedInformationGain ?? -1, {
    id: 'gain',
    header: 'Exp. gain',
    cell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums text-muted">
        {row.original.expectedInformationGain === null
          ? '—'
          : row.original.expectedInformationGain.toFixed(2)}
      </span>
    ),
    meta: { className: 'hidden w-1 xl:table-cell', align: 'right' },
  }),
  column.accessor((row) => row.ranking?.bestCapabilityId ?? row.candidateCapabilities[0] ?? '', {
    id: 'capability',
    header: 'Next capability',
    cell: ({ getValue }) => (
      <span className="font-mono text-2xs whitespace-nowrap text-muted">{getValue() || '—'}</span>
    ),
    meta: { className: 'hidden w-1 2xl:table-cell' },
  }),
  column.accessor('updatedAt', {
    header: 'Updated',
    cell: ({ getValue }) => (
      <span className="text-xs whitespace-nowrap text-muted" title={formatDateTime(getValue())}>
        {formatRelative(getValue())}
      </span>
    ),
    meta: { className: 'hidden w-1 2xl:table-cell' },
  }),
]

function checkText(check: EvidenceCheck, entities: Map<string, string>, gaps: Map<string, string>): string {
  const entity = 'entityId' in check ? (entities.get(check.entityId) ?? check.entityId) : ''
  switch (check.check) {
    case 'response-status':
      return `${entity} responds HTTP ${check.statuses.join('/')}`
    case 'independent-corroboration':
      return `${entity} is reported by an independent sensor`
    case 'observation-present':
      return `a ${check.observationType} observation exists for ${entity}`
    case 'entity-contradicted':
      return `${entity} is contradicted by another fact`
    case 'gap-resolved':
      return `the unknown "${gaps.get(check.gapId) ?? check.gapId}" is answered`
    case 'comparison-result':
      return `a differential comparison${check.dimension ? ` (${check.dimension})` : ''} settles ${check.results.join('/')}`
  }
}

function Checks({ detail }: { detail: SecurityHypothesisDetail }) {
  const h = detail.hypothesis
  const entities = new Map(detail.entities.map((e) => [e.id, e.label]))
  const gaps = new Map(detail.gaps.map((g) => [g.id, g.question]))
  const results = new Map<number, CheckResult>(h.checkResults.map((r) => [r.index, r]))
  return (
    <ul className="flex flex-col gap-2" data-testid="hypothesis-checks">
      {h.evidenceChecks.map((check, i) => {
        const r = results.get(i)
        const Icon = r?.met ? (check.effect === 'supports' ? CheckCircle2 : XCircle) : Circle
        return (
          <li key={i} className="flex items-start gap-2 text-xs">
            <Icon
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                r?.met ? (check.effect === 'supports' ? 'text-success' : 'text-critical') : 'text-subtle',
              )}
              aria-hidden
            />
            <div className="min-w-0">
              <div className="text-foreground text-break">
                <span className="text-subtle">
                  {check.effect === 'supports' ? 'Supports if ' : 'Contradicts if '}
                </span>
                {checkText(check, entities, gaps)}
              </div>
              <div className="text-2xs text-muted text-break">
                {r ? `${r.met ? 'Met' : 'Not met'} — ${r.detail}` : 'Not evaluated yet'}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ObservationRefs({ items, empty }: { items: SecurityHypothesisDetail['supporting']; empty: string }) {
  if (!items.length) return <p className="text-xs text-muted">{empty}</p>
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((o) => (
        <li key={o.id} className="min-w-0 text-xs">
          <div className="truncate text-foreground">{o.title}</div>
          <div className="flex flex-wrap items-center gap-1 text-2xs text-subtle">
            <span className="truncate font-mono">{o.asset}</span>
            <span>· {o.tools.join(', ')}</span>
            {o.evidenceRefs.map((ref) => (
              <span key={ref} className={tagVariants({ kind: 'code' })}>
                {ref}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

function HypothesisDetailPanel({
  id,
  active,
  onEntity,
}: {
  id: string
  active: boolean
  onEntity: (id: string) => void
}) {
  const query = useQuery(hypothesisQuery(id, active))
  if (query.isError) {
    return (
      <Panel className="self-start">
        <ErrorState
          title="Could not load the hypothesis"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </Panel>
    )
  }
  const detail = query.data
  if (!detail) {
    return (
      <Panel className="self-start">
        <LoadingState rows={6} />
      </Panel>
    )
  }
  const h = detail.hypothesis
  const ranking = h.ranking
  return (
    <Panel className="self-start" id="hypothesis-detail">
      <PanelHeader
        title={h.claim}
        description={
          <span className="text-2xs">
            {CATEGORY_LABEL[h.category]} · {h.impact} impact · <span className="font-mono">{h.id}</span>
          </span>
        }
      />
      <PanelBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2" data-testid="hypothesis-status">
          <HypothesisStatusBadge status={h.status} />
          <span className="font-mono text-xs tabular-nums text-muted" title="Confidence">
            {h.confidence.toFixed(2)}
          </span>
          {h.attempts ? (
            <span className="text-xs text-muted">
              · {h.attempts} attempt{h.attempts === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted text-break">{h.statusReason}</p>

        <section className="border-t border-border pt-3">
          <SectionLabel>Why Audivra is investigating this</SectionLabel>
          <p className="text-sm text-foreground text-break">{h.rationale}</p>
          {ranking ? (
            <>
              <p className="mt-2 text-xs text-muted text-break" data-testid="hypothesis-ranking">
                <span className="text-subtle">{isOpen(h.status) ? 'Ranking: ' : 'Last ranking: '}</span>
                {ranking.explanation}
              </p>
              <DefinitionList
                className="mt-2"
                items={[
                  {
                    label: 'Priority',
                    value: <span className="font-mono tabular-nums">{ranking.priority}</span>,
                  },
                  {
                    label: 'Expected information gain',
                    value: (
                      <span className="font-mono tabular-nums">
                        {ranking.expectedInformationGain.toFixed(2)}
                      </span>
                    ),
                  },
                  {
                    label: 'Uncertainty',
                    value: (
                      <span className="font-mono tabular-nums">{ranking.factors.uncertainty.toFixed(2)}</span>
                    ),
                  },
                  {
                    label: 'Best capability',
                    value: <span className="font-mono text-xs">{ranking.bestCapabilityId ?? '—'}</span>,
                  },
                  {
                    label: 'Cost · risk',
                    value: `${ranking.factors.costUnits} unit${ranking.factors.costUnits === 1 ? '' : 's'} · ${h.executionRisk ?? '—'}`,
                  },
                ]}
              />
            </>
          ) : null}
        </section>

        <section className="border-t border-border pt-3">
          <SectionLabel>Evidence checks</SectionLabel>
          <Checks detail={detail} />
        </section>

        <section className="border-t border-border pt-3">
          <SectionLabel>Supporting evidence</SectionLabel>
          <ObservationRefs items={detail.supporting} empty="None cited yet." />
        </section>
        {detail.contradicting.length ? (
          <section className="border-t border-border pt-3">
            <SectionLabel>Contradicting evidence</SectionLabel>
            <ObservationRefs items={detail.contradicting} empty="" />
          </section>
        ) : null}

        <section className="border-t border-border pt-3">
          <SectionLabel>Affected entities</SectionLabel>
          <ul className="flex flex-col gap-1">
            {detail.entities.map((e) => (
              <li key={e.id} className="text-xs">
                <button
                  type="button"
                  className="text-left text-link hover:underline"
                  onClick={() => onEntity(e.id)}
                >
                  <span className="text-subtle">
                    {ENTITY_KIND_LABEL[e.kind as keyof typeof ENTITY_KIND_LABEL] ?? e.kind} ·{' '}
                  </span>
                  {e.label}
                </button>
                <span className="text-2xs text-subtle">
                  {' '}
                  · {e.basis}
                  {e.status !== 'active' ? ` · ${e.status}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {detail.gaps.length ? (
            <ul className="mt-2 flex flex-col gap-1">
              {detail.gaps.map((g) => (
                <li key={g.id} className="text-2xs text-muted">
                  {GAP_KIND_LABEL[g.kind as keyof typeof GAP_KIND_LABEL] ?? g.kind}: {g.question} (
                  {g.status === 'open' ? 'unknown' : g.status})
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="border-t border-border pt-3">
          <SectionLabel>Proposed actions</SectionLabel>
          {detail.actions.length ? (
            <ul className="flex flex-col gap-2" data-testid="hypothesis-actions">
              {detail.actions.map((a) => (
                <li key={a.id} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <ActionStatusBadge status={a.status} />
                    <span className="font-mono text-2xs text-foreground">{a.capabilityId}</span>
                    {typeof a.input.url === 'string' ? (
                      <span className="truncate font-mono text-2xs text-muted">{a.input.url}</span>
                    ) : null}
                  </div>
                  <p className="text-muted text-break">{a.reason}</p>
                  {a.statusReason ? (
                    <p className="text-2xs text-subtle text-break">{a.statusReason}</p>
                  ) : null}
                  {a.executionId ? (
                    <p className="font-mono text-2xs text-subtle">execution {a.executionId}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">No action proposed for it yet.</p>
          )}
        </section>

        <section className="border-t border-border pt-3">
          <SectionLabel>History</SectionLabel>
          <ol className="flex flex-col gap-1.5">
            {[...h.history].reverse().map((t, i) => (
              <li key={i} className="text-xs">
                <span className="text-muted">{formatRelative(t.at)} · </span>
                <span className="text-foreground">{t.from ? `${t.from} → ${t.to}` : t.to}</span>
                <span className="block text-2xs text-subtle text-break">{t.reason}</span>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-2xs text-subtle">
            Proposed by{' '}
            {h.origin.kind === 'ai'
              ? `${h.origin.providerId ?? 'an AI provider'}${h.origin.promptVersion ? ` (${h.origin.promptVersion})` : ''}`
              : 'a person'}{' '}
            · review: {h.review.verdict}
            {h.review.note ? ` — ${h.review.note}` : ''}
          </p>
        </section>
      </PanelBody>
    </Panel>
  )
}

function RunSummary({ run }: { run: ReasoningRun }) {
  const q = run.usage.quality
  const rejected = Object.entries(q.hypothesesRejected).reduce((a, [, n]) => a + n, 0)
  const actionsRejected = Object.entries(q.actionsRejected).reduce((a, [, n]) => a + n, 0)
  return (
    <div className="flex flex-col gap-3" data-testid="reasoning-run">
      <div className="flex flex-wrap items-center gap-2">
        <ReasoningRunStatusBadge status={run.status} />
        <span className="text-xs text-muted">
          {run.mode === 'investigate' ? 'Investigate' : 'Propose'} mode · iteration {run.iteration}/
          {run.budget.maxIterations}
          {isActiveRun(run.status) ? ` · ${run.stage}` : ''}
        </span>
        <span className="font-mono text-2xs text-subtle">{run.id}</span>
      </div>
      {run.stopReason ? (
        <p className="text-sm text-foreground">
          {STOP_REASON_LABEL[run.stopReason]}
          {run.stopDetail && run.stopDetail !== STOP_REASON_LABEL[run.stopReason] ? (
            <span className="block text-xs text-muted text-break">{run.stopDetail}</span>
          ) : null}
        </p>
      ) : null}
      {run.stopReason === 'provider-unavailable' || run.stopReason === 'provider-refused' ? (
        <Notice
          tone="warning"
          title={
            run.stopReason === 'provider-refused' ? 'The AI provider declined this task' : 'AI is unavailable'
          }
        >
          Only AI work paused. The graph, observations, sensors, existing hypotheses and deterministic
          coverage remain available
          {run.stopReason === 'provider-refused'
            ? '; a refusal is recorded and never rerouted to another provider.'
            : '.'}
        </Notice>
      ) : null}
      <DefinitionList
        items={[
          {
            label: 'AI calls',
            value: `${run.usage.aiCalls} of ${run.budget.maxAiCalls}${Object.keys(run.usage.providers).length ? ` · ${Object.keys(run.usage.providers).join(', ')}` : ''}`,
          },
          {
            label: 'Actions executed',
            value: `${run.usage.actionsExecuted} of ${run.budget.maxActions} · ${run.usage.costUnits} cost unit${run.usage.costUnits === 1 ? '' : 's'}`,
          },
          {
            label: 'Validation',
            value: `${q.hypothesesAccepted} accepted · ${q.hypothesesMerged} merged · ${rejected} rejected${actionsRejected ? ` · ${actionsRejected} action${actionsRejected === 1 ? '' : 's'} rejected` : ''}`,
          },
          { label: 'AI coverage', value: run.aiCoverage ?? '—' },
          {
            label: 'Elapsed',
            value: run.finishedAt
              ? formatDuration(run.usage.elapsedMs)
              : `started ${formatRelative(run.startedAt ?? run.createdAt)}`,
          },
        ]}
      />
      {run.decisions.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Decision trail ({run.decisions.length})</summary>
          <ol className="mt-2 flex flex-col gap-1">
            {run.decisions.map((d, i) => (
              <li key={i} className="text-break">
                <span className="font-mono text-2xs text-subtle">
                  {d.iteration}·{d.stage}{' '}
                </span>
                <span className="text-muted">{d.message}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  )
}

export function HypothesesTab({
  engagement,
  hypothesis,
  onHypothesis,
  onEntity,
}: {
  engagement: SecurityEngagementDetail
  hypothesis?: string
  onHypothesis: (id: string) => void
  onEntity: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const runs = useQuery(reasoningRunsQuery(engagement.id))
  const latest = runs.data?.[0] ?? null
  const active = !!latest && isActiveRun(latest.status)
  const hypotheses = useQuery(hypothesesQuery(engagement.id, active))
  const coverage = useQuery(reasoningCoverageQuery(engagement.id, active))
  const rows = hypotheses.data ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const pick = hypothesis ?? selected
  const current = pick && rows.some((r) => r.id === pick) ? pick : (rows[0]?.id ?? null)
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    initialSorting: [{ id: 'gain', desc: true }],
  })
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['security', 'engagement', engagement.id] })
  const start = useMutation({
    mutationFn: (mode: 'propose' | 'investigate') => api.startReasoning(engagement.id, { mode }),
    onSuccess: (run) => {
      toast.success(
        run.mode === 'investigate'
          ? 'Investigation started within its budget'
          : 'Reasoning started (propose mode: nothing will run)',
      )
      refresh()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not start reasoning'),
  })
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelReasoning(runId),
    onSuccess: () => refresh(),
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not cancel'),
  })
  const c = coverage.data
  const busy = active || start.isPending

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Reasoning"
          description="Bounded, persisted reasoning over the graph: hypotheses ranked by expected information gain, and the next useful capability — decided by policy, never by the model."
        />
        <Toolbar className="border-b border-border px-4 py-2">
          {active && latest ? (
            <Button
              size="sm"
              variant="danger"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(latest.id)}
            >
              {cancel.isPending ? <Loader2 className="animate-spin" /> : <Ban />}
              Stop reasoning
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => start.mutate('propose')}
                title="Generate and rank hypotheses and propose next capabilities; nothing is executed"
              >
                <Lightbulb />
                Propose next steps
              </Button>
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="primary" disabled={busy}>
                    <Sparkles />
                    Investigate
                  </Button>
                }
                title="Investigate within a strict budget?"
                confirmLabel="Investigate"
                dismissLabel="Not now"
                onConfirm={() => start.mutate('investigate')}
              >
                Audivra will reason for up to 3 iterations, make at most 9 AI calls and request at most 3
                read-only, low-risk capabilities. Every request goes through the Capability Broker with this
                engagement’s authorization, scope and policy; anything the policy denies is recorded as
                blocked.
              </ConfirmDialog>
            </>
          )}
        </Toolbar>
        <PanelBody>
          {runs.isError ? (
            <ErrorState
              title="Could not load reasoning runs"
              error={runs.error}
              onRetry={() => void runs.refetch()}
            />
          ) : latest ? (
            <RunSummary run={latest} />
          ) : (
            <p className="text-xs text-muted">
              No reasoning run yet. Hypotheses are generated from the graph and its unknowns when a run
              starts.
            </p>
          )}
        </PanelBody>
      </Panel>

      {c ? (
        <Panel>
          <PanelHeader
            title="Reasoning coverage"
            description="What was investigated and what remains unknown — never a security score."
          />
          <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
            <Metric
              label="Hypotheses"
              value={c.hypotheses.total}
              tone={c.hypotheses.total ? 'default' : 'muted'}
            />
            <Metric label="Investigated" value={c.hypotheses.investigated} tone="default" />
            <Metric
              label="Confirmed signals"
              value={c.hypotheses.byStatus['confirmed-signal'] ?? 0}
              tone={c.hypotheses.byStatus['confirmed-signal'] ? 'high' : 'muted'}
            />
            <Metric label="Disproved" value={c.hypotheses.byStatus.disproved ?? 0} tone="muted" />
            <Metric
              label="Blocked"
              value={c.hypotheses.blocked}
              tone={c.hypotheses.blocked ? 'medium' : 'muted'}
            />
            <Metric label="Exhausted" value={c.hypotheses.exhausted} tone="muted" />
            <Metric
              label="Open unknowns"
              value={c.gaps.open}
              tone={c.gaps.open ? 'default' : 'muted'}
              hint={`${c.gaps.resolved} answered`}
            />
            <Metric
              label="Endpoints inspected"
              value={`${c.graph.endpointsInspected.known}/${c.graph.endpointsInspected.total}`}
              tone="default"
            />
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_30rem] xl:items-start">
        <Panel>
          <PanelHeader
            title="Hypotheses"
            description="Claims to investigate, most informative first. A confirmed signal is corroborated — it is still not a verified vulnerability."
          />
          {hypotheses.isError ? (
            <ErrorState
              title="Could not load hypotheses"
              error={hypotheses.error}
              onRetry={() => void hypotheses.refetch()}
            />
          ) : (
            <DataTable
              table={table}
              isLoading={hypotheses.isLoading}
              selectedRowId={current}
              onRowClick={(row) => {
                setSelected(row.id)
                onHypothesis(row.id)
              }}
              minWidth="min-w-140"
              empty={
                <EmptyState
                  icon={Lightbulb}
                  title="No hypotheses yet"
                  description="Start a reasoning run to generate hypotheses from the graph's unknowns. Existing ones stay visible even when AI is unavailable."
                />
              }
            />
          )}
        </Panel>
        {current ? (
          <HypothesisDetailPanel key={current} id={current} active={active} onEntity={onEntity} />
        ) : null}
      </div>

      {runs.data && runs.data.length > 1 ? (
        <Panel>
          <PanelHeader title="Earlier runs" />
          <ul className="divide-y divide-border">
            {runs.data.slice(1, 11).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
                <ReasoningRunStatusBadge status={r.status} />
                <span className="text-muted">{r.mode}</span>
                <span className="text-foreground">
                  {r.stopReason ? STOP_REASON_LABEL[r.stopReason] : '—'}
                </span>
                <span className="text-subtle">
                  {r.usage.aiCalls} AI call{r.usage.aiCalls === 1 ? '' : 's'} · {r.usage.actionsExecuted}{' '}
                  action{r.usage.actionsExecuted === 1 ? '' : 's'} · {formatRelative(r.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}
