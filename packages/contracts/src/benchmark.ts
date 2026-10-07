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
