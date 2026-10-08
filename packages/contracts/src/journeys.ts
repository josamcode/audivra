import { z } from 'zod'

/**
 * Journeys: the paths visitors are expected to take to reach the site's goals (enquiry, booking,
 * purchase, sign-up…). The auditor discovers them from the site itself, walks the important ones and
 * records evidence per step; the reviewer challenges them; the finalizer keeps only supported ones.
 *
 * There is deliberately no overall journey score: each health dimension has an explained status.
 */

export const JOURNEY_TYPES = [
  'lead',
  'booking',
  'purchase',
  'signup',
  'demo',
  'contact',
  'content-discovery',
  'portfolio-contact',
  'support',
  'custom',
] as const
export const JourneyType = z.enum(JOURNEY_TYPES)
export type JourneyType = z.infer<typeof JourneyType>

export const JOURNEY_DIMENSIONS = ['visibility', 'friction', 'tracking', 'mobile', 'performance', 'accessibility', 'continuity'] as const
export const JourneyDimension = z.enum(JOURNEY_DIMENSIONS)
export type JourneyDimension = z.infer<typeof JourneyDimension>

export const JOURNEY_HEALTH_STATUSES = ['healthy', 'warning', 'problem', 'unknown', 'not-assessed'] as const
export const JourneyHealthStatus = z.enum(JOURNEY_HEALTH_STATUSES)
export type JourneyHealthStatus = z.infer<typeof JourneyHealthStatus>

export const JOURNEY_STEP_KINDS = ['page', 'action', 'outcome'] as const
export const JourneyStepKind = z.enum(JOURNEY_STEP_KINDS)
export type JourneyStepKind = z.infer<typeof JourneyStepKind>

export const JOURNEY_STEP_STATUSES = ['ok', 'friction', 'blocked', 'unverified'] as const
export const JourneyStepStatus = z.enum(JOURNEY_STEP_STATUSES)
export type JourneyStepStatus = z.infer<typeof JourneyStepStatus>

export const CONVERSION_TYPES = ['form', 'whatsapp', 'phone', 'email', 'booking', 'purchase', 'signup', 'demo', 'download', 'other'] as const
export const ConversionType = z.enum(CONVERSION_TYPES)
export type ConversionType = z.infer<typeof ConversionType>

const EvidenceIds = z
  .array(z.string())
  .describe('Evidence IDs (e.g. "EV-12") that show this. Only IDs that exist.')

export const JourneyStep = z.object({
  label: z.string().min(1).max(80).describe('Short step name, e.g. "Homepage", "Implants service page", "Contact page", "WhatsApp chat".'),
  url: z.string().nullable().describe('Page URL for page steps; null for actions or outcomes that leave the site (WhatsApp, phone call).'),
  kind: JourneyStepKind.describe('page: a page the visitor is on; action: something they do (tap a button, open a menu); outcome: where the journey ends (the conversion).'),
  action: z.string().max(200).describe('What the visitor does to move on from this step, e.g. "Taps the WhatsApp button in the header". Empty for the last step.'),
  conversionType: ConversionType.nullable().describe('Set only on the step where the conversion happens.'),
  status: JourneyStepStatus.describe('ok: works as expected · friction: works, with avoidable friction · blocked: broken or impossible · unverified: not exercised or not observable.'),
  note: z.string().max(240).describe('What was observed at this step, with concrete detail. Empty when nothing notable.'),
  evidenceIds: EvidenceIds,
})
export type JourneyStep = z.infer<typeof JourneyStep>

export const JourneyHealth = z.object({
  dimension: JourneyDimension,
  status: JourneyHealthStatus,
  note: z.string().max(280).describe('One sentence explaining the status from the evidence.'),
  evidenceIds: EvidenceIds,
  findingIds: z.array(z.string()).describe('Findings that explain this status (IDs from this output).'),
})
export type JourneyHealth = z.infer<typeof JourneyHealth>

