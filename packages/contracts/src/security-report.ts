import { z } from 'zod'
import { AttackPathReport } from './security-attack-path.ts'
import { ComparisonCoverage } from './security-comparison.ts'
import { SecurityAssessmentReport } from './security-finding.ts'
import { SecurityHistoricalReport } from './security-history.ts'
import { ResidualUncertainty } from './security-research.ts'

/*
 * Phase 6F — one client-facing Security Assessment report, COMPOSED from the per-area reports that already
 * exist (findings, attack paths, history) plus coverage and residual uncertainty. It is assembled purely from
 * stored state (no AI re-run), carries the exact versions that produced it (for reproducibility), and renders
 * for an executive or a technical audience from one model. It never claims a complete penetration test and
 * never contains secrets.
 */

export const SECURITY_REPORT_AUDIENCES = ['executive', 'technical'] as const
export const SecurityReportAudience = z.enum(SECURITY_REPORT_AUDIENCES)
export type SecurityReportAudience = z.infer<typeof SecurityReportAudience>

/** The exact versions that produced the report — essential for reproducibility (§64). */
export const SecurityReportVersions = z.object({
  audivra: z.string(),
  policyProfile: z.object({ key: z.string(), version: z.number() }),
  promptVersions: z.record(z.string(), z.string()),
  tools: z.array(z.object({ name: z.string(), approved: z.string().nullable(), installed: z.string().nullable(), match: z.boolean() })),
})
export type SecurityReportVersions = z.infer<typeof SecurityReportVersions>

export const SecurityReportMeta = z.object({
  engagementId: z.string(),
  name: z.string(),
  targetUrl: z.string(),
  environment: z.string().nullable(),
  policyProfile: z.object({ key: z.string(), version: z.number(), name: z.string() }),
  generatedAt: z.string(),
  versions: SecurityReportVersions,
})
export type SecurityReportMeta = z.infer<typeof SecurityReportMeta>

export const SecurityReportBundle = z.object({
  meta: SecurityReportMeta,
  /** A deterministic, honest executive summary (counts + residual caveat; never overstated). */
  executiveSummary: z.string(),
  /** A deterministic one-paragraph methodology note (what Audivra did and did not do). */
  methodology: z.string(),
  findings: SecurityAssessmentReport,
  attackPaths: AttackPathReport,
  /** Present only when a previous assessment was named. */
  history: SecurityHistoricalReport.nullable(),
  comparisonCoverage: ComparisonCoverage,
  residual: ResidualUncertainty,
})
export type SecurityReportBundle = z.infer<typeof SecurityReportBundle>

export const SECURITY_REPORT_EXPORT_KINDS = ['json', 'html'] as const
export const SecurityReportExportKind = z.enum(SECURITY_REPORT_EXPORT_KINDS)
export type SecurityReportExportKind = z.infer<typeof SecurityReportExportKind>
