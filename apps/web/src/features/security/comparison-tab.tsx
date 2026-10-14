import { type AttackPathDiffEntry, type FindingComparisonClass, type FindingComparisonEntry, type SecurityAssessmentComparison, type SecurityEngagementDetail } from '@audivra/contracts'
import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { SeverityBadge } from '@/components/badges'
import { Metric } from '@/components/metric'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { ErrorState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, historyExportUrl } from '@/lib/api'

/*
 * Phase 6C — the Assessment Comparison view. Pick a previous assessment and compare: the summary separates
 * new / still-present / fixed / regressed / changed / cannot-reproduce / not-tested, a coverage banner warns
 * when less was measured, and the attack-path history shows removed verified edges, new edges and impact
 * changes. "Fixed" is only ever shown when a retest proved it — never "not found again".
 */

const CLASS_TONE: Record<FindingComparisonClass, BadgeTone> = {
  new: 'info',
  'still-present': 'high',
  fixed: 'success',
  changed: 'medium',
  regressed: 'critical',
  'cannot-reproduce': 'medium',
  'not-tested': 'neutral',
  'unmatched-historical': 'neutral',
}

function FindingChangeRow({ entry }: { entry: FindingComparisonEntry }) {
  const side = entry.current ?? entry.previous
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-1.5 pr-3 align-top">
        <Badge tone={CLASS_TONE[entry.class]} dot>
          {entry.class}
        </Badge>
      </td>
      <td className="py-1.5 pr-3 align-top">{side ? <SeverityBadge severity={side.severity} /> : null}</td>
      <td className="min-w-0 py-1.5 pr-3 align-top">
        <div className="truncate text-xs font-medium text-fg">{side?.title ?? entry.match.previousIssueKey ?? entry.match.currentIssueKey}</div>
        <div className="truncate text-2xs text-subtle">{entry.reason}</div>
        {entry.changes.length ? <div className="text-2xs text-medium">{entry.changes.map((c) => `${c.aspect}: ${c.from} → ${c.to}`).join(' · ')}</div> : null}
      </td>
      <td className="py-1.5 align-top text-2xs text-subtle">{entry.match.basis}</td>
    </tr>
  )
}

function PathChangeRow({ entry }: { entry: AttackPathDiffEntry }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge tone={entry.class === 'regressed' ? 'critical' : entry.class === 'still-present' ? 'high' : entry.class === 'disappeared' ? 'neutral' : 'medium'} dot>
          {entry.class}
        </Badge>
        <span className="truncate text-xs font-medium text-fg">{entry.title}</span>
        {entry.impactChange ? (
          <span className="text-2xs text-subtle">
            impact {entry.impactChange.from} → {entry.impactChange.to}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-2xs text-subtle">{entry.reason}</div>
      {entry.removedVerifiedEdges.length ? <div className="text-2xs text-critical">removed verified: {entry.removedVerifiedEdges.map((e) => e.label).join('; ')}</div> : null}
      {entry.newEdges.length ? <div className="text-2xs text-info">new: {entry.newEdges.map((e) => e.label).join('; ')}</div> : null}
      {entry.verificationChanges.length ? <div className="text-2xs text-medium">{entry.verificationChanges.map((c) => `${c.label}: ${c.from}→${c.to}`).join('; ')}</div> : null}
    </div>
  )
}

export function ComparisonTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const [previous, setPrevious] = useState('')
  const [comparison, setComparison] = useState<SecurityAssessmentComparison | null>(null)
  const compare = useMutation({
    mutationFn: () => api.compareAssessments(engagement.id, previous.trim(), true),
    onSuccess: (data) => setComparison(data),
  })
  const s = comparison?.summary

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Assessment comparison"
          description="Compare a previous authorized assessment with this one. A previous finding absent now is only 'fixed' when a retest proved it; otherwise it is 'not tested' or 'cannot reproduce'. A decrease in coverage is surfaced so fewer findings is never mistaken for improvement."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <input value={previous} onChange={(e) => setPrevious(e.target.value)} placeholder="previous assessment id" className="w-44 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg" />
              <Button size="sm" onClick={() => compare.mutate()} disabled={compare.isPending || previous.trim().length < 6}>
                {compare.isPending ? 'Comparing…' : 'Compare'}
              </Button>
              {comparison ? (
                <a href={historyExportUrl(engagement.id, comparison.previousEngagementId, 'json')} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                  <Download className="size-3.5" /> JSON
                </a>
              ) : null}
            </div>
          }
        />
        {s ? (
          <PanelBody className="flex flex-wrap gap-x-7 gap-y-3">
            <Metric label="New" value={s.new} tone={s.new ? 'high' : 'muted'} />
            <Metric label="Still present" value={s.stillPresent} tone={s.stillPresent ? 'high' : 'muted'} />
            <Metric label="Fixed" value={s.fixed} tone={s.fixed ? 'success' : 'muted'} />
            <Metric label="Regressed" value={s.regressed} tone={s.regressed ? 'critical' : 'muted'} />
            <Metric label="Changed" value={s.changed} tone="default" />
            <Metric label="Cannot reproduce" value={s.cannotReproduce} tone="medium" />
            <Metric label="Not tested" value={s.notTested} tone="muted" />
          </PanelBody>
        ) : (
          <PanelBody className="text-xs text-subtle">{compare.isError ? <ErrorState title="Could not compare" error={compare.error} onRetry={() => compare.mutate()} /> : 'Enter a previous assessment id and compare.'}</PanelBody>
        )}
      </Panel>

      {comparison && comparison.coverage.coverageRegressed ? (
        <div className="rounded-md border border-medium/40 bg-medium/10 px-3 py-2 text-xs text-medium">
          Coverage decreased from the previous assessment: {comparison.coverage.notes.join('; ')}. Interpret fewer findings with caution.
        </div>
      ) : null}

      {comparison ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,26rem)]">
          <Panel>
            <PanelHeader title={`Finding changes (${comparison.findingChanges.length})`} />
            <PanelBody>
              {comparison.findingChanges.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-2xs tracking-wide text-subtle uppercase">
                      <th className="pb-1 pr-3 text-left font-medium">Change</th>
                      <th className="pb-1 pr-3 text-left font-medium">Severity</th>
                      <th className="pb-1 pr-3 text-left font-medium">Finding</th>
                      <th className="pb-1 text-left font-medium">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.findingChanges.map((entry, i) => (
                      <FindingChangeRow key={i} entry={entry} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-xs text-subtle">No finding changes.</div>
              )}
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title={`Attack-path history (${comparison.pathChanges.length})`} description="Before/after routes: removed verified edges, new edges and impact changes. A path not rediscovered is reported, never claimed fixed." />
            <PanelBody className="flex flex-col gap-2">
              {comparison.pathChanges.length ? comparison.pathChanges.map((entry, i) => <PathChangeRow key={i} entry={entry} />) : <div className="text-xs text-subtle">No tracked path changes.</div>}
            </PanelBody>
          </Panel>
        </div>
      ) : null}
    </div>
  )
}
