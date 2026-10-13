import type { ComparisonResult, InvariantEvalStatus, SecurityComparison, SecurityEngagementDetail } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Scale, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { securityComparisonQuery, engagementComparisonCoverageQuery, engagementComparisonsQuery, engagementInvariantsQuery, queryKeys } from '@/lib/queries'

/*
 * Phase 5 Step 4 — the Access view. It shows the differential-authorization comparisons Audivra has run
 * (identity → resource → action → expected vs observed → result), the invariants they support or contradict,
 * and authorization/business coverage. A comparison is never called a vulnerability; "inconsistent" means a
 * controlled difference contradicted the expected boundary. Secrets never appear here.
 */

const RESULT: Record<ComparisonResult, { label: string; tone: BadgeTone }> = {
  consistent: { label: 'Consistent', tone: 'success' },
  inconsistent: { label: 'Inconsistent', tone: 'critical' },
  inconclusive: { label: 'Inconclusive', tone: 'medium' },
  blocked: { label: 'Blocked', tone: 'neutral' },
  'not-tested': { label: 'Not tested', tone: 'neutral' },
}
const INVARIANT: Record<InvariantEvalStatus, { label: string; tone: BadgeTone }> = {
  supported: { label: 'Supported', tone: 'success' },
  contradicted: { label: 'Contradicted', tone: 'critical' },
  inconclusive: { label: 'Inconclusive', tone: 'medium' },
  'not-tested': { label: 'Not tested', tone: 'neutral' },
}

