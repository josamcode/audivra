import type { EvidenceItem, FindingBrief, FindingItem } from '@audivra/contracts'

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
