import type { BenchmarkFixtureResult, BenchmarkRunItem } from '@audivra/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, FlaskConical, Loader2, Play } from 'lucide-react'
import { Fragment, useState } from 'react'
import { toast } from 'sonner'
import { Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState, Notice } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { durationBetween, formatDateTime, formatDuration, formatRelative, titleCase } from '@/lib/format'
import { queryKeys } from '@/lib/queries'
import { cn } from '@/lib/utils'

const RUN_TONE: Record<BenchmarkRunItem['status'], BadgeTone> = {
  running: 'running',
  completed: 'success',
  failed: 'critical',
}

function ratio(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : '—'
}

export function RunBenchmarkButton({ disabled }: { disabled?: boolean }) {
  const queryClient = useQueryClient()
  const run = useMutation({
    mutationFn: api.runBenchmark,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.benchmarks })
      toast('Benchmark queued', { description: 'Fixture audits run one after another in the worker.' })
    },
    onError: (error) => toast.error('Could not start the benchmark', { description: error.message }),
  })
  return (
    <ConfirmDialog
      title="Run the quality benchmark?"
      confirmLabel="Run benchmark"
      onConfirm={() => run.mutate()}
      trigger={
        <Button disabled={disabled || run.isPending}>
          {run.isPending ? <Loader2 className="animate-spin" /> : <Play />}
          Run benchmark
        </Button>
      }
    >
      <p>
        Audivra audits the local fixture sites with known, planted issues and scores the results: issues found and
        missed, findings that were not real, findings without evidence, and severity accuracy.
      </p>
      <p className="mt-2">
        Each fixture is a full AI audit, so this takes a while and consumes Claude Code usage. Benchmark audits are
        hidden from the audit list by default.
      </p>
    </ConfirmDialog>
  )
}

function Totals({ run }: { run: BenchmarkRunItem }) {
  const t = run.totals
  if (!t) return null
  const cells = [
    { label: 'Known issues found', value: `${t.found}/${t.known}`, detail: ratio(t.found, t.known), tone: '' },
    { label: 'Missed', value: t.missed, detail: 'Planted issues not reported', tone: t.missed ? 'text-medium' : '' },
    {
      label: 'False positives',
      value: t.falsePositives,
      detail: 'Findings that were not real',
      tone: t.falsePositives ? 'text-critical' : '',
    },
    {
      label: 'Unsupported',
      value: t.unsupported,
      detail: 'Findings without usable evidence',
      tone: t.unsupported ? 'text-high' : '',
    },
    { label: 'Severity correct', value: `${t.severityCorrect}/${t.found}`, detail: ratio(t.severityCorrect, t.found), tone: '' },
    {
      label: 'Avg. audit',
      value: formatDuration(t.avgDurationMs),
      detail: t.avgAuditorTurns !== null ? `${Math.round(t.avgAuditorTurns)} auditor turns` : 'Auditor turns unknown',
      tone: '',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-6">
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0 bg-surface px-4 py-3">
          <div className="truncate text-xs text-muted">{cell.label}</div>
          <div className={cn('mt-1 font-mono text-xl font-medium text-foreground tabular-nums', cell.tone)}>
            {cell.value}
          </div>
          <div className="mt-0.5 truncate text-xs text-subtle">{cell.detail}</div>
        </div>
      ))}
    </div>
  )
}

