import type {
  AgentRole,
  AuditStage,
  AuditStatus,
  CoverageStatus,
  EvidenceType,
  FindingType,
  Severity,
  StepStatus,
  ToolState,
  VerificationStatus,
} from '@audivra/contracts'
import {
  Activity,
  AlertTriangle,
  Binary,
  Braces,
  Camera,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  Code2,
  Eye,
  FileCode2,
  Gauge,
  Globe,
  Lightbulb,
  Loader2,
  Lock,
  MinusCircle,
  MousePointerClick,
  Network,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const STATUS: Record<AuditStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'running' },
  completed: { label: 'Completed', tone: 'success' },
  partial: { label: 'Partial', tone: 'medium' },
  failed: { label: 'Failed', tone: 'critical' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export const STAGE_LABELS: Record<AuditStage, string> = {
  preparing: 'Preparing',
  baseline: 'Baseline',
  investigation: 'AI investigation',
  review: 'Review',
  revision: 'Revision',
  finalizing: 'Finalizing',
  presenting: 'Visuals & report',
  done: 'Done',
}

export const ROLE_LABELS: Record<AgentRole, string> = {
  auditor: 'AI auditor',
  reviewer: 'Reviewer',
  revision: 'Revision',
  finalizer: 'Finalizer',
  planner: 'Artifact planner',
  composer: 'Report composer',
}

export const COVERAGE_STATUS: Record<CoverageStatus, { label: string; tone: BadgeTone }> = {
  ran: { label: 'Ran', tone: 'success' },
  partial: { label: 'Partial', tone: 'medium' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'critical' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
  'not-applicable': { label: 'Not applicable', tone: 'neutral' },
}

/** Compact coverage status glyph (with an accessible label). */
export function CoverageIcon({ status, className }: { status: CoverageStatus; className?: string }) {
  const label = COVERAGE_STATUS[status].label
  const base = cn('size-3.5 shrink-0', className)
  switch (status) {
    case 'ran':
      return <CheckCircle2 className={cn(base, 'text-success')} aria-label={label} />
    case 'partial':
      return <CircleDot className={cn(base, 'text-medium')} aria-label={label} />
    case 'failed':
      return <XCircle className={cn(base, 'text-critical')} aria-label={label} />
    case 'not-applicable':
      return <Circle className={cn(base, 'text-border-strong')} aria-label={label} />
    default:
      return <MinusCircle className={cn(base, 'text-subtle')} aria-label={label} />
  }
}

export function StatusBadge({ status, stage }: { status: AuditStatus; stage?: AuditStage }) {
  const config = STATUS[status]
  const showStage = status === 'running' && stage && stage !== 'done'
  return (
    <Badge tone={config.tone} dot>
      {config.label}
      {showStage ? (
        <span className="hidden font-normal opacity-80 sm:inline">· {STAGE_LABELS[stage]}</span>
      ) : null}
    </Badge>
  )
}

export const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
}

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]} dot className={cn('w-17 justify-start', className)}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  )
}

export const FINDING_TYPE: Record<
  FindingType,
  { label: string; short: string; icon: LucideIcon; tone: BadgeTone; hint: string }
> = {
  verified: {
    label: 'Verified',
    short: 'Verified',
    icon: ShieldCheck,
    tone: 'success',
    hint: 'Directly reproduced or measured; the evidence shows it unambiguously.',
  },
  'supported-observation': {
    label: 'Supported observation',
    short: 'Observation',
    icon: Eye,
    tone: 'neutral',
    hint: 'Strongly supported by evidence, with some interpretation involved.',
  },
  inference: {
    label: 'Inference',
    short: 'Inference',
    icon: Lightbulb,
    tone: 'neutral',
    hint: 'A reasoned conclusion that is not directly observable.',
  },
}

export function FindingTypeBadge({ type, short = false }: { type: FindingType; short?: boolean }) {
  const config = FINDING_TYPE[type]
  const Icon = config.icon
  return (
    <Badge tone={config.tone} title={config.hint}>
      <Icon />
      {short ? config.short : config.label}
    </Badge>
  )
}

export const VERIFICATION: Record<VerificationStatus, { label: string; hint: string }> = {
  rechecked: { label: 'Rechecked', hint: 'Re-verified by the auditor after the review pass.' },
  'reviewer-approved': { label: 'Reviewer approved', hint: 'Challenged by the reviewer and approved.' },
  revised: { label: 'Revised', hint: 'Adjusted after reviewer feedback.' },
  unreviewed: { label: 'Unreviewed', hint: 'Not challenged by the reviewer.' },
}

