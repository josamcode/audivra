import { z } from 'zod'
import {
  SEVERITIES,
  type BenchmarkFixtureResult,
  type BenchmarkIssueResult,
  type BenchmarkRunItem,
  type EvidenceItem,
  type FindingItem,
} from '@audivra/contracts'

/**
 * Audit quality benchmark scoring. Fixture sites have planted, verifiable issues (ground truth);
 * the benchmark audits them and measures what was found, missed, falsely claimed and unsupported.
 * Subjective expectations (e.g. "thin trust content") are reported but never scored as misses.
 */

const Pattern = z.string().min(1)

export const BenchmarkExpectation = z.object({
  id: z.string(),
  description: z.string(),
  deterministic: z.boolean(),
  /** Case-insensitive regex matched against the finding's title, description and observation. */
  match: Pattern,
  /** Optional: the finding's category must be one of these. */
  categories: z.array(z.string()).optional(),
  /** Acceptable severities (the "correct band"). */
  severity: z.array(z.enum(SEVERITIES)).min(1),
  /** Optional: cited evidence (type, title, summary, URL) must match this for correct linkage. */
  evidence: Pattern.optional(),
})
export type BenchmarkExpectation = z.infer<typeof BenchmarkExpectation>

export const FixtureExpectations = z.object({
  id: z.string(),
  name: z.string(),
  variant: z.string(),
  healthy: z.boolean(),
  issues: z.array(BenchmarkExpectation),
  /** Claims known to be false for this fixture: a matching (non-info) finding is a false positive. */
  absent: z.array(z.object({ id: z.string(), description: z.string(), match: Pattern })),
  /** True-but-environmental observations (local HTTP fixture) never counted as false positives. */
  tolerated: z.array(Pattern).default([]),
})
export type FixtureExpectations = z.infer<typeof FixtureExpectations>

export const BenchmarkSuite = z.object({ version: z.number(), fixtures: z.array(FixtureExpectations).min(1) })
export type BenchmarkSuite = z.infer<typeof BenchmarkSuite>

const regex = (source: string) => new RegExp(source, 'i')
const findingText = (f: FindingItem) => `${f.title}\n${f.description}\n${f.observed}`
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']
/** Findings at these severities claim a problem; info findings are context and never false positives. */
const PROBLEM_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])

export interface ScoreInput {
  auditId: string | null
  status: string
  durationMs: number | null
  auditorTurns: number | null
  findings: FindingItem[]
  evidence: EvidenceItem[]
  error?: string | null
}

function matchesExpectation(f: FindingItem, e: BenchmarkExpectation): boolean {
  if (e.categories && !e.categories.some((c) => c.toLowerCase() === f.category.toLowerCase())) return false
  return regex(e.match).test(findingText(f))
}

