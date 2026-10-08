import { describe, expect, it } from 'vitest'
import {
  AuditDraft,
  CreateAuditInput,
  FinalAudit,
  normalizeTargetUrl,
  toAgentJsonSchema,
} from '../src/index.ts'

describe('normalizeTargetUrl', () => {
  it('adds https to bare domains and strips fragments and credentials', () => {
    const result = normalizeTargetUrl('  user:pass@Example.com/path#top ')
    expect(result).toEqual({
      ok: true,
      url: 'https://example.com/path',
      origin: 'https://example.com',
      domain: 'example.com',
    })
  })

  it('accepts localhost and IP targets with ports', () => {
    expect(normalizeTargetUrl('http://127.0.0.1:4321').ok).toBe(true)
    expect(normalizeTargetUrl('http://localhost:3000/x').ok).toBe(true)
  })

  it('rejects non-http schemes and junk', () => {
    expect(normalizeTargetUrl('ftp://example.com').ok).toBe(false)
    expect(normalizeTargetUrl('javascript:alert(1)').ok).toBe(false)
    expect(normalizeTargetUrl('file:///etc/passwd').ok).toBe(false)
    expect(normalizeTargetUrl('not a url').ok).toBe(false)
    expect(normalizeTargetUrl('intranet').ok).toBe(false)
    expect(normalizeTargetUrl('').ok).toBe(false)
  })
})

describe('CreateAuditInput', () => {
  it('validates the URL and optional client name', () => {
    expect(CreateAuditInput.safeParse({ url: 'example.com' }).success).toBe(true)
    expect(CreateAuditInput.safeParse({ url: 'example.com', clientName: 'Acme' }).success).toBe(true)
    const bad = CreateAuditInput.safeParse({ url: 'nope' })
    expect(bad.success).toBe(false)
  })
})

const finding = {
  id: 'D1',
  title: 'Booking CTA hidden on mobile',
  category: 'Conversion',
  severity: 'high',
  type: 'verified',
  description: 'The primary CTA is below the fold.',
  observed: 'At 390×844 the CTA starts at y=1210px.',
  affectedUrls: ['https://example.com/'],
  confidence: 0.9,
  evidenceIds: ['EV-3'],
  whyItMatters: 'Mobile visitors must scroll before they can act.',
  businessImpact: 'Adds friction before the primary conversion.',
  businessImpactLevel: 'high',
  recommendation: 'Move the CTA into the first viewport.',
  effort: 'low',
  opportunity: null,
}

const draft = {
  businessUnderstanding: {
    summary: 'Dental clinic',
    businessType: 'Local service lead generation',
    businessModel: 'Paid treatments',
    likelyCustomers: 'Patients in Cairo',
    primaryConversion: 'WhatsApp booking',
    secondaryConversions: [],
    acquisitionSignals: [],
    confidence: 0.8,
    assumptions: [],
    evidenceIds: [],
  },
  importantPageTypes: [],
  investigationSummary: 'Checked the homepage.',
  pagesInspected: ['https://example.com/'],
  technologies: [],
  findings: [finding],
  journeys: [],
  limitations: [],
  suggestedFurtherVerification: [],
}

describe('agent output schemas', () => {
  it('accepts a valid draft and rejects invalid enums', () => {
    expect(AuditDraft.safeParse(draft).success).toBe(true)
    expect(AuditDraft.safeParse({ ...draft, findings: [{ ...finding, severity: 'severe' }] }).success).toBe(
      false,
    )
    expect(AuditDraft.safeParse({ ...draft, findings: [{ ...finding, confidence: 1.4 }] }).success).toBe(
      false,
    )
  })

  it('requires final findings to cite at least one source draft finding', () => {
    const final = {
      executiveSummary: 'x',
      businessUnderstanding: draft.businessUnderstanding,
      importantPageTypes: [],
      technologies: [],
      findings: [{ ...finding, id: 'F1', sourceFindingIds: [], verificationStatus: 'reviewer-approved' }],
      opportunities: [],
      limitations: [],
      pagesInspected: [],
    }
    expect(FinalAudit.safeParse(final).success).toBe(false)
  })

  it('accepts drafts from before journeys existed', () => {
    const { journeys: _journeys, ...older } = draft
    const parsed = AuditDraft.safeParse({ ...older, findings: [finding] })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.journeys).toEqual([])
    expect(parsed.data?.findings[0]?.journeyIds).toEqual([])
  })

  it('produces a JSON schema suitable for the Claude CLI', () => {
    const schema = toAgentJsonSchema(AuditDraft)
    expect(schema.type).toBe('object')
    expect(schema.$schema).toBeUndefined()
    expect((schema.required as string[]).sort()).toEqual(Object.keys(draft).sort())
  })
})
