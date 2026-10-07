import type { Artifact, EvidenceItem, FindingItem, ToolRunItem } from '@audivra/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Braces, Download, ExternalLink, FileText, Wrench } from 'lucide-react'
import { useState } from 'react'
import { AppArtifact } from '@/components/artifact-card'
import { EvidenceTypeBadge, SeverityBadge } from '@/components/badges'
import { ArtifactAuditContext, MetadataView } from '@/components/metadata-view'
import { SectionLabel } from '@/components/panel'
import { ScreenshotViewer } from '@/components/screenshot-viewer'
import { ErrorState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuditNav } from '@/features/audit/audit-nav'
import { artifactUrl } from '@/lib/api'
import { formatDateTime, formatDuration, titleCase } from '@/lib/format'
import { evidenceItemQuery, findingsQuery, queryKeys, toolRunsQuery, visualsQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i
const TEXT_EXT = /\.(json|txt|log|md|mjs|cjs|js|ts|csv|xml|yaml|yml|har|sh)$/i
const REPORT_EXT = /\.html?$/i
const PREVIEW_LINES = 200
const PREVIEW_BYTES = 400_000

export function isImageArtifact(path: string | null | undefined): boolean {
  return Boolean(path && IMAGE_EXT.test(path))
}

function TextPreview({ auditId, path }: { auditId: string; path: string }) {
  const url = artifactUrl(auditId, path)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['artifact-text', auditId, path],
    staleTime: Infinity,
    queryFn: async () => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = (await response.text()).slice(0, PREVIEW_BYTES)
      let pretty = text
      if (/\.json$/i.test(path)) {
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2)
        } catch {
          // truncated or invalid JSON: show as-is
        }
      }
      const lines = pretty.split('\n')
      return { text: lines.slice(0, PREVIEW_LINES).join('\n'), totalLines: lines.length }
    },
  })
  if (isLoading) return <Skeleton className="h-32 w-full" />
  if (isError || !data) return <p className="text-xs text-muted">Preview unavailable.</p>
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <pre className="max-h-96 overflow-auto bg-surface-muted p-3 font-mono text-2xs leading-relaxed text-foreground">
        {data.text}
      </pre>
      {data.totalLines > PREVIEW_LINES ? (
        <div className="border-t border-border px-3 py-1.5 text-2xs text-muted">
          Showing first {PREVIEW_LINES} of {data.totalLines.toLocaleString()} lines.{' '}
          <a href={url} target="_blank" rel="noreferrer" className="text-link hover:underline">
            Open raw
          </a>
        </div>
      ) : null}
    </div>
  )
}

/** Renders an evidence artifact appropriately for its file type. */
export function ArtifactPreview({
  auditId,
  path,
  title,
  fullPagePath,
}: {
  auditId: string
  path: string
  title: string
  fullPagePath?: string | null
}) {
  const [showText, setShowText] = useState(false)
  const url = artifactUrl(auditId, path)
  const name = path.split('/').pop() ?? path
  if (IMAGE_EXT.test(path)) {
    return (
      <ScreenshotViewer
        src={url}
        alt={title}
        title={title}
        fullPageSrc={fullPagePath && IMAGE_EXT.test(fullPagePath) ? artifactUrl(auditId, fullPagePath) : null}
      />
    )
  }
  if (REPORT_EXT.test(path)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ size: 'sm' })}>
          <ExternalLink />
          Open report
        </a>
        <a
          href={artifactUrl(auditId, path, true)}
          className={buttonVariants({ size: 'sm', variant: 'ghost' })}
        >
          <Download />
          Download
        </a>
        <span className="min-w-0 truncate font-mono text-xs text-subtle" title={path}>
          {name}
        </span>
      </div>
    )
  }
  const isText = TEXT_EXT.test(path)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted">
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate" title={path}>
            {name}
          </span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          {isText ? (
            <Button size="sm" variant="ghost" onClick={() => setShowText((v) => !v)}>
              {showText ? 'Hide preview' : 'Preview'}
            </Button>
          ) : null}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: 'sm', variant: 'ghost' })}
          >
            <ExternalLink />
            Open raw
          </a>
          <a
            href={artifactUrl(auditId, path, true)}
            className={buttonVariants({ size: 'sm', variant: 'ghost' })}
          >
            <Download />
            Download
          </a>
        </div>
      </div>
      {isText && showText ? <TextPreview auditId={auditId} path={path} /> : null}
    </div>
  )
}

