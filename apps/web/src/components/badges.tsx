import type {
  AgentRole,
  AuditStage,
  AuditStatus,
  ConversionType,
  CoverageStatus,
  EvidenceType,
  FindingType,
  JourneyDimension,
  JourneyHealthStatus,
  JourneyStepStatus,
  JourneyType,
  EngagementStatus,
  ExecutionFailureKind,
  ExecutionStatus,
  ActionStatus,
  FactStatus,
  GapKind,
  GraphEntityKind,
  HypothesisStatus,
  KnowledgeBasis,
  ReasoningRunStatus,
  ReasoningStopReason,
  ReadinessState,
  SecurityEnvironment,
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
  journeys: 'Journey analysis',
  changes: 'Change intelligence',
  brief: 'Client brief',
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

export const JOURNEY_TYPE_LABEL: Record<JourneyType, string> = {
  lead: 'Lead',
  booking: 'Booking',
  purchase: 'Purchase',
  signup: 'Sign-up',
  demo: 'Demo',
  contact: 'Contact',
  'content-discovery': 'Content discovery',
  'portfolio-contact': 'Portfolio → contact',
  support: 'Support',
  custom: 'Journey',
}

export const JOURNEY_STEP: Record<JourneyStepStatus, { label: string; tone: BadgeTone; icon: LucideIcon; className: string; hint: string }> = {
  ok: { label: 'Works', tone: 'success', icon: CheckCircle2, className: 'text-success', hint: 'Observed working as expected.' },
  friction: { label: 'Friction', tone: 'medium', icon: AlertTriangle, className: 'text-medium', hint: 'Works, with avoidable friction.' },
  blocked: { label: 'Blocked', tone: 'critical', icon: XCircle, className: 'text-critical', hint: 'Broken or not possible.' },
  unverified: { label: 'Not verified', tone: 'neutral', icon: CircleDashed, className: 'text-subtle', hint: 'Not exercised or not observable in this audit.' },
}

export const JOURNEY_HEALTH: Record<JourneyHealthStatus, { label: string; tone: BadgeTone }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  warning: { label: 'Warning', tone: 'medium' },
  problem: { label: 'Problem', tone: 'critical' },
  unknown: { label: 'Unknown', tone: 'neutral' },
  'not-assessed': { label: 'Not assessed', tone: 'neutral' },
}

export const CONVERSION_LABEL: Record<ConversionType, string> = {
  form: 'Form',
  whatsapp: 'WhatsApp',
  phone: 'Phone call',
  email: 'Email',
  booking: 'Booking',
  purchase: 'Purchase',
  signup: 'Sign-up',
  demo: 'Demo request',
  download: 'Download',
  other: 'Conversion',
}

export const JOURNEY_DIMENSION_LABEL: Record<JourneyDimension, string> = {
  visibility: 'Visibility',
  friction: 'Friction',
  tracking: 'Tracking',
  mobile: 'Mobile',
  performance: 'Performance',
  accessibility: 'Accessibility',
  continuity: 'Continuity',
}

export function JourneyHealthBadge({ status }: { status: JourneyHealthStatus }) {
  return (
    <Badge tone={JOURNEY_HEALTH[status].tone} dot>
      {JOURNEY_HEALTH[status].label}
    </Badge>
  )
}

export const READINESS: Record<ReadinessState, { label: string; tone: BadgeTone; hint: string }> = {
  ready: { label: 'Ready', tone: 'success', hint: 'Authorized, scoped and within policy.' },
  'scope-incomplete': { label: 'Scope incomplete', tone: 'medium', hint: 'The scope has no usable targets or contradicts itself.' },
  'policy-incomplete': { label: 'Policy incomplete', tone: 'medium', hint: 'Choose the environment or resolve the policy issues.' },
  'not-authorized': { label: 'Not authorized', tone: 'critical', hint: 'Some scope targets are not covered by a verified authorization.' },
  'outside-window': { label: 'Outside window', tone: 'medium', hint: 'The testing window is not open right now.' },
  paused: { label: 'Paused', tone: 'neutral', hint: 'The engagement is paused.' },
  closed: { label: 'Closed', tone: 'neutral', hint: 'The engagement is completed or cancelled.' },
  invalid: { label: 'Invalid', tone: 'critical', hint: 'The engagement configuration cannot be used.' },
}

export function ReadinessBadge({ state }: { state: ReadinessState }) {
  return (
    <Badge tone={READINESS[state].tone} dot title={READINESS[state].hint}>
      {READINESS[state].label}
    </Badge>
  )
}