const journeyCore = {
  type: JourneyType,
  name: z.string().min(3).max(80).describe('Specific name, e.g. "WhatsApp booking from a service page".'),
  goal: z.string().max(240).describe('What the visitor is trying to accomplish.'),
  description: z.string().max(600).describe('How this journey works on this site and what was observed walking it.'),
  isPrimary: z.boolean().describe('True for the single most important conversion journey. At most one journey is primary.'),
  confidence: z.number().min(0).max(1).describe('How certain you are that this journey exists and matters as described.'),
  steps: z.array(JourneyStep).min(2).max(10).describe('Ordered steps from entry to conversion.'),
  health: z.array(JourneyHealth).describe('Assessed dimensions only; leave out dimensions you did not assess.'),
}

/** A journey in the auditor's draft. Findings point at it through `journeyIds`. */
export const DraftJourney = z.object({ id: z.string().describe('Local ID, e.g. "J1".'), ...journeyCore })
export type DraftJourney = z.infer<typeof DraftJourney>

export const JOURNEY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/

const journeyKey = z
  .string()
  .regex(JOURNEY_KEY_PATTERN)
  .describe(
    'Stable kebab-case key for this journey, independent of wording, e.g. "whatsapp-booking", "contact-form-enquiry", "product-to-checkout". When the previous audit had the same journey, reuse its key exactly.',
  )

/** A journey in the final audit. */
export const FinalJourney = z.object({
  id: z.string().describe('Final ID: "J1", "J2"… with the primary journey first.'),
  journeyKey,
  sourceJourneyIds: z.array(z.string()).min(1).describe('Draft journey IDs this journey is derived from. Never empty.'),
  ...journeyCore,
})
export type FinalJourney = z.infer<typeof FinalJourney>

/**
 * Journey analysis for an audit that finished before journeys existed: derived from the recorded
 * evidence, crawl and findings (no new browsing). Findings are linked to journeys afterwards.
 */
export const AnalyzedJourney = z.object({ id: z.string().describe('"J1", "J2"… primary first.'), journeyKey, ...journeyCore })
export type AnalyzedJourney = z.infer<typeof AnalyzedJourney>

export const JourneyAnalysis = z.object({
  journeys: z.array(AnalyzedJourney).max(5),
  findingLinks: z
    .array(z.object({ findingId: z.string(), journeyIds: z.array(z.string()) }))
    .describe('Existing findings (F*) that affect a journey, with the journeys they affect.'),
  notes: z.string().max(600).describe('What the analysis was based on and what could not be established.'),
})
export type JourneyAnalysis = z.infer<typeof JourneyAnalysis>

export const JOURNEY_SOURCES = ['audit', 'analysis'] as const

/** A stored journey. Refs (J1, F3, EV-12) are per audit. */
export const JourneyItem = z.object({
  id: z.string(),
  ref: z.string(),
  auditId: z.string(),
  journeyKey: z.string(),
  type: JourneyType,
  name: z.string(),
  goal: z.string(),
  description: z.string(),
  isPrimary: z.boolean(),
  confidence: z.number(),
  steps: z.array(JourneyStep),
  health: z.array(JourneyHealth),
  /** Findings that affect this journey (from the findings' own journey links). */
  findingRefs: z.array(z.string()),
  /** Every evidence item the journey cites (steps and health). */
  evidenceRefs: z.array(z.string()),
  /** audit: discovered during the audit · analysis: added later from the recorded evidence. */
  source: z.enum(JOURNEY_SOURCES),
  rank: z.number(),
  createdAt: z.string(),
})
export type JourneyItem = z.infer<typeof JourneyItem>

/** Status of an on-demand AI job for an audit (journey analysis, change intelligence, client brief). */
export const EnrichmentStatus = z.object({
  running: z.boolean(),
  /** Error of the most recent failed attempt, when it failed after the current result was produced. */
  lastError: z.string().nullable(),
  /** When the most recent run completed (null if it never ran or the latest run did not complete). */
  lastCompletedAt: z.string().nullable(),
  /** Whether this audit can run the job (finished, AI audit, AI available). */
  available: z.boolean(),
  /** Why it is unavailable, in plain words. */
  reason: z.string().nullable(),
})
export type EnrichmentStatus = z.infer<typeof EnrichmentStatus>

export const AuditJourneys = z.object({ journeys: z.array(JourneyItem), status: EnrichmentStatus })
export type AuditJourneys = z.infer<typeof AuditJourneys>
