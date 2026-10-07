import { z } from 'zod'

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export const Severity = z.enum(SEVERITIES)
export type Severity = z.infer<typeof Severity>

/** Rank used for deterministic ordering; lower is more severe. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export const CATEGORIES = [
  'Performance',
  'SEO',
  'UX',
  'Mobile',
  'Accessibility',
  'Localization',
  'Security',
  'Tracking',
  'Conversion',
  'Technical',
  'Content',
  'Broken Functionality',
] as const
export const Category = z.enum(CATEGORIES)
export type Category = z.infer<typeof Category>

/**
 * Epistemic class of a finding.
 * - verified: directly reproduced or measured, evidence shows it unambiguously
 * - supported-observation: evidence strongly supports it but some interpretation is involved
 * - inference: a reasoned conclusion that is not directly observable
 */
export const FINDING_TYPES = ['verified', 'supported-observation', 'inference'] as const
export const FindingType = z.enum(FINDING_TYPES)
export type FindingType = z.infer<typeof FindingType>

/** Outcome of the reviewer / revision process for a finding. */
export const VERIFICATION_STATUSES = ['rechecked', 'reviewer-approved', 'revised', 'unreviewed'] as const
export const VerificationStatus = z.enum(VERIFICATION_STATUSES)
export type VerificationStatus = z.infer<typeof VerificationStatus>

export const IMPACT_LEVELS = ['high', 'medium', 'low', 'unknown'] as const
export const ImpactLevel = z.enum(IMPACT_LEVELS)
export type ImpactLevel = z.infer<typeof ImpactLevel>

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const
export const EffortLevel = z.enum(EFFORT_LEVELS)
export type EffortLevel = z.infer<typeof EffortLevel>

export const EVIDENCE_TYPES = [
  'metric',
  'tool-result',
  'screenshot',
  'browser-observation',
  'network-request',
  'network-failure',
  'console-error',
  'dom-observation',
  'http-header',
  'tls-result',
  'terminal-output',
  'page-source',
  'trace',
] as const
export const EvidenceType = z.enum(EVIDENCE_TYPES)
export type EvidenceType = z.infer<typeof EvidenceType>

export const EVIDENCE_SOURCES = ['baseline', 'auditor', 'reviewer', 'system'] as const
export const EvidenceSource = z.enum(EVIDENCE_SOURCES)
export type EvidenceSource = z.infer<typeof EvidenceSource>

export const AUDIT_STATUSES = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'] as const
export const AuditStatus = z.enum(AUDIT_STATUSES)
export type AuditStatus = z.infer<typeof AuditStatus>

/** Broad pipeline stages. Progress is reported per stage, never as a fake percentage. */
export const AUDIT_STAGES = [
  'preparing',
  'baseline',
  'investigation',
  'review',
  'revision',
  'finalizing',
  'done',
] as const
export const AuditStage = z.enum(AUDIT_STAGES)
export type AuditStage = z.infer<typeof AuditStage>

export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const
export const StepStatus = z.enum(STEP_STATUSES)
export type StepStatus = z.infer<typeof StepStatus>

export const TOOL_RUN_STATUSES = ['running', 'completed', 'failed', 'skipped'] as const
export const ToolRunStatus = z.enum(TOOL_RUN_STATUSES)
export type ToolRunStatus = z.infer<typeof ToolRunStatus>

export const AGENT_ROLES = ['auditor', 'reviewer', 'revision', 'finalizer'] as const
export const AgentRole = z.enum(AGENT_ROLES)
export type AgentRole = z.infer<typeof AgentRole>

export const AGENT_RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const
export const AgentRunStatus = z.enum(AGENT_RUN_STATUSES)
export type AgentRunStatus = z.infer<typeof AgentRunStatus>

/** Classifies failures so the UI can explain what went wrong honestly. */
export const FAILURE_KINDS = [
  'required-capability',
  'optional-capability',
  'ai',
  'tool',
  'browser',
  'cancelled',
  'internal',
] as const
export const FailureKind = z.enum(FAILURE_KINDS)
export type FailureKind = z.infer<typeof FailureKind>
