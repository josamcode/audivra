import { describe, expect, it } from 'vitest'
import type { ChangeInsight, ClientBriefContent } from '@audivra/contracts'
import type { ChangeFactIndex } from '@audivra/insights'
import { validateChangeAnalysis, validateClientBrief, validateJourneyAnalysis } from '../src/validate-intelligence.ts'
import { OutputValidationError } from '../src/validate.ts'

describe('journey analysis (audits from before journeys)', () => {
  const step = (label: string, evidenceIds: string[], status: 'ok' | 'friction' | 'blocked' | 'unverified' = 'ok') => ({
    label,
    url: `https://example.com/${label.toLowerCase()}`,
    kind: 'page' as const,
    action: '',
    conversionType: null,
    status,
    note: '',
    evidenceIds,
  })
  const analysis = {
    journeys: [
      {
        id: 'J1',
        journeyKey: 'Contact Form',
        type: 'lead',
        name: 'Contact form enquiry',
        goal: 'Send an enquiry',
        description: 'Home → Contact',
        isPrimary: false,
        confidence: 0.7,
        steps: [step('Home', ['EV-1']), step('Contact', ['EV-2'], 'friction')],
        health: [],
      },
      {
        id: 'J2',
        journeyKey: 'whatsapp-booking',
        type: 'booking',
        name: 'WhatsApp booking',
        goal: 'Book',
        description: 'Service → WhatsApp',
        isPrimary: true,
        confidence: 0.8,
        steps: [step('Service', ['EV-3']), step('WhatsApp', ['EV-4'])],
        health: [],
      },
    ],
    findingLinks: [
      { findingId: 'f2', journeyIds: ['J2'] },
      { findingId: 'F9', journeyIds: ['J1'] },
      { findingId: 'F1', journeyIds: ['J7'] },
    ],
    notes: 'From the stored crawl and evidence.',
  }

  it('cleans keys, puts the primary journey first and renumbers the links', () => {
    const { analysis: out, issues } = validateJourneyAnalysis(analysis, new Set(['EV-1', 'EV-2', 'EV-3', 'EV-4']), new Set(['F1', 'F2']))
    expect(out.journeys.map((j) => [j.id, j.name, j.journeyKey])).toEqual([
      ['J1', 'WhatsApp booking', 'whatsapp-booking'],
      ['J2', 'Contact form enquiry', 'contact-form'],
    ])
    // F2 affected the WhatsApp journey (J2 before renumbering, J1 after); unknown findings/journeys are dropped.
    expect(out.findingLinks).toEqual([{ findingId: 'F2', journeyIds: ['J1'] }])
    expect(issues.some((i) => i.message.includes('F9'))).toBe(true)
  })

  it('drops journeys whose evidence does not exist', () => {
    const { analysis: out } = validateJourneyAnalysis(analysis, new Set(['EV-3', 'EV-4']), new Set(['F1', 'F2']))
    expect(out.journeys.map((j) => j.name)).toEqual(['WhatsApp booking'])
  })
})

function facts(overrides: Partial<ChangeFactIndex> = {}): ChangeFactIndex {
  return {
    currentFindings: new Map([
      ['F1', 'new'],
      ['F2', 'unchanged'],
      ['F3', 'regressed'],
    ]),
    previousFindings: new Map([
      ['F2', 'unchanged'],
      ['F4', 'resolved'],
      ['F5', 'regressed'],
    ]),
    metrics: new Map([
      ['lighthouse:/:mobile:lcp', 'regressed'],
      ['lighthouse:/:mobile:cls', 'unchanged'],
    ]),
    journeys: new Map([['whatsapp-booking', 'changed']]),
    trackingChanged: false,
    technologyChanged: false,
    coverageChanged: false,
    currentEvidence: new Set(['EV-1', 'EV-2']),
    ...overrides,
  }
}

const insight = (overrides: Partial<ChangeInsight>): ChangeInsight => ({
  kind: 'regression',
  importance: 'high',
  title: 'Something changed',
  description: 'Details.',
  basis: 'observed',
  currentFindingIds: [],
  previousFindingIds: [],
  journeyKeys: [],
  metricKeys: [],
  evidenceIds: [],
  ...overrides,
})

