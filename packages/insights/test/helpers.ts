import type { EvidenceItem, FindingBrief, FindingItem, JourneyItem } from '@audivra/contracts'

export function evidence(ref: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: `id-${ref}`,
    ref,
    auditId: 'audit1',
    source: 'baseline',
    type: 'tool-result',
    title: `Evidence ${ref}`,
    summary: '',
    url: 'https://example.com/',
    artifactPath: null,
    metadata: {},
    createdAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  }
}

export function finding(ref: string, overrides: Partial<FindingItem> = {}): FindingItem {
  return {
    id: `fid-${ref}`,
    ref,
    auditId: 'audit1',
    title: `Finding ${ref}`,
    category: 'Performance',
    severity: 'medium',
    type: 'verified',
    description: 'd',
    observed: 'o',
    affectedUrls: ['https://example.com/'],
    confidence: 0.9,
    verificationStatus: 'reviewer-approved',
    whyItMatters: 'w',
    businessImpact: 'b',
    businessImpactLevel: 'medium',
    recommendation: 'r',
    effort: 'low',
    opportunity: null,
    evidenceRefs: ['EV-1'],
    issueKey: null,
    artifactRefs: [],
    createdBy: 'ai-auditor',
    rank: Number(ref.replace(/\D/g, '')) || 1,
    journeyRefs: [],
    ...overrides,
  }
}

export function brief(ref: string, overrides: Partial<FindingBrief> = {}): FindingBrief {
  return {
    ref,
    title: `Finding ${ref}`,
    severity: 'medium',
    category: 'Performance',
    issueKey: null,
    affectedUrls: ['https://example.com/'],
    ...overrides,
  }
}

export function journey(ref: string, overrides: Partial<JourneyItem> = {}): JourneyItem {
  return {
    id: `jid-${ref}`,
    ref,
    auditId: 'audit1',
    journeyKey: 'whatsapp-booking',
    type: 'booking',
    name: 'WhatsApp booking from a service page',
    goal: 'Book an appointment',
    description: '',
    isPrimary: true,
    confidence: 0.8,
    steps: [
      { label: 'Service page', url: 'https://example.com/implants', kind: 'page', action: 'Taps WhatsApp', conversionType: null, status: 'ok', note: '', evidenceIds: ['EV-1'] },
      { label: 'WhatsApp chat', url: null, kind: 'outcome', action: '', conversionType: 'whatsapp', status: 'ok', note: '', evidenceIds: ['EV-2'] },
    ],
    health: [{ dimension: 'tracking', status: 'healthy', note: 'Click event recorded', evidenceIds: ['EV-2'], findingIds: [] }],
    findingRefs: [],
    evidenceRefs: ['EV-1', 'EV-2'],
    source: 'audit',
    rank: Number(ref.replace(/\D/g, '')) || 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  }
}
