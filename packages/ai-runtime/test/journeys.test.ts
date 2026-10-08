import { describe, expect, it } from 'vitest'
import type { AuditDraft, DraftFinding, DraftJourney, FinalJourney, ReviewResult } from '@audivra/contracts'
import {
  cleanJourneyKey,
  deriveJourneyKey,
  fallbackFinal,
  normalizeJourneyId,
  validateDraft,
  validateFinal,
  validateReview,
} from '../src/validate.ts'

function finding(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: 'D1',
    title: 'WhatsApp button hidden on mobile',
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
    journeyIds: [],
    ...overrides,
  }
}

function journey(overrides: Partial<DraftJourney> = {}): DraftJourney {
  return {
    id: 'J1',
    type: 'booking',
    name: 'WhatsApp booking from a service page',
    goal: 'Book an appointment',
    description: 'Service page → WhatsApp',
    isPrimary: true,
    confidence: 0.8,
    steps: [
      { label: 'Service page', url: 'https://example.com/implants', kind: 'page', action: 'Taps WhatsApp', conversionType: null, status: 'ok', note: '', evidenceIds: ['EV-1'] },
      { label: 'WhatsApp chat', url: null, kind: 'outcome', action: '', conversionType: 'whatsapp', status: 'friction', note: 'Opens wa.me', evidenceIds: ['EV-2'] },
    ],
    health: [{ dimension: 'tracking', status: 'problem', note: 'No event fires', evidenceIds: ['EV-2'], findingIds: ['D1'] }],
    ...overrides,
  }
}

function draft(findings: DraftFinding[], journeys: DraftJourney[]): AuditDraft {
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
      evidenceIds: [],
    },
    importantPageTypes: [],
    investigationSummary: 'summary',
    pagesInspected: [],
    technologies: [],
    findings,
    journeys,
    limitations: [],
    suggestedFurtherVerification: [],
  }
}

const refs = new Set(['EV-1', 'EV-2', 'EV-3'])

describe('journey keys and IDs', () => {
  it('normalizes model-written journey IDs', () => {
    expect(normalizeJourneyId(' j1 ')).toBe('J1')
    expect(normalizeJourneyId('J-02')).toBe('J2')
    expect(normalizeJourneyId('journey')).toBe('journey')
  })

  it('keeps valid keys and derives one from type and name otherwise', () => {
    expect(cleanJourneyKey('WhatsApp_Booking', 'booking', 'x')).toBe('whatsapp-booking')
    expect(cleanJourneyKey('', 'lead', 'Contact form enquiry')).toBe(deriveJourneyKey('lead', 'Contact form enquiry'))
    expect(deriveJourneyKey('lead', 'Contact form enquiry')).toMatch(/^lead-[a-z0-9-]+$/)
  })
})

describe('auditor journeys', () => {
  it('keeps evidence-backed journeys and links findings to them', () => {
    const { draft: d, issues } = validateDraft(draft([finding({ journeyIds: ['j1', 'J9'] })], [journey()]), refs)
    expect(d.journeys).toHaveLength(1)
    expect(d.journeys[0]!.isPrimary).toBe(true)
    expect(d.findings[0]!.journeyIds).toEqual(['J1'])
    expect(issues.some((i) => i.message.includes('unknown journey "J9"'))).toBe(true)
  })

  it('drops a journey without any valid evidence instead of inventing one', () => {
    const unsupported = journey({
      id: 'J2',
      isPrimary: false,
      steps: [
        { label: 'Home', url: 'https://example.com/', kind: 'page', action: '', conversionType: null, status: 'ok', note: '', evidenceIds: ['EV-404'] },
        { label: 'Form', url: null, kind: 'outcome', action: '', conversionType: 'form', status: 'ok', note: '', evidenceIds: [] },
      ],
      health: [],
    })
    const { draft: d, issues } = validateDraft(draft([finding()], [journey(), unsupported]), refs)
    expect(d.journeys.map((j) => j.id)).toEqual(['J1'])
    expect(issues.some((i) => i.message.includes('dropped'))).toBe(true)
  })

  it('needs evidence for problems: unproven friction becomes unverified, unproven verdicts unknown', () => {
    const j = journey({
      steps: [
        { label: 'Service page', url: 'https://example.com/implants', kind: 'page', action: '', conversionType: null, status: 'ok', note: '', evidenceIds: ['EV-1'] },
        { label: 'Booking form', url: 'https://example.com/book', kind: 'page', action: '', conversionType: 'form', status: 'blocked', note: 'Claimed broken', evidenceIds: [] },
      ],
      health: [
        { dimension: 'mobile', status: 'problem', note: 'Claimed', evidenceIds: [], findingIds: [] },
        { dimension: 'tracking', status: 'warning', note: 'Linked to a finding', evidenceIds: [], findingIds: ['D1'] },
      ],
    })
    const { draft: d } = validateDraft(draft([finding()], [j]), refs)
    expect(d.journeys[0]!.steps[1]!.status).toBe('unverified')
    expect(d.journeys[0]!.health.find((h) => h.dimension === 'mobile')!.status).toBe('unknown')
    expect(d.journeys[0]!.health.find((h) => h.dimension === 'tracking')!.status).toBe('warning')
  })

  it('allows only one primary journey', () => {
    const second = journey({ id: 'J2', name: 'Contact form enquiry', type: 'lead' })
    const { draft: d } = validateDraft(draft([finding()], [journey(), second]), refs)
    expect(d.journeys.filter((j) => j.isPrimary)).toHaveLength(1)
    expect(d.journeys[0]!.isPrimary).toBe(true)
  })
})

