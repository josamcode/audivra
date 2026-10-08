import { z } from 'zod'
import { Category, EffortLevel, FindingType, ImpactLevel, Severity, VerificationStatus } from './enums.ts'
import { LimitationItem, StoredBusinessUnderstanding, Technology } from './agent-outputs.ts'
import { Artifact, Datum } from './artifacts.ts'
import { CoverageItem } from './coverage.ts'
import { AuditComparison, ChangeBasis, ChangeKind } from './history.ts'
import { ConversionType, JourneyDimension, JourneyHealthStatus, JourneyStepKind, JourneyStepStatus, JourneyType } from './journeys.ts'

/** What the Report Composer returns: selection, ordering and short client-facing framing. */
export const ActionItem = z.object({
  title: z.string().min(3).max(120).describe('Imperative, specific action, e.g. "Redirect www to the apex domain".'),
  why: z.string().max(220).describe('One sentence grounded in the findings.'),
  findingIds: z.array(z.string()).min(1).describe('Final findings (F*) this action addresses.'),
})
export type ActionItem = z.infer<typeof ActionItem>

export const ReportPlan = z.object({
  executiveSnapshot: z
    .array(z.string().min(5).max(240))
    .min(3)
    .max(8)
    .describe('5–8 short lines a business owner can read in 15 seconds. No jargon, no invented numbers.'),
  topRiskFindingIds: z.array(z.string()).min(1).max(5).describe('The 3–5 findings that matter most, in order.'),
  topOpportunityTitles: z.array(z.string()).max(5).describe('Titles of the 3–5 most valuable opportunities, in order.'),
  featuredArtifactRefs: z
    .array(z.string())
    .max(2)
    .describe('Up to two artifacts (A*) that best summarise the audit for the overview.'),
  majorFindingIds: z
    .array(z.string())
    .max(10)
    .describe('Findings for the main client narrative; all others go to the technical appendix.'),
  findingProof: z
    .array(
      z.object({
        findingId: z.string(),
        artifactRef: z.string().nullable().describe('Artifact (A*) that proves this finding visually, if any.'),
        evidenceId: z.string().nullable().describe('Screenshot evidence (EV-*) to show if no artifact fits.'),
      }),
    )
    .describe('Best visual proof per major finding.'),
  categoryHighlights: z
    .array(
      z.object({
        category: Category,
        takeaway: z.string().max(240).describe('One sentence: the state of this area.'),
        artifactRefs: z.array(z.string()).max(2),
        findingIds: z.array(z.string()).max(6),
      }),
    )
    .max(6),
  actionPlan: z.object({
    doFirst: z.array(ActionItem).max(5),
    then: z.array(ActionItem).max(6),
    later: z.array(ActionItem).max(6),
  }),
  featuredJourneyRefs: z
    .array(z.string())
    .max(2)
    .default([])
    .describe('Journeys (J*) to show the client: the primary journey, plus at most one other that matters. Empty when no journey is supported.'),
})
export type ReportPlan = z.infer<typeof ReportPlan>

export const ReportProofImage = z.object({
  evidenceRef: z.string(),
  path: z.string(),
  caption: z.string(),
})
export type ReportProofImage = z.infer<typeof ReportProofImage>

export const ReportFinding = z.object({
  ref: z.string(),
  title: z.string(),
  severity: Severity,
  category: Category,
  type: FindingType,
  confidence: z.number(),
  verificationStatus: VerificationStatus,
  description: z.string(),
  observed: z.string(),
  whyItMatters: z.string(),
  businessImpact: z.string(),
  businessImpactLevel: ImpactLevel,
  recommendation: z.string(),
  effort: EffortLevel,
  affectedUrls: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  proof: z.object({
    artifact: Artifact.nullable(),
    image: ReportProofImage.nullable(),
  }),
})
export type ReportFinding = z.infer<typeof ReportFinding>

export const ReportOpportunity = z.object({
  title: z.string(),
  why: z.string(),
  scope: z.string().nullable(),
  impact: z.enum(['high', 'medium', 'low']),
  effort: EffortLevel,
  findingRefs: z.array(z.string()),
})
export type ReportOpportunity = z.infer<typeof ReportOpportunity>

