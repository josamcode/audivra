import type { Artifact, EvidenceItem, FindingItem } from '@audivra/contracts'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Briefcase, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  Confidence,
  EvidenceTypeIcon,
  FindingTypeBadge,
  LevelText,
  SeverityBadge,
  VERIFICATION,
} from '@/components/badges'
import { AppArtifact } from '@/components/artifact-card'
import { RichText } from '@/components/rich-text'
import { EvidenceViewer, isImageArtifact } from '@/components/evidence-viewer'
import { SectionLabel } from '@/components/panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/separator'
import { Sheet } from '@/components/ui/sheet'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <SectionLabel>{title}</SectionLabel>
      <div className="text-sm leading-relaxed text-foreground text-break">
        {typeof children === 'string' ? <RichText text={children} className="gap-2" /> : children}
      </div>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="text-2xs text-subtle">{label}</div>
      <div className="mt-0.5 flex min-h-5 items-center">{children}</div>
    </div>
  )
}

function EvidenceChip({
  evidenceRef,
  item,
  active,
  onClick,
}: {
  evidenceRef: string
  item: EvidenceItem | undefined
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-colors',
        active
          ? 'border-border-strong bg-surface-selected text-foreground'
          : 'border-border bg-surface text-muted hover:border-border-strong hover:text-foreground',
      )}
    >
      {item ? <EvidenceTypeIcon type={item.type} /> : null}
      <span className="shrink-0 font-mono font-medium">{evidenceRef}</span>
      {item ? <span className="truncate">{item.title}</span> : <span className="text-subtle">missing</span>}
    </button>
  )
}

export function FindingDrawer({
  auditId,
  finding,
  evidence,
  findings,
  visuals = [],
  onClose,
  onSelect,
}: {
  auditId: string
  finding: FindingItem | null
  evidence: EvidenceItem[]
  /** Ordered list used for previous/next navigation. */
  findings: FindingItem[]
  /** Visual artifacts of the audit; the finding's artifactRefs are shown as visual proof. */
  visuals?: Artifact[]
  onClose: () => void
  onSelect: (ref: string) => void
}) {
  // Keep rendering the last finding while the drawer animates closed.
  const [lastFinding, setLastFinding] = useState(finding)
  if (finding && finding !== lastFinding) setLastFinding(finding)
  const shown = finding ?? lastFinding
  const byRef = new Map(evidence.map((item) => [item.ref, item]))
  const index = finding ? findings.findIndex((f) => f.ref === finding.ref) : -1
  const previous = index > 0 ? findings[index - 1] : undefined
  const next = index >= 0 && index < findings.length - 1 ? findings[index + 1] : undefined

  useEffect(() => {
    if (!finding) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if ((event.key === 'j' || event.key === 'ArrowDown') && next) {
        event.preventDefault()
        onSelect(next.ref)
      } else if ((event.key === 'k' || event.key === 'ArrowUp') && previous) {
        event.preventDefault()
        onSelect(previous.ref)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finding, next, previous, onSelect])

  return (
    <Sheet
      open={finding !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={shown?.title ?? ''}
      eyebrow={
        shown ? (
          <>
            <span className="font-mono text-xs font-medium text-muted">{shown.ref}</span>
            <SeverityBadge severity={shown.severity} className="w-auto" />
            <Badge tone="neutral">{shown.category}</Badge>
            <FindingTypeBadge type={shown.type} />
          </>
        ) : null
      }
      actions={
        <div className="flex items-center">
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Previous <Kbd>k</Kbd>
              </span>
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!previous}
              onClick={() => previous && onSelect(previous.ref)}
              aria-label="Previous finding"
            >
              <ChevronUp />
            </Button>
          </Tooltip>
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Next <Kbd>j</Kbd>
              </span>
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!next}
              onClick={() => next && onSelect(next.ref)}
              aria-label="Next finding"
            >
              <ChevronDown />
            </Button>
          </Tooltip>
        </div>
      }
    >
      {shown ? (
        <FindingBody key={shown.ref} auditId={auditId} finding={shown} byRef={byRef} visuals={visuals} />
      ) : null}
    </Sheet>
  )
}

