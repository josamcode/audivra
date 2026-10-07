import {
  EVIDENCE_TYPES,
  type AuditDetail,
  type EvidenceItem,
  type EvidenceSource,
  type EvidenceType,
} from '@audivra/contracts'
import { ArrowLeft, FileSearch, Images, List, Search, SearchX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EVIDENCE_TYPE, EvidenceTypeIcon } from '@/components/badges'
import { EvidenceViewer, isImageArtifact } from '@/components/evidence-viewer'
import { Toolbar, ToolbarSpacer } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select } from '@/components/ui/select'
import { artifactUrl } from '@/lib/api'
import { useMediaQuery } from '@/lib/hooks'
import { urlPath } from '@/lib/format'
import { isTerminal } from '@/lib/queries'
import { cn } from '@/lib/utils'

type All = 'all'
export type EvidenceView = 'list' | 'gallery'

const SOURCE_LABEL: Record<EvidenceSource, string> = {
  baseline: 'Baseline',
  auditor: 'AI auditor',
  reviewer: 'Reviewer',
  system: 'System',
}

function EvidenceRow({
  item,
  active,
  onSelect,
}: {
  item: EvidenceItem
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        'flex w-full cursor-pointer items-start gap-2.5 border-b border-border px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-hover',
        active && 'bg-surface-selected hover:bg-surface-selected',
      )}
    >
      <EvidenceTypeIcon
        type={item.type}
        className={cn(
          'mt-0.5',
          (item.type === 'console-error' || item.type === 'network-failure') && 'text-critical',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-medium text-foreground">{item.ref}</span>
          <span className="truncate text-xs text-subtle">{EVIDENCE_TYPE[item.type]?.label ?? item.type}</span>
          <span className="ml-auto shrink-0 text-2xs text-subtle">{SOURCE_LABEL[item.source]}</span>
        </div>
        <div className="mt-0.5 truncate text-sm text-foreground" title={item.title}>
          {item.title}
        </div>
        {item.url && urlPath(item.url) !== '/' ? (
          <div className="truncate font-mono text-2xs text-muted">{urlPath(item.url)}</div>
        ) : null}
      </div>
    </button>
  )
}

function Gallery({
  auditId,
  items,
  onSelect,
}: {
  auditId: string
  items: EvidenceItem[]
  onSelect: (ref: string) => void
}) {
  if (!items.length) {
    return (
      <EmptyState
        icon={Images}
        title="No screenshots match"
        description="Screenshots appear as the baseline and auditor capture them."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.ref)}
          className="group flex cursor-pointer flex-col overflow-hidden rounded-md border border-border bg-surface text-left transition-colors hover:border-border-strong"
        >
          <div className="aspect-video w-full overflow-hidden border-b border-border bg-surface-muted">
            <img
              src={artifactUrl(auditId, item.artifactPath ?? '')}
              alt={item.title}
              loading="lazy"
              className="size-full object-cover object-top"
            />
          </div>
          <div className="min-w-0 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-medium text-foreground">{item.ref}</span>
              <span className="truncate text-2xs text-subtle">{SOURCE_LABEL[item.source]}</span>
            </div>
            <div className="truncate text-sm text-foreground">{item.title}</div>
            {item.url ? (
              <div className="truncate font-mono text-2xs text-muted">{urlPath(item.url)}</div>
            ) : null}
          </div>
        </button>
      ))}
    </div>
  )
}