/** Scores one fixture audit against its ground truth. Pure: same inputs, same result. */
export function scoreFixture(fixture: FixtureExpectations, input: ScoreInput): BenchmarkFixtureResult {
  const evidenceByRef = new Map(input.evidence.map((e) => [e.ref, e]))
  const matchedRefs = new Set<string>()

  const issues: BenchmarkIssueResult[] = fixture.issues.map((expectation) => {
    // Best match = the most topical finding: the issue named in its title beats a passing mention in a
    // broader finding's description; then an expected category, then a severity inside the band.
    // (A template-wide finding may still cover several expectations.)
    const pattern = regex(expectation.match)
    const relevance = (f: FindingItem) =>
      (pattern.test(f.title) ? 4 : 0) +
      (expectation.categories?.some((c) => c.toLowerCase() === f.category.toLowerCase()) ? 2 : 0) +
      (expectation.severity.includes(f.severity) ? 1 : 0)
    const candidates = input.findings
      .filter((f) => matchesExpectation(f, expectation))
      .sort((a, b) => relevance(b) - relevance(a) || a.rank - b.rank)
    const match = candidates[0] ?? null
    for (const c of candidates) matchedRefs.add(c.ref)
    let evidenceLinked: boolean | null = null
    if (match) {
      const cited = match.evidenceRefs.map((ref) => evidenceByRef.get(ref)).filter((e): e is EvidenceItem => !!e)
      evidenceLinked = expectation.evidence
        ? cited.some((e) => regex(expectation.evidence!).test(`${e.type} ${e.title} ${e.summary} ${e.url ?? ''}`))
        : cited.length > 0
    }
    return {
      id: expectation.id,
      description: expectation.description,
      deterministic: expectation.deterministic,
      found: match !== null,
      matchedFindingRef: match?.ref ?? null,
      severityExpected: expectation.severity,
      severityActual: match?.severity ?? null,
      severityCorrect: match ? expectation.severity.includes(match.severity) : null,
      evidenceLinked,
    }
  })

  const tolerated = fixture.tolerated.map(regex)
  const isTolerated = (f: FindingItem) => tolerated.some((r) => r.test(findingText(f)))
  const falsePositiveDetails: BenchmarkFixtureResult['falsePositiveDetails'] = []
  for (const f of input.findings) {
    if (!PROBLEM_SEVERITIES.has(f.severity)) continue
    const absent = fixture.absent.find((a) => regex(a.match).test(findingText(f)))
    if (absent && !matchedRefs.has(f.ref)) {
      falsePositiveDetails.push({ ref: f.ref, title: f.title, reason: `Claims something known to be absent: ${absent.description}` })
      continue
    }
    // On a healthy fixture, any medium-or-worse problem that is not explained by the environment is unexpected.
    if (fixture.healthy && !matchedRefs.has(f.ref) && !isTolerated(f) && SEVERITY_ORDER.indexOf(f.severity) <= SEVERITY_ORDER.indexOf('medium')) {
      falsePositiveDetails.push({ ref: f.ref, title: f.title, reason: `Unexpected ${f.severity} finding on a healthy fixture` })
    }
  }

  const unsupportedDetails = input.findings
    .filter((f) => f.evidenceRefs.length === 0)
    .map((f) => ({ ref: f.ref, title: f.title, reason: 'No evidence cited' }))

  const scored = issues.filter((i) => i.deterministic)
  const found = scored.filter((i) => i.found)
  return {
    fixture: fixture.id,
    healthy: fixture.healthy,
    auditId: input.auditId,
    status: input.status,
    durationMs: input.durationMs,
    auditorTurns: input.auditorTurns,
    findings: input.findings.length,
    known: scored.length,
    found: found.length,
    missed: scored.length - found.length,
    falsePositives: falsePositiveDetails.length,
    unsupported: unsupportedDetails.length,
    severityCorrect: found.filter((i) => i.severityCorrect).length,
    evidenceLinked: found.filter((i) => i.evidenceLinked).length,
    issues,
    falsePositiveDetails,
    unsupportedDetails,
    error: input.error ?? null,
  }
}

/** Run totals across fixtures (averages only over fixtures that produced a value). */
export function benchmarkTotals(results: BenchmarkFixtureResult[]): NonNullable<BenchmarkRunItem['totals']> {
  const sum = (pick: (r: BenchmarkFixtureResult) => number) => results.reduce((n, r) => n + pick(r), 0)
  const avg = (values: (number | null)[]) => {
    const real = values.filter((v): v is number => v !== null)
    return real.length ? Math.round(real.reduce((a, b) => a + b, 0) / real.length) : null
  }
  return {
    known: sum((r) => r.known),
    found: sum((r) => r.found),
    missed: sum((r) => r.missed),
    falsePositives: sum((r) => r.falsePositives),
    unsupported: sum((r) => r.unsupported),
    severityCorrect: sum((r) => r.severityCorrect),
    avgDurationMs: avg(results.map((r) => r.durationMs)),
    avgAuditorTurns: avg(results.map((r) => r.auditorTurns)),
  }
}