export const ENGAGEMENT_STATUS_LABEL: Record<EngagementStatus, string> = {
  draft: 'Draft',
  'authorization-pending': 'Authorization pending',
  ready: 'Ready',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  invalid: 'Invalid',
}

export const ENVIRONMENT_LABEL: Record<SecurityEnvironment, string> = {
  production: 'Production',
  staging: 'Staging',
  'isolated-lab': 'Isolated lab',
}

/** Allow/deny outcome of a scope or policy decision. */
export function DecisionBadge({ decision }: { decision: 'allow' | 'deny' }) {
  return (
    <Badge tone={decision === 'allow' ? 'success' : 'critical'} dot>
      {decision === 'allow' ? 'Allowed' : 'Denied'}
    </Badge>
  )
}

export const EXECUTION_STATUS: Record<ExecutionStatus, { label: string; tone: BadgeTone; hint: string }> = {
  queued: { label: 'Queued', tone: 'neutral', hint: 'Accepted and waiting for the worker.' },
  preparing: { label: 'Preparing', tone: 'running', hint: 'Checks and workspace setup before the work starts.' },
  running: { label: 'Running', tone: 'running', hint: 'The capability is running.' },
  finalizing: { label: 'Finalizing', tone: 'running', hint: 'The work ended; artifacts are checked and resources cleaned up.' },
  cancelling: { label: 'Cancelling', tone: 'medium', hint: 'Cancellation requested; owned resources are being stopped.' },
  succeeded: { label: 'Succeeded', tone: 'success', hint: 'Finished successfully.' },
  failed: { label: 'Failed', tone: 'critical', hint: 'Did not succeed; see the failure reason.' },
  'timed-out': { label: 'Timed out', tone: 'high', hint: 'Stopped by Audivra at the execution time limit.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', hint: 'Stopped on request.' },
  interrupted: { label: 'Interrupted', tone: 'medium', hint: 'The worker stopped while it ran; it was reconciled, not re-run.' },
}

export function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  return (
    <Badge tone={EXECUTION_STATUS[status].tone} dot title={EXECUTION_STATUS[status].hint}>
      {EXECUTION_STATUS[status].label}
    </Badge>
  )
}

export const FAILURE_KIND_LABEL: Record<ExecutionFailureKind, string> = {
  'preflight-failed': 'Preflight failed',
  'executor-failed': 'Capability failed',
  timeout: 'Time limit reached',
  cancelled: 'Stopped on request',
  'artifact-limit': 'Artifact limit',
  'process-limit': 'Process limit',
  'worker-interrupted': 'Worker interrupted',
  'cleanup-failed': 'Cleanup failed',
  internal: 'Internal error',
  'runtime-unavailable': 'Runtime unavailable',
  'runtime-failed': 'Runtime failed',
  'resource-limit': 'Resource limit',
  'network-setup-failed': 'Network setup failed',
  'gateway-unavailable': 'Gateway unavailable',
  'network-cleanup-failed': 'Network cleanup failed',
}

// ── Phase 4: Security Graph and reasoning ─────────────────────────────────────────────────────────────

export const ENTITY_KIND_LABEL: Record<GraphEntityKind, string> = {
  host: 'Host',
  endpoint: 'Endpoint',
  'api-operation': 'API operation',
  parameter: 'Parameter',
  technology: 'Technology',
  signal: 'Signal',
  'source-file': 'Source file',
  identity: 'Identity',
  role: 'Role',
  tenant: 'Tenant',
  session: 'Session',
  resource: 'Resource',
  'business-action': 'Business action',
  'business-state': 'Business state',
  invariant: 'Invariant',
}

/** Why Audivra holds a fact. Inferred (AI-only) is never presented like an observed fact. */
const BASIS: Record<KnowledgeBasis, { label: string; tone: BadgeTone; hint: string }> = {
  observed: { label: 'Observed', tone: 'success', hint: 'Reported by a deterministic sensor (an observation)' },
  declared: { label: 'Declared', tone: 'neutral', hint: 'Stated by a person' },
  derived: { label: 'Derived', tone: 'info', hint: 'Computed by Audivra from observed facts by a deterministic rule' },
  inferred: { label: 'Inferred', tone: 'medium', hint: 'Proposed by an AI and validated, but not observed' },
}

export function BasisBadge({ basis }: { basis: KnowledgeBasis }) {
  return (
    <Badge tone={BASIS[basis].tone} title={BASIS[basis].hint}>
      {BASIS[basis].label}
    </Badge>
  )
}