export function EvidenceTab({
  audit,
  evidence,
  isLoading,
  error,
  onRetry,
  selectedRef,
  view,
  onSelect,
  onViewChange,
}: {
  audit: AuditDetail
  evidence: EvidenceItem[]
  isLoading: boolean
  error: unknown
  onRetry: () => void
  selectedRef: string | null
  view: EvidenceView
  onSelect: (ref: string | null) => void
  onViewChange: (view: EvidenceView) => void
}) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState<EvidenceType | All>('all')
  const [source, setSource] = useState<EvidenceSource | All>('all')
  const desktop = useMediaQuery('(min-width: 64rem)')

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return evidence.filter(
      (item) =>
        (type === 'all' || item.type === type) &&
        (source === 'all' || item.source === source) &&
        (!needle ||
          [item.ref, item.title, item.summary, item.url ?? ''].join(' ').toLowerCase().includes(needle)),
    )
  }, [evidence, search, type, source])
  const screenshots = filtered.filter((item) => isImageArtifact(item.artifactPath))
  const presentTypes = EVIDENCE_TYPES.filter((t) => evidence.some((item) => item.type === t))
  const presentSources = (['baseline', 'auditor', 'reviewer', 'system'] as const).filter((s) =>
    evidence.some((item) => item.source === s),
  )
  const activeRef = selectedRef ?? (desktop ? (filtered[0]?.ref ?? null) : null)
  const filtering = search.trim() !== '' || type !== 'all' || source !== 'all'

  if (error) {
    return (
      <Panel>
        <ErrorState title="Could not load evidence" error={error} onRetry={onRetry} />
      </Panel>
    )
  }

  const toolbar = (
    <Toolbar>
      <Input
        icon={<Search />}
        placeholder="Search evidence"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="w-full sm:w-64"
        aria-label="Search evidence"
      />
      <Select
        label="Type"
        value={type}
        onValueChange={setType}
        options={[
          { value: 'all', label: 'All' },
          ...presentTypes.map((t) => ({ value: t, label: EVIDENCE_TYPE[t].label })),
        ]}
      />
      <Select
        label="Source"
        value={source}
        onValueChange={setSource}
        options={[
          { value: 'all', label: 'All' },
          ...presentSources.map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
        ]}
      />
      <ToolbarSpacer />
      <span className="text-xs text-muted tabular-nums">
        {filtering ? `${filtered.length} of ${evidence.length}` : evidence.length} items
      </span>
      <SegmentedControl
        label="Evidence view"
        value={view}
        onValueChange={onViewChange}
        options={[
          { value: 'list', label: 'List', icon: List },
          { value: 'gallery', label: 'Screenshots', icon: Images },
        ]}
      />
    </Toolbar>
  )

  if (!isLoading && evidence.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Panel>
          <EmptyState
            icon={FileSearch}
            title={isTerminal(audit.status) ? 'No evidence was recorded' : 'Collecting evidence'}
            description={
              isTerminal(audit.status)
                ? 'The audit finished without recording evidence. Check the Activity tab for what happened.'
                : 'Baseline measurements, screenshots and AI observations will appear here as they are recorded.'
            }
          />
        </Panel>
      </div>
    )
  }

  if (view === 'gallery') {
    return (
      <div className="flex flex-col gap-3">
        {toolbar}
        <Panel>
          {isLoading ? (
            <LoadingState />
          ) : (
            <Gallery
              auditId={audit.id}
              items={screenshots}
              onSelect={(ref) => {
                onViewChange('list')
                onSelect(ref)
              }}
            />
          )}
        </Panel>
      </div>
    )
  }

  const showViewerOnly = !desktop && selectedRef !== null
  return (
    <div className="flex flex-col gap-3">
      {showViewerOnly ? null : toolbar}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {showViewerOnly ? null : (
          <Panel className="self-start overflow-hidden">
            {isLoading ? (
              <LoadingState />
            ) : filtered.length === 0 ? (
              <EmptyState icon={SearchX} compact title="No evidence matches these filters" />
            ) : (
              <div className="lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
                {filtered.map((item) => (
                  <EvidenceRow
                    key={item.id}
                    item={item}
                    active={item.ref === activeRef}
                    onSelect={() => onSelect(item.ref)}
                  />
                ))}
              </div>
            )}
          </Panel>
        )}
        {activeRef && (desktop || showViewerOnly) ? (
          <Panel className="self-start lg:sticky lg:top-4">
            {!desktop ? (
              <div className="border-b border-border px-2 py-1.5">
                <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
                  <ArrowLeft />
                  All evidence
                </Button>
              </div>
            ) : null}
            <div className="p-4 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
              <EvidenceViewer key={activeRef} auditId={audit.id} evidenceRef={activeRef} />
            </div>
          </Panel>
        ) : desktop && !isLoading ? (
          <Panel className="self-start">
            <EmptyState icon={FileSearch} compact title="Select evidence to inspect it" />
          </Panel>
        ) : null}
      </div>
    </div>
  )
}