export const ReportAction = z.object({ title: z.string(), why: z.string(), findingRefs: z.array(z.string()) })
export type ReportAction = z.infer<typeof ReportAction>

/** A journey as the client sees it: path, step states and explained health — no internal IDs beyond refs. */
export const ReportJourney = z.object({
  ref: z.string(),
  name: z.string(),
  type: JourneyType,
  goal: z.string(),
  description: z.string(),
  isPrimary: z.boolean(),
  steps: z.array(
    z.object({
      label: z.string(),
      url: z.string().nullable(),
      kind: JourneyStepKind,
      status: JourneyStepStatus,
      note: z.string(),
      conversionType: ConversionType.nullable(),
    }),
  ),
  health: z.array(z.object({ dimension: JourneyDimension, status: JourneyHealthStatus, note: z.string() })),
  findingRefs: z.array(z.string()),
})
export type ReportJourney = z.infer<typeof ReportJourney>

/** The interpreted "what changed" for the client, on top of the deterministic comparison. */
export const ReportChanges = z.object({
  previousDate: z.string(),
  headline: z.string(),
  summary: z.string(),
  insights: z.array(
    z.object({
      kind: ChangeKind,
      importance: z.enum(['high', 'medium', 'low']),
      title: z.string(),
      description: z.string(),
      basis: ChangeBasis,
      findingRefs: z.array(z.string()),
    }),
  ),
})
export type ReportChanges = z.infer<typeof ReportChanges>

export const REPORT_SCHEMA_VERSION = 'audivra.report.v2'

/**
 * The client report model. Built deterministically from persisted audit data (+ the composer's plan
 * when available) and rendered by the same components for preview, standalone HTML and PDF.
 * It intentionally contains no run IDs, prompt versions, model details or debug data.
 */
export const ClientReport = z.object({
  schema: z.literal(REPORT_SCHEMA_VERSION),
  generatedAt: z.string(),
  title: z.string(),
  site: z.object({ url: z.string(), domain: z.string(), clientName: z.string().nullable() }),
  /** Audit focus (template name), when one was chosen. */
  focus: z.string().nullable(),
  audit: z.object({
    date: z.string(),
    durationMs: z.number().nullable(),
    status: z.string(),
    complete: z.boolean().describe('False when a stage failed or the AI investigation did not run.'),
  }),
  snapshot: z.object({
    lines: z.array(z.string()),
    findings: z.object({
      total: z.number(),
      bySeverity: z.record(Severity, z.number()),
      verified: z.number(),
      observed: z.number(),
      inferred: z.number(),
    }),
    pages: z.object({ discovered: z.number(), crawled: z.number(), inspected: z.number() }),
    evidenceCount: z.number(),
    keyMetrics: z.array(Datum),
  }),
  business: StoredBusinessUnderstanding.nullable(),
  topRisks: z.array(ReportFinding),
  featuredArtifacts: z.array(Artifact),
  majorFindings: z.array(ReportFinding),
  categoryHighlights: z.array(
    z.object({ category: Category, takeaway: z.string(), artifacts: z.array(Artifact), findingRefs: z.array(z.string()) }),
  ),
  visuals: z.array(Artifact).describe('Report-placement artifacts not already used above, in priority order.'),
  opportunities: z.array(ReportOpportunity),
  actionPlan: z.object({ doFirst: z.array(ReportAction), then: z.array(ReportAction), later: z.array(ReportAction) }),
  /** The primary journey first; at most one more. */
  journeys: z.array(ReportJourney),
  comparison: AuditComparison.nullable(),
  changes: ReportChanges.nullable(),
  appendix: z.object({
    otherFindings: z.array(ReportFinding),
    artifacts: z.array(Artifact),
    coverage: z.array(CoverageItem),
    technologies: z.array(Technology),
    pages: z.array(z.object({ url: z.string(), status: z.number().nullable(), title: z.string().nullable(), inspected: z.boolean() })),
    limitations: z.array(LimitationItem),
    methodology: z.array(z.string()),
    fullAnalysis: z.string().nullable(),
  }),
  /** Workspace-relative image paths used by the report, keyed by evidence ref. */
  images: z.record(z.string(), z.string()),
})
export type ClientReport = z.infer<typeof ClientReport>