function SourceBadge({ source }: { source: EvidenceItem['source'] }) {
  const label = { baseline: 'Baseline', auditor: 'AI auditor', reviewer: 'Reviewer', system: 'System' }[
    source
  ]
  return <Badge tone="neutral">{label}</Badge>
}

export function EvidenceHeader({ item }: { item: EvidenceItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs font-medium text-foreground">{item.ref}</span>
      <EvidenceTypeBadge type={item.type} />
      <SourceBadge source={item.source} />
      <span className="ml-auto text-xs text-subtle">{formatDateTime(item.createdAt)}</span>
    </div>
  )
}

function downloadJson(item: EvidenceItem) {
  const blob = new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = `${item.auditId}-${item.ref}.json`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

/** Findings that cite this evidence (from the cached findings list). */
function LinkedFindings({
  auditId,
  evidenceRef,
  exclude,
}: {
  auditId: string
  evidenceRef: string
  exclude?: string
}) {
  const nav = useAuditNav()
  // Subscribe to the page-level cache without triggering a refetch per selected item.
  const all = useQuery({ ...findingsQuery(auditId), staleTime: Infinity })
  const findings = (all.data ?? []).filter(
    (f: FindingItem) => f.ref !== exclude && f.evidenceRefs.includes(evidenceRef),
  )
  if (!findings.length) return null
  return (
    <div>
      <SectionLabel>{exclude ? 'Also cited by' : 'Cited by'}</SectionLabel>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {findings.map((finding) => (
          <li key={finding.ref}>
            <button
              type="button"
              disabled={!nav}
              onClick={() => nav?.openFinding(finding.ref)}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-default"
            >
              <SeverityBadge severity={finding.severity} />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{finding.title}</span>
              <span className="shrink-0 font-mono text-2xs text-subtle">{finding.ref}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The baseline tool run that wrote this evidence's file, when it can be matched by path. */
function ProducedBy({ auditId, path }: { auditId: string; path: string }) {
  const nav = useAuditNav()
  const runs = useQuery({ ...toolRunsQuery(auditId), staleTime: 60_000 })
  const run: ToolRunItem | undefined = runs.data?.find((r) => r.artifactPaths.includes(path))
  if (!run) return null
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
      <Wrench className="size-3.5 text-subtle" aria-hidden />
      <span>
        Produced by <span className="font-medium text-foreground">{run.tool}</span>
        {run.via ? <span className="text-subtle"> via {run.via}</span> : null} · {titleCase(run.status)} ·{' '}
        {formatDuration(run.durationMs)}
      </span>
      {nav ? (
        <button
          type="button"
          onClick={() => nav.openTab('runs')}
          className="cursor-pointer text-link hover:underline"
        >
          Tool runs
        </button>
      ) : null}
    </p>
  )
}

/**
 * Full evidence inspector. Fetches the complete item (lists may carry truncated metadata) and
 * renders summary, artifact and metadata; raw JSON is available behind a secondary toggle.
 */
export function EvidenceViewer({
  auditId,
  evidenceRef,
  className,
  showHeader = true,
  excludeFinding,
}: {
  auditId: string
  evidenceRef: string
  className?: string
  showHeader?: boolean
  /** Finding currently open (in the drawer); not repeated under "Cited by". */
  excludeFinding?: string
}) {
  const queryClient = useQueryClient()
  const listItem = queryClient
    .getQueryData<EvidenceItem[]>(queryKeys.evidence(auditId))
    ?.find((item) => item.ref === evidenceRef)
  const usable = listItem && !('truncated' in listItem.metadata) ? listItem : undefined
  const {
    data: item,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    ...evidenceItemQuery(auditId, evidenceRef),
    placeholderData: usable,
  })

  if (isLoading && !item) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }
  if (isError || !item)
    return <ErrorState title={`Could not load ${evidenceRef}`} error={error} onRetry={() => void refetch()} />
  return (
    <EvidenceDetail
      auditId={auditId}
      item={item}
      className={className}
      showHeader={showHeader}
      excludeFinding={excludeFinding}
    />
  )
}

function EvidenceDetail({
  auditId,
  item,
  className,
  showHeader,
  excludeFinding,
}: {
  auditId: string
  item: EvidenceItem
  className?: string
  showHeader: boolean
  excludeFinding?: string
}) {
  const [raw, setRaw] = useState(false)
  const allVisuals = useQuery({ ...visualsQuery(auditId), staleTime: Infinity })
  const visuals = (allVisuals.data ?? []).filter(
    (a: Artifact) =>
      a.evidenceIds.includes(item.ref) || (a.type === 'annotated_screenshot' && a.data.evidenceId === item.ref),
  )
  const annotated = visuals.find((a) => a.type === 'annotated_screenshot' && a.data.evidenceId === item.ref)
  const otherVisuals = visuals.filter((a) => a !== annotated)
  const [view, setView] = useState<'annotated' | 'original'>(annotated ? 'annotated' : 'original')
  const nav = useAuditNav()

  // A screenshot's full-page capture is offered as a viewer action instead of a metadata row.
  const fullPagePath = typeof item.metadata.fullPage === 'string' ? item.metadata.fullPage : null
  const metadata = fullPagePath
    ? Object.fromEntries(Object.entries(item.metadata).filter(([key]) => key !== 'fullPage'))
    : item.metadata
  const hasMetadata = Object.keys(metadata).length > 0
  return (
    <ArtifactAuditContext.Provider value={auditId}>
      <article className={cn('flex flex-col gap-4', className)}>
        <div className="flex flex-col gap-1.5">
          {showHeader ? <EvidenceHeader item={item} /> : null}
          <h3 className="text-base font-medium text-foreground text-break">{item.title}</h3>
          {item.summary ? (
            <p className="text-sm whitespace-pre-line text-muted text-break">{item.summary}</p>
          ) : null}
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 self-start font-mono text-xs text-link hover:underline text-break"
            >
              {item.url}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : null}
        </div>
        {item.artifactPath ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel className="mb-0">{annotated ? 'Screenshot' : 'Artifact'}</SectionLabel>
              {annotated ? (
                <SegmentedControl
                  label="Screenshot view"
                  value={view}
                  onValueChange={setView}
                  options={[
                    { value: 'annotated', label: 'Annotated' },
                    { value: 'original', label: 'Original' },
                  ]}
                />
              ) : null}
            </div>
            {annotated && view === 'annotated' ? (
              <AppArtifact artifact={annotated} auditId={auditId} />
            ) : (
              <ArtifactPreview
                auditId={auditId}
                path={item.artifactPath}
                title={`${item.ref} · ${item.title}`}
                fullPagePath={fullPagePath}
              />
            )}
            <ProducedBy auditId={auditId} path={item.artifactPath} />
          </div>
        ) : null}
        <LinkedFindings auditId={auditId} evidenceRef={item.ref} exclude={excludeFinding} />
        {otherVisuals.length ? (
          <div>
            <SectionLabel>Used in visuals</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {otherVisuals.map((artifact) => (
                <button
                  key={artifact.ref}
                  type="button"
                  disabled={!nav}
                  onClick={() => nav?.openTab('visuals')}
                  className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-left text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:cursor-default"
                >
                  <span className="shrink-0 font-mono font-medium">{artifact.ref}</span>
                  <span className="truncate">{artifact.title}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {hasMetadata ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <SectionLabel className="mb-0">Details</SectionLabel>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setRaw((v) => !v)} aria-pressed={raw}>
                  <Braces />
                  {raw ? 'Formatted' : 'Raw'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => downloadJson(item)} aria-label={`Download ${item.ref} as JSON`}>
                  <Download />
                  JSON
                </Button>
              </div>
            </div>
            {raw ? (
              <pre className="max-h-120 overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-2xs leading-relaxed text-foreground">
                {JSON.stringify(item.metadata, null, 2)}
              </pre>
            ) : (
              <MetadataView metadata={metadata} />
            )}
          </div>
        ) : null}
      </article>
    </ArtifactAuditContext.Provider>
  )
}
