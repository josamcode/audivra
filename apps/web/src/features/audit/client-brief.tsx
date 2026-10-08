import {
  BRIEF_MODE_LABELS,
  briefText,
  type AuditDetail,
  type BriefIssue,
  type BriefMode,
  type BriefProof,
  type ClientBriefContent,
} from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { ClipboardCopy, Copy, Loader2, NotebookPen, RefreshCw, type LucideIcon, type LucideProps } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { SectionLabel } from '@/components/panel'
import { EmptyState, LoadingState, Notice } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Sheet } from '@/components/ui/sheet'
import { useAuditNav } from '@/features/audit/audit-nav'
import { RefChip } from '@/features/audit/journey-flow'
import { useEnrichMutation, useRefreshAfterEnrich } from '@/features/audit/use-enrich'
import { formatRelative } from '@/lib/format'
import { briefQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const Spinner = ((props: LucideProps) => <Loader2 {...props} className={cn(props.className, 'animate-spin')} />) as LucideIcon

const PRIORITY: Record<'now' | 'next' | 'later', { label: string; tone: 'critical' | 'medium' | 'neutral' }> = {
  now: { label: 'Now', tone: 'critical' },
  next: { label: 'Next', tone: 'medium' },
  later: { label: 'Later', tone: 'neutral' },
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}`, { description: 'The browser blocked clipboard access.' })
  }
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <SectionLabel>{title}</SectionLabel>
      <div className="text-sm text-foreground">{children}</div>
    </section>
  )
}

/** Finding/evidence/journey references that open the audit at that item. */
function Refs({ refs, onOpen }: { refs: (string | null | undefined)[]; onOpen: (ref: string) => void }) {
  const list = refs.filter((r): r is string => Boolean(r))
  if (!list.length) return null
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {list.map((ref) => (
        <RefChip key={ref} value={ref} onClick={() => onOpen(ref)} />
      ))}
    </span>
  )
}

function Issues({ issues, onOpen }: { issues: BriefIssue[]; onOpen: (ref: string) => void }) {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-subtle">
      {issues.map((issue) => (
        <li key={issue.findingId}>
          <span className="font-medium" dir="auto">
            {issue.headline}
          </span>
          <Refs refs={[issue.findingId]} onOpen={onOpen} />
          <p className="text-muted" dir="auto">
            {issue.why}
          </p>
        </li>
      ))}
    </ol>
  )
}

function Proofs({ items, onOpen }: { items: BriefProof[]; onOpen: (ref: string) => void }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((proof, index) => (
        <li key={index} className="flex gap-2">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-subtle" aria-hidden />
          <span dir="auto">
            {proof.text}
            <Refs refs={[proof.findingId, proof.evidenceId]} onOpen={onOpen} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-subtle" aria-hidden />
          <span dir="auto">{item}</span>
        </li>
      ))}
    </ul>
  )
}

function BriefBody({ content, mode, onOpen }: { content: ClientBriefContent; mode: BriefMode; onOpen: (ref: string) => void }) {
  if (mode === 'quick') {
    const { quick } = content
    return (
      <div className="flex flex-col gap-5">
        <Block title="The business">
          <p dir="auto">{content.businessSummary}</p>
          <p className="mt-1 text-muted" dir="auto">
            Primary conversion: <span className="text-foreground">{content.primaryConversion}</span>
          </p>
        </Block>
        {content.primaryJourney ? (
          <Block title="Primary journey">
            <p dir="auto">
              {content.primaryJourney.path}
              <Refs refs={[content.primaryJourney.journeyId]} onOpen={onOpen} />
            </p>
            <p className="mt-1 text-muted" dir="auto">
              Biggest friction: <span className="text-foreground">{content.primaryJourney.biggestFriction}</span>
            </p>
          </Block>
        ) : null}
        <Block title="Top issues">
          <Issues issues={quick.topIssues} onOpen={onOpen} />
        </Block>
        {quick.bestOpportunity ? (
          <Block title="Best opportunity">
            <p className="font-medium" dir="auto">
              {quick.bestOpportunity.title}
              <Refs refs={quick.bestOpportunity.findingIds} onOpen={onOpen} />
            </p>
            <p className="text-muted" dir="auto">
              {quick.bestOpportunity.why}
            </p>
          </Block>
        ) : null}
        {quick.proofPoints.length ? (
          <Block title="Proof points">
            <Proofs items={quick.proofPoints} onOpen={onOpen} />
          </Block>
        ) : null}
        <Block title="Suggested opener">
          <p className="rounded-md border border-border bg-surface-muted px-3.5 py-3" dir="auto">
            {quick.suggestedOpener}
          </p>
        </Block>
      </div>
    )
  }
  if (mode === 'meeting') {
    const { meeting } = content
    return (
      <div className="flex flex-col gap-5">
        <Block title="Context">
          <p dir="auto">{meeting.context}</p>
        </Block>
        {meeting.journeys.length ? (
          <Block title="Journeys">
            <ul className="flex flex-col gap-1.5">
              {meeting.journeys.map((journey) => (
                <li key={journey.journeyId} dir="auto">
                  <Refs refs={[journey.journeyId]} onOpen={onOpen} /> {journey.summary}
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
        {meeting.topIssues.length ? (
          <Block title="Top issues">
            <Issues issues={meeting.topIssues} onOpen={onOpen} />
          </Block>
        ) : null}
        {meeting.sinceLastAudit.length ? (
          <Block title="Since the last audit">
            <Bullets items={meeting.sinceLastAudit} />
          </Block>
        ) : null}
        {meeting.questions.length ? (
          <Block title="Questions to ask">
            <ul className="flex flex-col gap-2">
              {meeting.questions.map((q, index) => (
                <li key={index}>
                  <p className="font-medium" dir="auto">
                    {q.question}
                  </p>
                  <p className="text-xs text-muted" dir="auto">
                    Why ask: {q.basis}
                  </p>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
        {meeting.uncertainties.length ? (
          <Block title="What the audit could not establish">
            <Bullets items={meeting.uncertainties} />
          </Block>
        ) : null}
        {meeting.opportunities.length ? (
          <Block title="Opportunities">
            <ul className="flex flex-col gap-1.5">
              {meeting.opportunities.map((o, index) => (
                <li key={index}>
                  <span className="font-medium" dir="auto">
                    {o.title}
                  </span>
                  <p className="text-muted" dir="auto">
                    {o.why}
                  </p>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
        {meeting.proofToShow.length ? (
          <Block title="Proof to show">
            <Proofs items={meeting.proofToShow} onOpen={onOpen} />
          </Block>
        ) : null}
      </div>
    )
  }
  if (mode === 'talking-points') {
    return (
      <ol className="flex list-decimal flex-col gap-2.5 pl-5 text-sm marker:text-subtle">
        {content.talkingPoints.map((point, index) => (
          <li key={index} dir="auto">
            {point}
          </li>
        ))}
      </ol>
    )
  }
  return content.technical.items.length ? (
    <ul className="flex flex-col divide-y divide-border">
      {content.technical.items.map((item) => (
        <li key={item.findingId} className="py-3.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PRIORITY[item.priority].tone}>{PRIORITY[item.priority].label}</Badge>
            <RefChip value={item.findingId} onClick={() => onOpen(item.findingId)} />
            <span className="text-sm font-medium text-foreground" dir="auto">
              {item.title}
            </span>
          </div>
          <dl className="mt-2 grid gap-1.5 text-sm">
            {(
              [
                ['Evidence', item.evidence],
                ['Likely cause', item.likelyCause],
                ['Direction', item.direction],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="grid gap-x-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-foreground text-break" dir="auto">
                  {value}
                </dd>
              </div>
            ))}
            {item.pages.length ? (
              <div className="grid gap-x-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
                <dt className="text-xs text-muted">Pages</dt>
                <dd className="font-mono text-xs break-all text-muted">{item.pages.join(' · ')}</dd>
              </div>
            ) : null}
          </dl>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted">No technical items: the audit has no finding that needs implementation detail.</p>
  )
}

/**
 * Client brief: preparation for talking to the client about this audit (quick brief, meeting prep,
 * talking points, technical brief). Generated on request from the finalized audit; nothing is sent.
 */
export function ClientBriefSheet({ audit, open, onOpenChange }: { audit: AuditDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const nav = useAuditNav()
  const [mode, setMode] = useState<BriefMode>('quick')
  const query = useQuery({ ...briefQuery(audit.id), enabled: open })
  const generate = useEnrichMutation(audit.id, 'brief')
  const status = query.data?.status
  const brief = query.data?.brief
  useRefreshAfterEnrich(audit.id, 'brief', status?.running)
  const running = Boolean(status?.running) || generate.isPending
  const site = audit.clientName ?? audit.domain

  const openRef = (ref: string) => {
    onOpenChange(false)
    if (/^EV-/i.test(ref)) nav?.openEvidence(ref)
    else if (/^J\d+$/i.test(ref)) nav?.openJourney(ref)
    else nav?.openFinding(ref)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-3xl"
      title="Client brief"
      description={
        brief
          ? `For talking to ${site}. Generated ${formatRelative(brief.createdAt)} from the finalized audit; nothing is sent anywhere.`
          : `Prepares you to talk to ${site}, from the finalized audit. Nothing is sent anywhere.`
      }
      actions={
        brief && status?.available ? (
          <Button size="sm" variant="ghost" onClick={() => generate.mutate()} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {running ? 'Regenerating…' : 'Regenerate'}
          </Button>
        ) : null
      }
    >
      {query.isError ? (
        <div className="p-5">
          <Notice tone="critical" title="Could not load the brief">
            {query.error.message}
          </Notice>
        </div>
      ) : !query.data || !status ? (
        <LoadingState rows={6} />
      ) : !brief ? (
        <div className="flex flex-col gap-3 p-5">
          {status.lastError ? (
            <Notice tone="critical" title="The last brief failed">
              {status.lastError}
            </Notice>
          ) : null}
          {running ? (
            <EmptyState icon={Spinner} title="Writing the brief…" description="Claude is reading the finalized findings, journeys and history. This takes a minute or two." />
          ) : (
            <EmptyState
              icon={NotebookPen}
              title="No brief yet"
              description={
                status.available
                  ? 'One generation gives all four views: a quick brief, meeting prep, talking points and a technical brief. Every point cites the audit.'
                  : status.reason
              }
              action={
                status.available ? (
                  <Button size="sm" variant="primary" onClick={() => generate.mutate()}>
                    <NotebookPen />
                    Generate brief
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
            <SegmentedControl
              label="Brief view"
              value={mode}
              onValueChange={setMode}
              options={(Object.keys(BRIEF_MODE_LABELS) as BriefMode[]).map((value) => ({ value, label: BRIEF_MODE_LABELS[value] }))}
            />
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => void copy(briefText(brief.content, mode, site), BRIEF_MODE_LABELS[mode])}>
              <Copy />
              Copy brief
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copy(briefText(brief.content, 'talking-points', site), 'Talking points')}>
              <ClipboardCopy />
              Copy talking points
            </Button>
          </div>
          {status.lastError ? (
            <div className="px-5 pt-4">
              <Notice tone="critical" title="The last regeneration failed; showing the previous brief">
                {status.lastError}
              </Notice>
            </div>
          ) : null}
          <div className="px-5 py-5">
            <BriefBody content={brief.content} mode={mode} onOpen={openRef} />
          </div>
        </div>
      )}
    </Sheet>
  )
}
