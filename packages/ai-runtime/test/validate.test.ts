import { describe, expect, it } from 'vitest'
import type { AuditDraft, DraftFinding, ReviewResult } from '@audivra/contracts'
import {
  fallbackFinal,
  normalizeRef,
  OutputValidationError,
  validateDraft,
  validateFinal,
  validateReview,
} from '../src/validate.ts'

function finding(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: 'D1',
    title: 'Primary CTA hidden on mobile',
    category: 'Conversion',
    severity: 'high',
    type: 'verified',
    description: 'desc',
    observed: 'observed',
    affectedUrls: ['https://example.com/'],
    confidence: 0.9,
    evidenceIds: ['EV-1'],
    whyItMatters: 'why',
    businessImpact: 'impact',
    businessImpactLevel: 'high',
    recommendation: 'fix',
    effort: 'low',
    opportunity: null,
    ...overrides,
  }
}

function draft(findings: DraftFinding[]): AuditDraft {
  return {
    businessUnderstanding: {
      summary: 'A clinic',
      businessType: 'Lead gen',
      businessModel: 'Paid treatments',
      acquisitionSignals: [],
      likelyCustomers: 'Patients',
      primaryConversion: 'WhatsApp',
      secondaryConversions: [],
      confidence: 0.7,
      assumptions: [],
      evidenceIds: ['EV-1', 'EV-99'],
    },
    importantPageTypes: [],
    investigationSummary: 'summary',
    pagesInspected: [],
    technologies: [],
    findings,
    limitations: [],
    suggestedFurtherVerification: [],
  }
}

const refs = new Set(['EV-1', 'EV-2', 'EV-3'])

describe('normalizeRef', () => {
  it('canonicalizes evidence references', () => {
    expect(normalizeRef(' ev-12 ')).toBe('EV-12')
    expect(normalizeRef('EV7')).toBe('EV-7')
    expect(normalizeRef('E-1')).toBe('E-1')
  })
})

describe('validateDraft', () => {
  it('rejects nonexistent evidence references and reports them', () => {
    const { draft: out, issues } = validateDraft(
      draft([finding({ evidenceIds: ['EV-1', 'ev-2', 'EV-404'] })]),
      refs,
    )
    expect(out.findings[0]!.evidenceIds).toEqual(['EV-1', 'EV-2'])
    expect(out.businessUnderstanding.evidenceIds).toEqual(['EV-1'])
    expect(issues.some((i) => i.message.includes('EV-404'))).toBe(true)
  })

  it('downgrades findings that lose all evidence instead of presenting them as verified', () => {
    const { draft: out } = validateDraft(
      draft([finding({ evidenceIds: ['EV-500'], confidence: 0.95 })]),
      refs,
    )
    expect(out.findings[0]!.type).toBe('inference')
    expect(out.findings[0]!.confidence).toBeLessThanOrEqual(0.5)
  })

  it('renames duplicate finding IDs', () => {
    const { draft: out } = validateDraft(draft([finding(), finding()]), refs)
    expect(new Set(out.findings.map((f) => f.id)).size).toBe(2)
  })

  it('throws a structured error for schema violations', () => {
    expect(() => validateDraft({ findings: 'nope' }, refs)).toThrow(OutputValidationError)
  })
})

const baseFinal = (findings: unknown[]) => ({
  executiveSummary: 'summary',
  businessUnderstanding: draft([]).businessUnderstanding,
  importantPageTypes: [],
  technologies: [],
  findings,
  opportunities: [
    { title: 'Fix CTA', why: 'x', scope: 'y', relatedFindingIds: ['F1', 'F9'], impact: 'high', effort: 'low' },
  ],
  limitations: [],
  pagesInspected: [],
})