describe('reviewer and finalizer journeys', () => {
  const base = validateDraft(draft([finding({ journeyIds: ['J1'] })], [journey()]), refs).draft

  it('filters reviewer verdicts on journeys that do not exist', () => {
    const review: ReviewResult = {
      overallAssessment: '',
      approvedFindings: [],
      rejectedFindings: [],
      findingsNeedingVerification: [],
      severityAdjustments: [],
      duplicates: [],
      missingAreas: [],
      priorityProblems: [],
      materialGaps: false,
      journeyReview: [
        { journeyId: 'j1', verdict: 'approved', reason: 'ok' },
        { journeyId: 'J7', verdict: 'rejected', reason: 'invented' },
      ],
    }
    const { review: checked } = validateReview(review, base)
    expect(checked.journeyReview).toEqual([{ journeyId: 'J1', verdict: 'approved', reason: 'ok' }])
  })

  function finalJourney(overrides: Partial<FinalJourney> = {}): FinalJourney {
    const { id: _id, ...rest } = journey()
    return { id: 'J1', journeyKey: 'whatsapp-booking', sourceJourneyIds: ['J1'], ...rest, ...overrides }
  }

  function final(journeys: FinalJourney[], journeyIds: string[] = ['J1']) {
    return {
      executiveSummary: 'x',
      businessUnderstanding: base.businessUnderstanding,
      importantPageTypes: [],
      technologies: [],
      findings: [{ ...finding({ journeyIds }), id: 'F1', issueKey: 'conversion-whatsapp-hidden', sourceFindingIds: ['D1'], verificationStatus: 'reviewer-approved' }],
      journeys,
      opportunities: [],
      limitations: [],
      pagesInspected: [],
    }
  }

  it('preserves supported journeys and their finding links', () => {
    const { final: f } = validateFinal(final([finalJourney()]), base, null, refs)
    expect(f.journeys).toHaveLength(1)
    expect(f.journeys[0]!.journeyKey).toBe('whatsapp-booking')
    expect(f.findings[0]!.journeyIds).toEqual(['J1'])
  })

  it('rejects journeys without a source draft journey and evidence the source never cited', () => {
    const invented = finalJourney({ id: 'J2', journeyKey: 'invented', sourceJourneyIds: ['J9'], isPrimary: false })
    const widened = finalJourney({
      steps: journey().steps.map((s, i) => (i === 0 ? { ...s, evidenceIds: ['EV-1', 'EV-3'] } : s)),
    })
    const { final: f, issues } = validateFinal(final([widened, invented], ['J1', 'J2']), base, null, refs)
    expect(f.journeys.map((j) => j.id)).toEqual(['J1'])
    expect(f.journeys[0]!.steps[0]!.evidenceIds).toEqual(['EV-1'])
    expect(f.findings[0]!.journeyIds).toEqual(['J1'])
    expect(issues.some((i) => i.message.includes('no valid source draft journey'))).toBe(true)
    expect(issues.some((i) => i.message.includes('EV-3'))).toBe(true)
  })

  it('makes journey keys valid and unique', () => {
    const a = finalJourney({ journeyKey: 'Not A Key!' })
    const b = finalJourney({ id: 'J2', journeyKey: 'Not A Key!', isPrimary: false })
    const { final: f } = validateFinal(final([a, b]), base, null, refs)
    const keys = f.journeys.map((j) => j.journeyKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })

  it('fallback finalization keeps journeys the reviewer did not reject, primary first', () => {
    const secondary = journey({ id: 'J2', name: 'Contact form', type: 'lead', isPrimary: false })
    const rejected = journey({ id: 'J3', name: 'Invented newsletter', type: 'signup', isPrimary: false })
    const d = validateDraft(draft([finding({ journeyIds: ['J1', 'J3'] })], [secondary, journey(), rejected]), refs).draft
    const review: ReviewResult = {
      overallAssessment: '',
      approvedFindings: [{ findingId: 'D1', note: 'ok' }],
      rejectedFindings: [],
      findingsNeedingVerification: [],
      severityAdjustments: [],
      duplicates: [],
      missingAreas: [],
      priorityProblems: [],
      materialGaps: false,
      journeyReview: [{ journeyId: 'J3', verdict: 'rejected', reason: 'No evidence of a newsletter' }],
    }
    const f = fallbackFinal(d, review)
    expect(f.journeys.map((j) => j.name)).toEqual(['WhatsApp booking from a service page', 'Contact form'])
    expect(f.journeys[0]!.id).toBe('J1')
    expect(f.journeys[0]!.health[0]!.findingIds).toEqual(['F1'])
    expect(f.findings[0]!.journeyIds).toEqual(['J1'])
  })
})