const FACT_STATUS: Record<FactStatus, { label: string; tone: BadgeTone; hint: string }> = {
  active: { label: 'Active', tone: 'neutral', hint: 'Currently supported by its sources' },
  stale: { label: 'Stale', tone: 'neutral', hint: 'Not reported again by the latest complete run of the sensors that reported it' },
  superseded: { label: 'Superseded', tone: 'neutral', hint: 'Replaced by a newer fact (e.g. a redirect that now goes elsewhere)' },
  contradicted: { label: 'Contradicted', tone: 'high', hint: 'In conflict with another active fact; both are kept until resolved' },
}

export function FactStatusBadge({ status }: { status: FactStatus }) {
  return (
    <Badge tone={FACT_STATUS[status].tone} title={FACT_STATUS[status].hint} className={cn(status === 'stale' || status === 'superseded' ? 'opacity-70' : undefined)}>
      {FACT_STATUS[status].label}
    </Badge>
  )
}

export const GAP_KIND_LABEL: Record<GapKind, string> = {
  'endpoint-behavior-unknown': 'Behavior unknown',
  'technology-uncorroborated': 'Uncorroborated technology',
  'api-operation-unobserved': 'API operation not observed',
  'signal-unconfirmed': 'Unconfirmed signal',
  'contradiction-unresolved': 'Unresolved contradiction',
  'authentication-requirement-unknown': 'Authentication unknown',
}

/** A hypothesis is a claim to investigate — never a verified vulnerability. */
const HYPOTHESIS_STATUS: Record<HypothesisStatus, { label: string; tone: BadgeTone; hint: string }> = {
  proposed: { label: 'Proposed', tone: 'neutral', hint: 'Accepted by validation; not ranked yet' },
  'needs-evidence': { label: 'Needs evidence', tone: 'info', hint: 'Worth investigating; an eligible capability can gather evidence' },
  supported: { label: 'Supported', tone: 'medium', hint: 'Evidence supports it (not independently confirmed)' },
  'confirmed-signal': { label: 'Confirmed signal', tone: 'high', hint: 'Independently corroborated signal — still not a verified vulnerability' },
  disproved: { label: 'Disproved', tone: 'success', hint: 'Contradicted by evidence' },
  deferred: { label: 'Deferred', tone: 'neutral', hint: 'Expected information gain too low for its cost' },
  blocked: { label: 'Blocked', tone: 'medium', hint: 'Policy or environment does not allow gathering the evidence' },
  exhausted: { label: 'Exhausted', tone: 'neutral', hint: 'Every eligible way to gather evidence was tried' },
}

export function HypothesisStatusBadge({ status }: { status: HypothesisStatus }) {
  return (
    <Badge tone={HYPOTHESIS_STATUS[status].tone} dot title={HYPOTHESIS_STATUS[status].hint}>
      {HYPOTHESIS_STATUS[status].label}
    </Badge>
  )
}

const RUN_STATUS: Record<ReasoningRunStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Reasoning', tone: 'running' },
  waiting: { label: 'Waiting for evidence', tone: 'running' },
  completed: { label: 'Completed', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'medium' },
  failed: { label: 'Failed', tone: 'critical' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export function ReasoningRunStatusBadge({ status }: { status: ReasoningRunStatus }) {
  return (
    <Badge tone={RUN_STATUS[status].tone} dot>
      {RUN_STATUS[status].label}
    </Badge>
  )
}

export const STOP_REASON_LABEL: Record<ReasoningStopReason, string> = {
  'sufficient-evidence': 'Every hypothesis is resolved',
  'nothing-to-investigate': 'Nothing worth investigating was found',
  'no-eligible-capability': 'No eligible capability can reduce the remaining uncertainty',
  'low-information-gain': 'Remaining hypotheses would teach too little for their cost',
  'policy-blocked': 'Policy blocked every proposed action',
  'awaiting-approval': 'Actions approved by policy, awaiting a person',
  'budget-exhausted': 'Budget reached',
  'provider-unavailable': 'AI unavailable — AI work paused',
  'provider-refused': 'The AI provider declined (not rerouted)',
  'ai-output-invalid': 'AI output failed validation',
  cancelled: 'Cancelled',
  'internal-error': 'Internal error',
}

const ACTION_STATUS: Record<ActionStatus, { label: string; tone: BadgeTone }> = {
  proposed: { label: 'Proposed', tone: 'neutral' },
  'approved-by-policy': { label: 'Approved by policy', tone: 'info' },
  queued: { label: 'Running', tone: 'running' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'critical' },
  blocked: { label: 'Blocked by policy', tone: 'medium' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  skipped: { label: 'Not executed', tone: 'neutral' },
}

export function ActionStatusBadge({ status }: { status: ActionStatus }) {
  return <Badge tone={ACTION_STATUS[status].tone}>{ACTION_STATUS[status].label}</Badge>
}
