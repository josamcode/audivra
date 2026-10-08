import { z } from 'zod'

/** Result of scoring one fixture audit against its ground truth. */
export const BenchmarkIssueResult = z.object({
  id: z.string(),
  description: z.string(),
  deterministic: z.boolean(),
  found: z.boolean(),
  matchedFindingRef: z.string().nullable(),
  severityExpected: z.array(z.string()),
  severityActual: z.string().nullable(),
  severityCorrect: z.boolean().nullable(),
  evidenceLinked: z.boolean().nullable(),
})
export type BenchmarkIssueResult = z.infer<typeof BenchmarkIssueResult>

/** How the fixture audit's journeys compare with the fixture's ground truth (structure only, never wording). */
export const BenchmarkJourneyResult = z.object({
  journeys: z.number(),
  primaryFound: z.boolean(),
  primaryType: z.string().nullable(),
  primaryTypeCorrect: z.boolean().nullable(),
  /** The primary journey ends in an expected conversion channel (WhatsApp, form, booking…). */
  conversionCorrect: z.boolean().nullable(),
  blockedSteps: z.number(),
  /** A healthy fixture got a blocked step or a "problem" health verdict. */
  unexpectedProblems: z.boolean(),
  /** Journeys that enter a localized section stay in it (no silent language switch). Null when not applicable. */
  localizedConsistent: z.boolean().nullable(),
  notes: z.array(z.string()),
})
export type BenchmarkJourneyResult = z.infer<typeof BenchmarkJourneyResult>

/** Deterministic change facts between two fixture variants against the known differences. */
export const BenchmarkChangeResult = z.object({
  comparedWith: z.string(),
  expected: z.number(),
  correct: z.number(),
  details: z.array(
    z.object({
      issueId: z.string(),
      expected: z.enum(['new', 'not-found-again', 'still-present']),
      actual: z.string().nullable(),
      correct: z.boolean(),
    }),
  ),
})
export type BenchmarkChangeResult = z.infer<typeof BenchmarkChangeResult>

export const BenchmarkFixtureResult = z.object({
  fixture: z.string(),
  healthy: z.boolean(),
  auditId: z.string().nullable(),
  status: z.string(),
  durationMs: z.number().nullable(),
  auditorTurns: z.number().nullable(),
  findings: z.number(),
  known: z.number(),
  found: z.number(),
  missed: z.number(),
  falsePositives: z.number(),
  unsupported: z.number(),
  severityCorrect: z.number(),
  evidenceLinked: z.number(),
  issues: z.array(BenchmarkIssueResult),
  falsePositiveDetails: z.array(z.object({ ref: z.string(), title: z.string(), reason: z.string() })),
  unsupportedDetails: z.array(z.object({ ref: z.string(), title: z.string(), reason: z.string() })),
  error: z.string().nullable(),
  /** Audit focus the fixture was audited with (older runs: absent). */
  template: z.string().nullable().optional(),
  journeys: BenchmarkJourneyResult.nullable().optional(),
  changes: BenchmarkChangeResult.nullable().optional(),
})
export type BenchmarkFixtureResult = z.infer<typeof BenchmarkFixtureResult>

export const BenchmarkRunItem = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed']),
  model: z.string().nullable(),
  promptVersions: z.record(z.string(), z.string()),
  fixtures: z.array(BenchmarkFixtureResult),
  totals: z
    .object({
      known: z.number(),
      found: z.number(),
      missed: z.number(),
      falsePositives: z.number(),
      unsupported: z.number(),
      severityCorrect: z.number(),
      avgDurationMs: z.number().nullable(),
      avgAuditorTurns: z.number().nullable(),
    })
    .nullable(),
  error: z.string().nullable(),
})
export type BenchmarkRunItem = z.infer<typeof BenchmarkRunItem>
