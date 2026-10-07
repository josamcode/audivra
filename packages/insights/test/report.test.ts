import { describe, expect, it } from 'vitest'
import type { ReportPlan } from '@audivra/contracts'
import { fallbackSnapshot, sanitizeReportPlan, splitSentences } from '../src/report.ts'

const plan: ReportPlan = {
  executiveSnapshot: ['A dental clinic converting through WhatsApp.', 'Mobile visitors hit a layout overflow.', 'Fix the banner first.'],
  topRiskFindingIds: ['F1', 'f-2', 'F99'],
  topOpportunityTitles: ['mobile fix ', 'Made-up work'],
  featuredArtifactRefs: ['A1', 'a2', 'A9'],
  majorFindingIds: ['F1', 'F2', 'F3'],
  findingProof: [
    { findingId: 'F1', artifactRef: 'A1', evidenceId: null },
    { findingId: 'F2', artifactRef: 'A42', evidenceId: 'EV-5' },
    { findingId: 'F2', artifactRef: null, evidenceId: 'EV-6' },
    { findingId: 'F77', artifactRef: 'A1', evidenceId: null },
  ],
  categoryHighlights: [{ category: 'Mobile', takeaway: 'Layout breaks at 390px.', artifactRefs: ['A1', 'A5'], findingIds: ['F1', 'F8'] }],
  actionPlan: {
    doFirst: [{ title: 'Fix the promo banner width', why: 'It overflows.', findingIds: ['F1'] }],
    then: [{ title: 'Invented action', why: 'No finding behind it.', findingIds: ['F50'] }],
    later: [],
  },
}

const refs = {
  findings: new Set(['F1', 'F2', 'F3']),
  artifacts: new Set(['A1', 'A2']),
  images: new Set(['EV-5']),
  opportunityTitles: ['Mobile fix', 'Tracking setup'],
}

describe('report plan sanitizing', () => {
  it('keeps only references that exist, normalizing their spelling', () => {
    const { plan: clean, issues } = sanitizeReportPlan(plan, refs)
    expect(clean!.topRiskFindingIds).toEqual(['F1', 'F2'])
    expect(clean!.topOpportunityTitles).toEqual(['Mobile fix'])
    expect(clean!.featuredArtifactRefs).toEqual(['A1', 'A2'])
    expect(clean!.findingProof).toEqual([
      { findingId: 'F1', artifactRef: 'A1', evidenceId: null },
      { findingId: 'F2', artifactRef: null, evidenceId: 'EV-5' },
      { findingId: 'F2', artifactRef: null, evidenceId: null },
    ])
    expect(clean!.categoryHighlights[0]).toMatchObject({ artifactRefs: ['A1'], findingIds: ['F1'] })
    expect(clean!.actionPlan.then).toEqual([])
    expect(issues.join(' ')).toMatch(/F99/)
    expect(issues.join(' ')).toMatch(/EV-6 is not an image/)
  })

  it('falls back to the default layout when no valid top risk remains', () => {
    expect(sanitizeReportPlan({ ...plan, topRiskFindingIds: ['F42'] }, refs).plan).toBeNull()
  })
})

describe('executive snapshot fallback', () => {
  it('splits sentences without breaking domains or decimals', () => {
    expect(splitSentences('josamcode.com is a portfolio. LCP was 3.0 s on mobile. Fix it.')).toEqual([
      'josamcode.com is a portfolio.',
      'LCP was 3.0 s on mobile.',
      'Fix it.',
    ])
    expect(fallbackSnapshot('**Short.** This first sentence is long enough to keep.\n\nSecond paragraph sentence here is also kept.')).toEqual([
      'This first sentence is long enough to keep.',
      'Second paragraph sentence here is also kept.',
    ])
  })
})