describe('validateFinal', () => {
  const d = draft([
    finding({ id: 'D1', severity: 'medium', evidenceIds: ['EV-1'] }),
    finding({ id: 'D2', evidenceIds: ['EV-2'] }),
  ])

  it('rejects findings that do not derive from a draft finding', () => {
    const { final, issues } = validateFinal(
      baseFinal([{ ...finding({ id: 'F1' }), sourceFindingIds: ['D77'], verificationStatus: 'unreviewed' }]),
      d,
      null,
      refs,
    )
    expect(final.findings).toHaveLength(0)
    expect(issues[0]!.message).toMatch(/no valid source/)
  })

  it('clamps severity escalations and strips evidence its sources never cited', () => {
    const { final } = validateFinal(
      baseFinal([
        {
          ...finding({ id: 'F1', severity: 'critical', evidenceIds: ['EV-1', 'EV-3'] }),
          sourceFindingIds: ['D1'],
          verificationStatus: 'reviewer-approved',
        },
      ]),
      d,
      null,
      refs,
    )
    expect(final.findings[0]!.severity).toBe('medium')
    expect(final.findings[0]!.evidenceIds).toEqual(['EV-1'])
    expect(final.opportunities[0]!.relatedFindingIds).toEqual(['F1'])
  })

  it('allows a severity raise that the reviewer proposed', () => {
    const review = {
      severityAdjustments: [{ findingId: 'D1', from: 'medium', to: 'high', reason: 'wider reach' }],
    } as unknown as ReviewResult
    const { final } = validateFinal(
      baseFinal([
        {
          ...finding({ id: 'F1', severity: 'high' }),
          sourceFindingIds: ['D1'],
          verificationStatus: 'revised',
        },
      ]),
      d,
      review,
      refs,
    )
    expect(final.findings[0]!.severity).toBe('high')
  })
})

describe('validateReview', () => {
  it('drops references to unknown findings', () => {
    const { review, issues } = validateReview(
      {
        overallAssessment: 'ok',
        approvedFindings: [{ findingId: 'D1', note: 'fine' }],
        rejectedFindings: [{ findingId: 'D9', reason: 'unknown' }],
        findingsNeedingVerification: [],
        severityAdjustments: [],
        duplicates: [{ findingIds: ['D1', 'D8'], reason: 'dup' }],
        missingAreas: [],
        priorityProblems: [],
        materialGaps: false,
      },
      draft([finding()]),
    )
    expect(review.rejectedFindings).toHaveLength(0)
    expect(review.duplicates).toHaveLength(0)
    expect(issues.length).toBe(2)
  })
})

describe('fallbackFinal', () => {
  it('applies reviewer decisions mechanically without adding content', () => {
    const d = draft([
      finding({ id: 'D1', severity: 'low', confidence: 0.6 }),
      finding({ id: 'D2', severity: 'high' }),
      finding({ id: 'D3', severity: 'medium', affectedUrls: ['https://example.com/a'] }),
      finding({
        id: 'D4',
        severity: 'medium',
        affectedUrls: ['https://example.com/b'],
        evidenceIds: ['EV-3'],
      }),
    ])
    const review: ReviewResult = {
      overallAssessment: 'x',
      approvedFindings: [{ findingId: 'D2', note: 'ok' }],
      rejectedFindings: [{ findingId: 'D1', reason: 'unsupported' }],
      findingsNeedingVerification: [{ findingId: 'D3', concern: 'c', suggestedCheck: 's' }],
      severityAdjustments: [],
      duplicates: [{ findingIds: ['D3', 'D4'], reason: 'same template' }],
      missingAreas: [],
      priorityProblems: [],
      materialGaps: true,
    }
    const final = fallbackFinal(d, review)
    expect(final.findings.map((f) => f.sourceFindingIds)).toEqual([['D2'], ['D3', 'D4']])
    expect(final.findings[0]!.verificationStatus).toBe('reviewer-approved')
    expect(final.findings[1]!.type).toBe('supported-observation')
    expect(final.findings[1]!.affectedUrls).toEqual(['https://example.com/a', 'https://example.com/b'])
    expect(final.findings[1]!.evidenceIds).toEqual(['EV-1', 'EV-3'])
    expect(final.limitations.at(-1)).toMatchObject({ kind: 'environment', text: expect.stringMatching(/finalization did not complete/) })
    // Fallback findings get deterministic, unique issue keys.
    expect(final.findings.every((f) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.issueKey))).toBe(true)
  })
})