export function AccessTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const id = engagement.id
  const comparisons = useQuery(engagementComparisonsQuery(id))
  const coverage = useQuery(engagementComparisonCoverageQuery(id))
  const invariants = useQuery(engagementInvariantsQuery(id))
  const [selected, setSelected] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const propose = useMutation({
    mutationFn: async () => {
      const proposals = await api.proposeComparisons(id)
      if (proposals.length === 0) return 0
      for (const p of proposals) await api.createComparison(id, p.plan)
      return proposals.length
    },
    onSuccess: (count) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementComparisons(id) })
      toast.success(count === 0 ? 'No new comparisons to propose' : `Queued ${count} comparison${count === 1 ? '' : 's'}`)
    },
    onError: (error) => toast.error('Could not propose comparisons', { description: error instanceof Error ? error.message : String(error) }),
  })

  if (comparisons.isError) return <ErrorState title="Could not load comparisons" error={comparisons.error} onRetry={() => void comparisons.refetch()} />
  if (!comparisons.data) return <LoadingState rows={6} />

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader
            title="Access comparisons"
            description="Differential authorization: how the application behaves for one identity vs another, against the expected boundary."
            actions={
              <Button size="sm" variant="secondary" onClick={() => propose.mutate()} disabled={propose.isPending}>
                {propose.isPending ? <Loader2 className="animate-spin" /> : <Scale />} Propose comparisons
              </Button>
            }
          />
          {comparisons.data.length === 0 ? (
            <EmptyState compact icon={Scale} title="No comparisons yet" description="Declare identities, resources and invariants, establish sessions, then propose comparisons to test the boundaries between them." />
          ) : (
            <ul className="divide-y divide-border">
              {comparisons.data.map((c) => (
                <li key={c.id}>
                  <button type="button" data-testid="access-comparison" onClick={() => setSelected(c.id)} className="flex w-full flex-wrap items-start gap-x-4 gap-y-1.5 px-4 py-3 text-left hover:bg-surface-hover">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{c.dimension}</Badge>
                        <span className="text-sm font-medium text-foreground">{subjectOf(c)}</span>
                        <Badge tone={RESULT[c.result].tone} dot>
                          {RESULT[c.result].label}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-subtle text-break">{c.resultReason || c.title}</p>
                      <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                        <span>resource {c.resourceRef}</span>
                        <span>· {c.resourceRelationship}</span>
                        <span>· controls: {c.controls.positive ? '+pos' : ''}{c.controls.negative ? ' −neg' : ''}{!c.controls.positive && !c.controls.negative ? 'none' : ''}</span>
                        {c.invariantEvaluation ? <span>· invariant {c.invariantEvaluation}</span> : null}
                      </p>
                    </div>
                    <span className="text-xs text-subtle">{formatRelative(c.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Invariants" description="Business/authorization rules and whether controlled comparisons support or contradict them." />
          {!invariants.data || invariants.data.length === 0 ? (
            <PanelBody className="text-xs text-muted">No invariants declared. Declare an invariant (e.g. “only the owner may read a document”) to evaluate it with comparisons.</PanelBody>
          ) : (
            <ul className="divide-y divide-border">
              {invariants.data.map((inv) => (
                <li key={inv.invariantRef} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-foreground">{inv.rule}</span>
                      <Badge tone={INVARIANT[inv.status].tone} dot>
                        {INVARIANT[inv.status].label}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-subtle">
                      {inv.category} · {inv.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {coverage.data ? (
        <Panel className="self-start">
          <PanelHeader title="Coverage" description="Authorization / business comparison coverage." />
          <PanelBody className="flex flex-col gap-2 text-xs text-muted">
            <Row label="Identities" value={coverage.data.entities.identities} />
            <Row label="Resources" value={coverage.data.entities.resources} />
            <Row label="Tenants" value={coverage.data.entities.tenants} />
            <Row label="Invariants" value={coverage.data.entities.invariants} />
            <div className="my-1 border-t border-border" />
            <Row label="Comparisons" value={coverage.data.comparisons.total} />
            <Row label="Inconsistent" value={coverage.data.comparisons.byResult.inconsistent ?? 0} tone="critical" />
            <Row label="Consistent" value={coverage.data.comparisons.byResult.consistent ?? 0} tone="success" />
            <Row label="Inconclusive" value={coverage.data.comparisons.byResult.inconclusive ?? 0} tone="medium" />
            <Row label="With both controls" value={coverage.data.controls.both} />
            <div className="my-1 border-t border-border" />
            <Row label="Invariants contradicted" value={coverage.data.invariants.contradicted} tone="critical" />
            <Row label="Invariants supported" value={coverage.data.invariants.supported} tone="success" />
            <Row label="Invariants not tested" value={coverage.data.invariants.notTested} />
          </PanelBody>
        </Panel>
      ) : null}

      <ComparisonDetailSheet comparisonId={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: number; tone?: BadgeTone }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className={tone === 'critical' && value > 0 ? 'font-medium text-critical' : tone === 'success' && value > 0 ? 'font-medium text-success' : 'font-mono tabular-nums text-foreground'}>{value}</span>
    </div>
  )
}

function subjectOf(c: SecurityComparison): string {
  const subject = c.arms.find((a) => a.role === 'subject')
  return `${subject?.identityRef ?? 'anonymous'} ${c.action} ${c.resourceRef}`
}

function ComparisonDetailSheet({ comparisonId, onClose }: { comparisonId: string | null; onClose: () => void }) {
  const detail = useQuery({ ...securityComparisonQuery(comparisonId ?? ''), enabled: !!comparisonId })
  if (!comparisonId) return null
  const c = detail.data?.comparison
  return (
    <Sheet open={!!comparisonId} onOpenChange={(open) => (!open ? onClose() : undefined)} eyebrow="Comparison" title={c ? RESULT[c.result].label : 'Comparison'} description={c?.resultReason}>
      {!detail.data || !c ? (
        <div className="p-4">
          <LoadingState rows={6} />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{c.dimension}</Badge>
            <Badge tone={RESULT[c.result].tone} dot>
              {RESULT[c.result].label}
            </Badge>
            <span className="text-xs text-muted">{c.resourceRelationship}</span>
            {c.invariantEvaluation ? <Badge tone={INVARIANT[c.invariantEvaluation].tone}>invariant {c.invariantEvaluation}</Badge> : null}
          </div>

          <section>
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Arms: expected vs observed</h4>
            <ul className="divide-y divide-border rounded-md border border-border">
              {c.arms.map((arm, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <Badge tone={arm.role === 'subject' ? 'info' : 'neutral'}>{arm.role}</Badge>
                  <span className="font-mono text-xs">{arm.identityRef ?? 'anonymous'}</span>
                  <span className="text-xs text-muted">expected {arm.expected.outcome} ({arm.expected.basis})</span>
                  <span className="ml-auto text-xs">
                    {arm.observation ? (
                      <Badge tone={arm.observation.responseClass === 'success' ? 'success' : arm.observation.responseClass === 'denied' || arm.observation.responseClass === 'auth-required' ? 'neutral' : 'medium'}>
                        {arm.observation.responseClass} ({arm.observation.status})
                      </Badge>
                    ) : (
                      <Badge tone={arm.status === 'blocked' ? 'critical' : 'neutral'}>{arm.status}</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {c.semanticDifferences.length > 0 ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Semantic differences</h4>
              <ul className="flex flex-col gap-1.5">
                {c.semanticDifferences.map((d, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    {d.securityRelevant ? <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-critical" /> : <span className="mt-0.5 size-3.5 shrink-0" />}
                    <span className="text-muted">
                      <span className="font-medium text-foreground">{d.aspect}</span>: {d.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {c.state ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Business state</h4>
              <p className="text-xs text-muted">
                before {c.state.before?.businessResult ?? '—'} → after {c.state.after?.businessResult ?? '—'} ({c.state.transitionObserved ? 'changed' : 'unchanged'}){c.state.expectedTransition ? ` · expected ${c.state.expectedTransition}` : ''}
              </p>
            </section>
          ) : null}

          {c.cleanup.required ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Cleanup</h4>
              <p className="text-xs">
                <Badge tone={c.cleanup.succeeded === true ? 'success' : c.cleanup.succeeded === false ? 'critical' : 'medium'}>{c.cleanup.attempted ? (c.cleanup.succeeded ? 'restored' : 'FAILED') : 'not attempted'}</Badge>{' '}
                <span className="text-muted">{c.cleanup.detail}</span>
              </p>
            </section>
          ) : null}

          <section>
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Evidence</h4>
            <ul className="flex flex-col gap-1 text-xs text-muted">
              {detail.data.evidence.map((e) => (
                <li key={e.ref}>
                  <span className="font-mono">{e.ref}</span> · {e.type}
                  {e.identityRef ? ` · as ${e.identityRef}` : ''} — {e.title}
                </li>
              ))}
              {detail.data.evidence.length === 0 ? <li>No evidence recorded.</li> : null}
            </ul>
          </section>

          {detail.data.hypothesis ? (
            <p className="text-xs text-muted">
              Linked hypothesis: <span className="text-foreground">{detail.data.hypothesis.claim}</span> ({detail.data.hypothesis.status})
            </p>
          ) : null}
        </div>
      )}
    </Sheet>
  )
}