function FixtureDetail({ fixture }: { fixture: BenchmarkFixtureResult }) {
  return (
    <div className="grid gap-4 bg-surface-muted px-4 py-3 lg:grid-cols-2">
      <div>
        <SectionLabel>Known issues</SectionLabel>
        {fixture.issues.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {fixture.issues.map((issue) => (
              <li key={issue.id} className="flex gap-2">
                <span
                  className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', issue.found ? 'bg-success' : 'bg-medium')}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 text-foreground">
                  {issue.description}
                  <span className="ml-1.5 text-xs text-muted">
                    {issue.found
                      ? `found${issue.matchedFindingRef ? ` as ${issue.matchedFindingRef}` : ''}${
                          issue.severityCorrect === false
                            ? ` · severity ${issue.severityActual ?? '?'} (expected ${issue.severityExpected.join(' or ')})`
                            : ''
                        }${issue.evidenceLinked === false ? ' · no evidence linked' : ''}`
                      : 'missed'}
                    {issue.deterministic ? ' · baseline-detectable' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No planted issues: every finding is checked as a possible false positive.</p>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {fixture.falsePositiveDetails.length ? (
          <div>
            <SectionLabel>False positives</SectionLabel>
            <ul className="flex flex-col gap-1 text-sm">
              {fixture.falsePositiveDetails.map((item) => (
                <li key={item.ref} className="text-foreground">
                  <span className="mr-1.5 font-mono text-xs text-subtle">{item.ref}</span>
                  {item.title}
                  <span className="block text-xs text-muted">{item.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {fixture.unsupportedDetails.length ? (
          <div>
            <SectionLabel>Unsupported findings</SectionLabel>
            <ul className="flex flex-col gap-1 text-sm">
              {fixture.unsupportedDetails.map((item) => (
                <li key={item.ref} className="text-foreground">
                  <span className="mr-1.5 font-mono text-xs text-subtle">{item.ref}</span>
                  {item.title}
                  <span className="block text-xs text-muted">{item.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {fixture.error ? <p className="text-sm text-critical">{fixture.error}</p> : null}
        {!fixture.falsePositiveDetails.length && !fixture.unsupportedDetails.length && !fixture.error ? (
          <p className="text-sm text-muted">No false positives or unsupported findings.</p>
        ) : null}
      </div>
    </div>
  )
}

function FixtureTable({ run }: { run: BenchmarkRunItem }) {
  const [open, setOpen] = useState<string | null>(null)
  const head = ['Fixture', 'Status', 'Found', 'Missed', 'False pos.', 'Unsupported', 'Severity', 'Evidence', 'Duration', '']
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-180 border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            {head.map((label, index) => (
              <th
                key={index}
                scope="col"
                className={cn(
                  'h-8 bg-surface-muted px-3 text-xs font-medium whitespace-nowrap text-muted first:pl-4 last:pr-4',
                  index >= 2 && index <= 8 ? 'text-right' : 'text-left',
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.fixtures.map((fixture) => {
            const expanded = open === fixture.fixture
            return (
              <Fragment key={fixture.fixture}>
                <tr className="border-b border-border">
                  <th scope="row" className="h-10 px-3 pl-4 text-left font-medium text-foreground">
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : fixture.fixture)}
                      aria-expanded={expanded}
                      className="inline-flex cursor-pointer items-center gap-1.5"
                    >
                      <ChevronRight className={cn('size-3.5 text-subtle transition-transform', expanded && 'rotate-90')} />
                      {fixture.fixture}
                    </button>
                    {fixture.healthy && fixture.known === 0 ? (
                      <Badge tone="neutral" className="ml-2">
                        Control
                      </Badge>
                    ) : null}
                  </th>
                  <td className="px-3 text-xs whitespace-nowrap text-muted">{titleCase(fixture.status)}</td>
                  <td className="px-3 text-right font-mono text-xs tabular-nums">
                    {fixture.found}/{fixture.known}
                  </td>
                  <td className={cn('px-3 text-right font-mono text-xs tabular-nums', fixture.missed ? 'text-medium' : 'text-subtle')}>
                    {fixture.missed}
                  </td>
                  <td
                    className={cn(
                      'px-3 text-right font-mono text-xs tabular-nums',
                      fixture.falsePositives ? 'text-critical' : 'text-subtle',
                    )}
                  >
                    {fixture.falsePositives}
                  </td>
                  <td className={cn('px-3 text-right font-mono text-xs tabular-nums', fixture.unsupported ? 'text-high' : 'text-subtle')}>
                    {fixture.unsupported}
                  </td>
                  <td className="px-3 text-right font-mono text-xs text-muted tabular-nums">
                    {fixture.severityCorrect}/{fixture.found}
                  </td>
                  <td className="px-3 text-right font-mono text-xs text-muted tabular-nums">
                    {fixture.evidenceLinked}/{fixture.found}
                  </td>
                  <td className="px-3 text-right font-mono text-xs whitespace-nowrap text-muted tabular-nums">
                    {formatDuration(fixture.durationMs)}
                  </td>
                  <td className="px-3 pr-4 text-right">
                    {fixture.auditId ? (
                      <Link
                        to="/audits/$auditId"
                        params={{ auditId: fixture.auditId }}
                        className="text-xs whitespace-nowrap text-link hover:underline"
                      >
                        Audit
                      </Link>
                    ) : null}
                  </td>
                </tr>
                {expanded ? (
                  <tr className="border-b border-border">
                    <td colSpan={head.length} className="p-0">
                      <FixtureDetail fixture={fixture} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Benchmark runs: detection quality of the AI audit against fixture sites with known issues. */
export function QualityPanel({
  runs,
  isLoading,
  error,
  onRetry,
}: {
  runs: BenchmarkRunItem[]
  isLoading: boolean
  error: unknown
  onRetry: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  if (error) {
    return (
      <Panel>
        <ErrorState title="Could not load benchmark runs" error={error} onRetry={onRetry} />
      </Panel>
    )
  }
  if (isLoading) {
    return (
      <Panel>
        <LoadingState rows={4} />
      </Panel>
    )
  }
  if (!runs.length) {
    return (
      <Panel>
        <EmptyState
          icon={FlaskConical}
          title="No benchmark runs yet"
          description="The benchmark audits local fixture sites with planted issues and measures what the AI finds, misses or gets wrong. Results appear here."
          action={<RunBenchmarkButton />}
        />
      </Panel>
    )
  }
  const run = runs.find((r) => r.id === selectedId) ?? runs[0]!
  const running = runs.some((r) => r.status === 'running')
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {runs.length > 1 ? (
          <Select
            label="Run"
            value={run.id}
            onValueChange={setSelectedId}
            options={runs.map((r) => ({ value: r.id, label: `${formatDateTime(r.startedAt)} · ${titleCase(r.status)}` }))}
          />
        ) : null}
        <Badge tone={RUN_TONE[run.status]} dot>
          {titleCase(run.status)}
        </Badge>
        <span className="text-xs text-muted">
          Started {formatRelative(run.startedAt)} · {formatDuration(durationBetween(run.startedAt, run.finishedAt))}
          {run.model ? <span className="font-mono"> · {run.model}</span> : null}
        </span>
      </div>
      {run.status === 'running' ? (
        <Notice icon={Loader2} iconClassName="animate-spin" title="Benchmark running">
          Fixture audits run one after another; results fill in as each finishes.
        </Notice>
      ) : null}
      {run.error ? (
        <Notice tone="critical" icon={FlaskConical} title="Benchmark failed">
          {run.error}
        </Notice>
      ) : null}
      <Totals run={run} />
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Fixtures"
          description="Expand a fixture to see each planted issue and every finding that did not hold up"
          actions={running ? null : <RunBenchmarkButton />}
        />
        {run.fixtures.length ? (
          <FixtureTable run={run} />
        ) : (
          <EmptyState compact title="No fixture results yet" />
        )}
      </Panel>
      {Object.keys(run.promptVersions).length ? (
        <Panel>
          <PanelHeader title="Prompt versions" description="Compare runs only when these match" />
          <PanelBody className="flex flex-wrap gap-x-6 gap-y-1">
            {Object.entries(run.promptVersions).map(([role, version]) => (
              <span key={role} className="text-xs text-muted">
                {titleCase(role)} <span className="font-mono text-foreground">{version}</span>
              </span>
            ))}
          </PanelBody>
        </Panel>
      ) : null}
    </div>
  )
}