function FindingBody({
  auditId,
  finding,
  byRef,
  visuals,
}: {
  auditId: string
  finding: FindingItem
  byRef: Map<string, EvidenceItem>
  visuals: Artifact[]
}) {
  // Visual proof: artifacts that visualize this finding (annotated screenshots, charts, tables).
  const proof = finding.artifactRefs
    .map((ref) => visuals.find((artifact) => artifact.ref === ref))
    .filter((artifact): artifact is Artifact => Boolean(artifact))
  // Without a visual, open the first screenshot (else the first evidence) so proof is visible at once.
  const firstScreenshot = finding.evidenceRefs.find((ref) => isImageArtifact(byRef.get(ref)?.artifactPath))
  const [activeEvidence, setActiveEvidence] = useState<string | null>(
    proof.length ? null : (firstScreenshot ?? finding.evidenceRefs[0] ?? null),
  )
  return (
    <div className="flex flex-col gap-6 px-5 py-5">
      <div className="grid grid-cols-2 divide-x divide-y divide-border rounded-md border border-border sm:grid-cols-4 sm:divide-y-0">
        <Fact label="Severity">
          <SeverityBadge severity={finding.severity} className="w-auto" />
        </Fact>
        <Fact label="Confidence">
          <Confidence value={finding.confidence} />
        </Fact>
        <Fact label="Verification">
          <span className="text-sm text-foreground" title={VERIFICATION[finding.verificationStatus].hint}>
            {VERIFICATION[finding.verificationStatus].label}
          </span>
        </Fact>
        <Fact label="Business impact">
          <LevelText level={finding.businessImpactLevel} kind="impact" />
        </Fact>
      </div>

      <Section title="Problem">{finding.description}</Section>
      <Section title="What was observed">{finding.observed}</Section>

      {proof.length ? (
        <section>
          <SectionLabel>Visual proof</SectionLabel>
          <div className="flex flex-col gap-3">
            {proof.map((artifact) => (
              <AppArtifact key={artifact.id} artifact={artifact} auditId={auditId} />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <SectionLabel className="mb-0">Evidence</SectionLabel>
          {activeEvidence ? (
            <Link
              to="/audits/$auditId"
              params={{ auditId }}
              search={{ tab: 'evidence', ev: activeEvidence }}
              className="inline-flex items-center gap-1 text-xs text-link hover:underline"
            >
              Open in evidence
              <ArrowUpRight className="size-3" />
            </Link>
          ) : null}
        </div>
        {finding.evidenceRefs.length === 0 ? (
          <p className="text-sm text-muted">
            No evidence is linked to this finding. Treat it as an unproven lead.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {finding.evidenceRefs.map((ref) => (
                <EvidenceChip
                  key={ref}
                  evidenceRef={ref}
                  item={byRef.get(ref)}
                  active={activeEvidence === ref}
                  onClick={() => setActiveEvidence(activeEvidence === ref ? null : ref)}
                />
              ))}
            </div>
            {activeEvidence ? (
              <div className="mt-3 rounded-md border border-border p-3.5">
                <EvidenceViewer
                  key={activeEvidence}
                  auditId={auditId}
                  evidenceRef={activeEvidence}
                  excludeFinding={finding.ref}
                />
              </div>
            ) : null}
          </>
        )}
      </section>

      {finding.affectedUrls.length ? (
        <section>
          <SectionLabel>Affected pages</SectionLabel>
          <ul className="flex flex-col gap-1">
            {finding.affectedUrls.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-link hover:underline"
                >
                  <span className="text-break">{url}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Section title="Why it matters">{finding.whyItMatters}</Section>
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <SectionLabel className="mb-0">Business impact</SectionLabel>
          <LevelText level={finding.businessImpactLevel} kind="impact" />
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-line text-foreground text-break">
          {finding.businessImpact}
        </p>
      </section>
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <SectionLabel className="mb-0">Recommended fix</SectionLabel>
          <LevelText level={finding.effort} kind="effort" />
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-line text-foreground text-break">
          {finding.recommendation}
        </p>
      </section>

      {finding.opportunity ? (
        <section className="rounded-md border border-border bg-surface-muted p-3.5">
          <div className="flex items-start gap-2.5">
            <Briefcase className="mt-0.5 size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-2xs font-semibold tracking-wide text-subtle uppercase">
                  Opportunity
                </span>
                <LevelText level={finding.opportunity.impact} kind="impact" />
                <LevelText level={finding.opportunity.effort} kind="effort" />
              </div>
              <p className="mt-1 text-sm font-medium text-foreground">{finding.opportunity.title}</p>
              <p className="mt-0.5 text-sm text-muted">{finding.opportunity.description}</p>
            </div>
          </div>
        </section>
      ) : null}

      <p className="border-t border-border pt-3 text-2xs text-subtle">
        Created by {finding.createdBy} ·{' '}
        {finding.type === 'inference' ? 'Inference — not directly observed.' : 'Backed by recorded evidence.'}
      </p>
    </div>
  )
}
