import { describe, expect, it } from 'vitest'
import {
  AUDIT_TEMPLATES,
  BRIEF_MODES,
  briefText,
  ClientBriefContent,
  CreateAuditInput,
  DEFAULT_TEMPLATE_KEY,
  getTemplate,
  JOURNEY_TYPES,
  TEMPLATE_KEYS,
  templateRef,
} from '../src/index.ts'

describe('audit templates', () => {
  it('defines every template key once, versioned, with guidance for the auditor', () => {
    expect(AUDIT_TEMPLATES.map((t) => t.key).sort()).toEqual([...TEMPLATE_KEYS].sort())
    for (const template of AUDIT_TEMPLATES) {
      expect(template.version).toBeGreaterThanOrEqual(1)
      expect(template.name.length).toBeGreaterThan(2)
      expect(template.priorityAreas.length).toBeGreaterThan(0)
      expect(template.promptAddendum.trim().length).toBeGreaterThan(40)
      for (const type of template.suggestedJourneyTypes) expect(JOURNEY_TYPES).toContain(type)
    }
  })

  it('is guidance, not a checklist: no template asks for a fixed list of findings', () => {
    for (const template of AUDIT_TEMPLATES) {
      expect(template.promptAddendum).not.toMatch(/\b(must report|always report|checklist)\b/i)
    }
  })

  it('falls back to General website for unknown or missing keys', () => {
    expect(getTemplate(undefined).key).toBe(DEFAULT_TEMPLATE_KEY)
    expect(getTemplate(null).key).toBe('general')
    expect(getTemplate('nonsense').key).toBe('general')
    expect(getTemplate('portfolio').name).toMatch(/portfolio/i)
    expect(templateRef(getTemplate('ecommerce'))).toBe('ecommerce@v1')
  })

  it('accepts an optional template on new audits and rejects unknown ones', () => {
    expect(CreateAuditInput.safeParse({ url: 'example.com' }).success).toBe(true)
    expect(CreateAuditInput.safeParse({ url: 'example.com', template: 'lead-generation' }).success).toBe(true)
    expect(CreateAuditInput.safeParse({ url: 'example.com', template: 'crm' }).success).toBe(false)
  })
})

const brief: ClientBriefContent = ClientBriefContent.parse({
  businessSummary: 'A freelance engineer selling project work; likely B2B.',
  primaryConversion: 'Email enquiry',
  primaryJourney: { journeyId: 'J1', path: 'Homepage → Case study → Email link', biggestFriction: 'No contact link after case studies.' },
  quick: {
    topIssues: [{ findingId: 'F1', headline: 'www visitors see a certificate error', why: 'Typed visits fail before the site loads.' }],
    bestOpportunity: { title: 'Fix the domain redirect', why: 'Removes a hard block.', findingIds: ['F1'] },
    proofPoints: [{ text: 'Chromium reported ERR_CERT_COMMON_NAME_INVALID on https://www.example.com/', findingId: 'F1', evidenceId: 'EV-32' }],
    suggestedOpener: 'I noticed that the www version of your site shows a certificate warning.',
  },
  meeting: {
    context: 'Portfolio site for a freelance engineer.',
    journeys: [{ journeyId: 'J1', summary: 'Email enquiry from project pages.' }],
    topIssues: [{ findingId: 'F1', headline: 'www certificate error', why: 'Blocks typed visits.' }],
    sinceLastAudit: [],
    questions: [{ question: 'Do most enquiries arrive by email or LinkedIn?', basis: 'The audit cannot see off-site channels.' }],
    uncertainties: ['Email delivery could not be tested.'],
    opportunities: [{ title: 'Conversion tracking', why: 'Enquiries are not measured.' }],
    proofToShow: [],
  },
  talkingPoints: ['The site is fast.', 'www visits fail.', 'Nothing is measured.'],
  technical: {
    items: [
      {
        findingId: 'F1',
        title: 'Certificate covers only the apex',
        evidence: 'ERR_CERT_COMMON_NAME_INVALID on www.',
        likelyCause: 'Likely a missing www domain on the host.',
        direction: 'Add www to the certificate or redirect at the edge.',
        pages: ['https://www.example.com/'],
        priority: 'now',
      },
    ],
  },
})

describe('client brief text', () => {
  it('renders every mode with its references so points stay traceable', () => {
    for (const mode of BRIEF_MODES) {
      const text = briefText(brief, mode, 'example.com')
      expect(text.startsWith('# ')).toBe(true)
      expect(text).toContain('example.com')
      expect(text).not.toContain('undefined')
      expect(text.endsWith('\n')).toBe(true)
    }
    expect(briefText(brief, 'quick')).toContain('(F1)')
    expect(briefText(brief, 'quick')).toContain('F1, EV-32')
    expect(briefText(brief, 'meeting')).toContain('Why: The audit cannot see off-site channels.')
    expect(briefText(brief, 'technical')).toContain('## F1 · Certificate covers only the apex (Now)')
  })

  it('copies talking points as a plain list', () => {
    const text = briefText(brief, 'talking-points')
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(3)
  })

  it('leaves out empty sections', () => {
    const text = briefText(brief, 'meeting')
    expect(text).not.toContain('Since the last audit')
    expect(text).not.toContain('Proof to show')
  })
})