describe('change intelligence validation', () => {
  const titles = new Map([['F4', 'Contact form fields have no labels']])

  it('keeps insights the comparison supports and drops the rest', () => {
    const { analysis, issues } = validateChangeAnalysis(
      {
        headline: 'Mobile performance regressed',
        summary: 'LCP got worse.',
        insights: [
          insight({ kind: 'regression', title: 'Mobile LCP regressed', metricKeys: ['lighthouse:/:mobile:lcp'], evidenceIds: ['ev-1'] }),
          insight({ kind: 'improvement', title: 'CLS improved', metricKeys: ['lighthouse:/:mobile:cls'] }),
          insight({ kind: 'new-issue', title: 'New certificate error', currentFindingIds: ['f1'] }),
          insight({ kind: 'new-issue', title: 'Not actually new', currentFindingIds: ['F2'] }),
          insight({ kind: 'journey', title: 'Booking journey changed', journeyKeys: ['whatsapp-booking', 'invented-journey'] }),
          insight({ kind: 'technology', title: 'Framework changed' }),
        ],
      },
      facts(),
      titles,
    )
    expect(analysis.insights.map((i) => i.title)).toEqual(['Mobile LCP regressed', 'New certificate error', 'Booking journey changed'])
    expect(analysis.insights[0]!.evidenceIds).toEqual(['EV-1'])
    expect(analysis.insights[1]!.currentFindingIds).toEqual(['F1'])
    expect(analysis.insights[2]!.journeyKeys).toEqual(['whatsapp-booking'])
    expect(issues.filter((i) => i.message.startsWith('Dropped'))).toHaveLength(3)
  })

  it('never presents "not found again" as a verified fix', () => {
    const { analysis, issues } = validateChangeAnalysis(
      {
        headline: 'One issue was not found again',
        summary: '',
        insights: [insight({ kind: 'not-found-again', basis: 'verified', title: 'Contact form labels fixed', previousFindingIds: ['F4'] })],
      },
      facts(),
      titles,
    )
    expect(analysis.insights[0]!.basis).toBe('observed')
    expect(analysis.insights[0]!.title).toBe('Not found again: Contact form fields have no labels')
    expect(issues.some((i) => i.message.includes('claimed a fix'))).toBe(true)
  })

  it('does not accept "not found again" for an issue that is still present', () => {
    const { analysis } = validateChangeAnalysis(
      { headline: 'x x x x x', summary: '', insights: [insight({ kind: 'not-found-again', title: 'The issue is gone', previousFindingIds: ['F2'] })] },
      facts(),
      titles,
    )
    expect(analysis.insights).toHaveLength(0)
  })
})

function brief(overrides: Partial<ClientBriefContent> = {}): ClientBriefContent {
  return {
    businessSummary: 'A clinic.',
    primaryConversion: 'WhatsApp booking',
    primaryJourney: { journeyId: 'j1', path: 'Service → WhatsApp', biggestFriction: 'No event fires.' },
    quick: {
      topIssues: [
        { findingId: 'f1', headline: 'WhatsApp button hidden on mobile', why: 'Most visitors are on phones.' },
        { findingId: 'F42', headline: 'Invented issue', why: 'Not in the audit.' },
      ],
      bestOpportunity: { title: 'Fix the button', why: 'Quick win.', findingIds: ['F1', 'F42'] },
      proofPoints: [{ text: 'The button starts below the fold at 390 px.', findingId: 'F1', evidenceId: 'ev-9' }],
      suggestedOpener: 'I looked at how patients book on your site.',
    },
    meeting: {
      context: 'Clinic.',
      journeys: [
        { journeyId: 'J1', summary: 'Booking via WhatsApp.' },
        { journeyId: 'J5', summary: 'Invented.' },
      ],
      topIssues: [],
      sinceLastAudit: [],
      questions: [],
      uncertainties: [],
      opportunities: [],
      proofToShow: [],
    },
    talkingPoints: ['Booking happens on WhatsApp.', 'The button is hidden on phones.', 'No booking is measured.'],
    technical: {
      items: [
        { findingId: 'F1', title: 't', evidence: 'e', likelyCause: 'c', direction: 'd', pages: [], priority: 'now' },
        { findingId: 'F77', title: 't', evidence: 'e', likelyCause: 'c', direction: 'd', pages: [], priority: 'later' },
      ],
    },
    ...overrides,
  }
}

describe('client brief validation', () => {
  const refs = { findings: new Set(['F1', 'F2']), journeys: new Set(['J1']), evidence: new Set(['EV-9']) }

  it('keeps only references that exist in this audit', () => {
    const { brief: out, issues } = validateClientBrief(brief(), refs)
    expect(out.quick.topIssues.map((i) => i.findingId)).toEqual(['F1'])
    expect(out.quick.bestOpportunity!.findingIds).toEqual(['F1'])
    expect(out.quick.proofPoints[0]).toMatchObject({ findingId: 'F1', evidenceId: 'EV-9' })
    expect(out.primaryJourney!.journeyId).toBe('J1')
    expect(out.meeting.journeys.map((j) => j.journeyId)).toEqual(['J1'])
    expect(out.technical.items.map((i) => i.findingId)).toEqual(['F1'])
    expect(issues.length).toBeGreaterThanOrEqual(4)
  })

  it('rejects a brief that cites no real finding', () => {
    const invented = brief({
      quick: { ...brief().quick, topIssues: [{ findingId: 'F42', headline: 'Invented issue', why: 'Not in the audit.' }] },
    })
    expect(() => validateClientBrief(invented, refs)).toThrow(OutputValidationError)
  })

  it('drops the primary journey when it does not exist', () => {
    const { brief: out } = validateClientBrief(brief({ primaryJourney: { journeyId: 'J9', path: 'x', biggestFriction: 'y' } }), refs)
    expect(out.primaryJourney).toBeNull()
  })
})