export function VerificationText({ status }: { status: VerificationStatus }) {
  return (
    <span className="text-xs text-muted" title={VERIFICATION[status].hint}>
      {VERIFICATION[status].label}
    </span>
  )
}

export const TOOL_STATE: Record<ToolState, { label: string; tone: BadgeTone; hint: string }> = {
  ready: { label: 'Ready', tone: 'success', hint: 'Installed and verified; agents can use it.' },
  'needs-setup': { label: 'Needs setup', tone: 'medium', hint: 'Installed but missing configuration or a dependency.' },
  unavailable: { label: 'Unavailable', tone: 'neutral', hint: 'Not installed or not reachable on this machine.' },
  disabled: { label: 'Disabled', tone: 'neutral', hint: 'Turned off in configuration.' },
  error: { label: 'Error', tone: 'critical', hint: 'The last check failed.' },
}

export function ToolStateBadge({ state }: { state: ToolState }) {
  return (
    <Badge tone={TOOL_STATE[state].tone} dot title={TOOL_STATE[state].hint}>
      {TOOL_STATE[state].label}
    </Badge>
  )
}

export const EVIDENCE_TYPE: Record<EvidenceType, { label: string; icon: LucideIcon }> = {
  metric: { label: 'Metric', icon: Gauge },
  'tool-result': { label: 'Tool result', icon: Wrench },
  screenshot: { label: 'Screenshot', icon: Camera },
  'browser-observation': { label: 'Browser', icon: MousePointerClick },
  'network-request': { label: 'Network', icon: Network },
  'network-failure': { label: 'Network failure', icon: Network },
  'console-error': { label: 'Console error', icon: AlertTriangle },
  'dom-observation': { label: 'DOM', icon: Code2 },
  'http-header': { label: 'HTTP headers', icon: Globe },
  'tls-result': { label: 'TLS', icon: Lock },
  'terminal-output': { label: 'Terminal', icon: SquareTerminal },
  'page-source': { label: 'Page source', icon: FileCode2 },
  trace: { label: 'Trace', icon: Activity },
}

export function EvidenceTypeBadge({ type }: { type: EvidenceType }) {
  const config = EVIDENCE_TYPE[type] ?? { label: type, icon: Braces }
  const Icon = config.icon
  const failure = type === 'console-error' || type === 'network-failure'
  return (
    <Badge tone={failure ? 'critical' : 'neutral'}>
      <Icon />
      {config.label}
    </Badge>
  )
}

export function EvidenceTypeIcon({ type, className }: { type: EvidenceType; className?: string }) {
  const Icon = EVIDENCE_TYPE[type]?.icon ?? Binary
  return <Icon className={cn('size-3.5 shrink-0 text-subtle', className)} aria-hidden />
}

export function StepIcon({ status, className }: { status: StepStatus; className?: string }) {
  const base = cn('size-4 shrink-0', className)
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={cn(base, 'text-success')} aria-label="Completed" />
    case 'running':
      return <Loader2 className={cn(base, 'animate-spin text-running')} aria-label="Running" />
    case 'failed':
      return <XCircle className={cn(base, 'text-critical')} aria-label="Failed" />
    case 'skipped':
      return <MinusCircle className={cn(base, 'text-subtle')} aria-label="Skipped" />
    default:
      return <Circle className={cn(base, 'text-border-strong')} aria-label="Pending" />
  }
}

export function PendingIcon({ className }: { className?: string }) {
  return <CircleDashed className={cn('size-4 text-subtle', className)} aria-hidden />
}

export function ScrollIcon({ className }: { className?: string }) {
  return <ScrollText className={cn('size-4', className)} aria-hidden />
}

/** Impact / effort as compact labelled text: "High impact". */
export function LevelText({ level, kind }: { level: string; kind: 'impact' | 'effort' }) {
  const strong = (kind === 'impact' && level === 'high') || (kind === 'effort' && level === 'low')
  return (
    <span className={cn('text-xs whitespace-nowrap', strong ? 'font-medium text-foreground' : 'text-muted')}>
      {level === 'unknown' ? 'Unknown' : level.charAt(0).toUpperCase() + level.slice(1)} {kind}
    </span>
  )
}

/** Confidence 0..1 shown as a percentage with a slim neutral bar. */
export function Confidence({ value, showBar = true }: { value: number; showBar?: boolean }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <span className="inline-flex items-center gap-2" title={`Confidence ${percent}%`}>
      {showBar ? (
        <span className="relative h-1 w-10 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-muted"
            style={{ width: `${percent}%` }}
          />
        </span>
      ) : null}
      <span className="font-mono text-xs text-muted tabular-nums">{percent}%</span>
    </span>
  )
}
