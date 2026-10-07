import { Artifact, ClientReport, type ArtifactType } from '@audivra/contracts'

/* Schema-validated sample data for every artifact type (used by tests and visual QA). */

const base = (type: ArtifactType, index: number, extra: Partial<Record<string, unknown>> = {}) => ({
  id: `art_fixture_${index}`,
  ref: `A${index}`,
  auditId: 'fixture0001',
  type,
  title: `Sample ${type.replace(/_/g, ' ')}`,
  subtitle: null,
  question: 'What does this visual show?',
  description: 'Fixture used for renderer tests.',
  evidenceIds: ['EV-3', 'EV-7'],
  findingIds: ['F1'],
  category: 'Performance',
  priority: 2,
  placement: 'report',
  createdBy: 'planner',
  createdAt: '2026-10-07T10:00:00.000Z',
  ...extra,
})

const d = (label: string, value: number, unit = 'none', extra: Record<string, unknown> = {}) => ({
  label,
  value,
  unit,
  evidenceId: 'EV-3',
  ...extra,
})

const raw: Record<ArtifactType, Record<string, unknown>> = {
  metric: { item: d('Largest Contentful Paint', 3012, 'ms', { tone: 'warning' }), caption: 'Arabic homepage, mobile lab run.' },
  metric_group: {
    items: [d('Pages discovered', 18, 'count'), d('Evidence items', 44, 'count'), d('Verified findings', 5, 'count'), d('High severity', 1, 'count', { tone: 'bad' })],
  },
  comparison_bar: {
    unit: 'ms',
    lowerIsBetter: true,
    items: [d('English homepage (/en)', 1840, 'ms', { tone: 'good' }), d('Arabic homepage (/ar)', 3012, 'ms', { tone: 'warning' })],
  },
  comparison_table: {
    columns: ['EN', 'AR'],
    rows: [
      { label: 'Performance', values: [d('EN', 99, 'score'), d('AR', 91, 'score')] },
      { label: 'LCP', values: [d('EN', 1800, 'ms'), d('AR', 3000, 'ms')] },
    ],
  },
  bar_chart: {
    unit: 'count',
    orientation: 'horizontal',
    items: [d('Broken links', 4, 'count'), d('Console errors', 2, 'count'), d('Failed requests', 3, 'count')],
  },
  stacked_bar: {
    segments: ['High', 'Medium', 'Low'],
    rows: [
      { label: 'Conversion', values: [d('High', 1, 'count'), d('Medium', 2, 'count'), d('Low', 0, 'count')] },
      { label: 'SEO', values: [d('High', 0, 'count'), d('Medium', 1, 'count'), d('Low', 2, 'count')] },
    ],
  },
  donut: { unit: 'kb', items: [d('JavaScript', 180, 'kb'), d('Images', 96, 'kb'), d('Fonts', 50, 'kb')] },
  line_chart: {
    unit: 'ms',
    lowerIsBetter: true,
    series: [
      {
        label: 'LCP (home, mobile)',
        metricKey: 'lh:/:mobile:lcp',
        points: [
          { x: '2026-09-01T10:00:00.000Z', value: 3400, auditId: 'a1' },
          { x: '2026-09-20T10:00:00.000Z', value: 2600, auditId: 'a2' },
          { x: '2026-10-07T10:00:00.000Z', value: 1900, auditId: 'a3' },
        ],
      },
    ],
  },
  trend_metric: {
    metricKey: 'links:broken',
    label: 'Broken links',
    unit: 'count',
    lowerIsBetter: true,
    points: [
      { x: '2026-09-01T10:00:00.000Z', value: 9, auditId: 'a1' },
      { x: '2026-10-07T10:00:00.000Z', value: 4, auditId: 'a2' },
    ],
  },
  matrix: {
    columns: ['lang', 'dir=rtl', 'hreflang', 'Translated meta'],
    rows: [
      { label: '/en', cells: [{ status: 'yes' }, { status: 'na' }, { status: 'yes' }, { status: 'yes' }] },
      { label: '/ar', cells: [{ status: 'yes' }, { status: 'no', note: 'dir missing', evidenceId: 'EV-5' }, { status: 'partial' }, { status: 'unknown' }] },
    ],
  },
  heatmap: {
    unit: 'count',
    columns: ['SEO', 'Mobile', 'A11y'],
    rows: [
      { label: '/', values: [d('SEO', 2, 'count'), d('Mobile', 1, 'count'), d('A11y', 3, 'count')] },
      { label: '/contact', values: [d('SEO', 0, 'count'), null, d('A11y', 2, 'count')] },
    ],
  },
  tracking_coverage: {
    rows: [
      { name: 'GA4', kind: 'analytics', present: 'yes', eventObserved: 'no', note: 'page_view only', evidenceId: 'EV-9' },
      { name: 'Google Tag Manager', kind: 'tag-manager', present: 'no', eventObserved: 'na' },
      { name: 'WhatsApp click', kind: 'conversion-channel', present: 'yes', eventObserved: 'no' },
    ],
  },
  page_performance: {
    formFactor: 'mobile',
    columns: ['performance', 'lcp', 'cls', 'accessibility'],
    rows: [
      { url: 'https://josamcode.com/en', values: { performance: d('Performance', 99, 'score'), lcp: d('LCP', 1840, 'ms'), cls: d('CLS', 0, 'none'), accessibility: d('Accessibility', 100, 'score') } },
      { url: 'https://josamcode.com/ar', label: 'Arabic home', values: { performance: d('Performance', 88, 'score'), lcp: d('LCP', 3012, 'ms'), cls: d('CLS', 0.113, 'none'), accessibility: null } },
    ],
  },
  journey: {
    steps: [
      { label: 'Homepage', url: 'https://josamcode.com/en', kind: 'page', status: 'ok' },
      { label: 'Case studies', kind: 'page', status: 'ok' },
      { label: 'Contact (mailto:)', kind: 'action', status: 'friction', note: '12px text link', findingId: 'F2', evidenceId: 'EV-40' },
      { label: 'No measurable conversion event', kind: 'outcome', status: 'blocked', findingId: 'F3' },
    ],
  },
  funnel: {
    steps: [
      { label: 'Land on homepage', friction: 'none' },
      { label: 'Find contact option', friction: 'medium', note: 'CTA is a light 12px link on mobile' },
      { label: 'Send enquiry', friction: 'high', evidenceId: 'EV-40', findingId: 'F2' },
    ],
  },
  site_graph: {
    nodes: [
      { id: 'n0', label: '/', depth: 0, kind: 'page', findings: 2, maxSeverity: 'high' },
      { id: 'n1', label: '/about', depth: 1, kind: 'page', findings: 0, maxSeverity: null },
      { id: 'n2', label: '/work', depth: 1, kind: 'group', pageCount: 3, findings: 1, maxSeverity: 'medium' },
      { id: 'n3', label: '/contact', depth: 1, kind: 'page', findings: 1, maxSeverity: 'low' },
    ],
    edges: [
      { from: 'n0', to: 'n1' },
      { from: 'n0', to: 'n2' },
      { from: 'n0', to: 'n3' },
    ],
    totalPages: 6,
    truncated: true,
  },
  timeline: {
    items: [
      { label: 'First audit', at: '2026-09-01T10:00:00.000Z', kind: 'audit', status: 'neutral' },
      { label: 'www certificate fixed', at: '2026-09-20T10:00:00.000Z', kind: 'finding', status: 'ok' },
      { label: 'Arabic LCP regressed', at: '2026-10-07T10:00:00.000Z', kind: 'finding', status: 'warning', note: '+0.6 s' },
    ],
  },
  evidence_gallery: {
    items: [
      { evidenceId: 'EV-8', caption: 'Desktop homepage', imagePath: 'screenshots/home-desktop.png' },
      { evidenceId: 'EV-9', caption: 'Mobile homepage (no image)' },
    ],
  },
  annotated_screenshot: {
    evidenceId: 'EV-43',
    imagePath: 'screenshots/home-mobile.png',
    imageWidth: 780,
    imageHeight: 1688,
    regions: [
      { x: 0.05, y: 0.32, w: 0.4, h: 0.04, marker: '1', title: 'CTA is a 12px text link', description: 'Primary action is visually light.', severity: 'medium', findingId: 'F2' },
      { x: 0.05, y: 0.5, w: 0.9, h: 0.2, marker: '2', title: 'Body copy ≈ 10–11px', description: 'Half the visible text is ≤ 12px.', severity: 'low' },
    ],
  },
  before_after: {
    url: 'https://josamcode.com/en',
    viewport: '390×844',
    caption: 'Hero after the CTA redesign.',
    before: { auditId: 'prevaudit01', evidenceId: 'EV-9', imagePath: 'screenshots/en-mobile.png', date: '2026-09-01T10:00:00.000Z' },
    after: { auditId: 'fixture0001', evidenceId: 'EV-9', imagePath: 'screenshots/en-mobile.png', date: '2026-10-07T10:00:00.000Z' },
  },
  tech_map: {
    groups: [
      { label: 'Framework', items: [{ name: 'Next.js', confidence: 0.95, evidenceId: 'EV-6' }, { name: 'React', confidence: 0.9 }] },
      { label: 'Hosting', items: [{ name: 'Vercel', confidence: 0.95 }] },
      { label: 'Analytics', items: [{ name: 'None detected', confidence: 0.9 }] },
    ],
  },
  impact_effort: {
    items: [
      { label: 'Fix www certificate', impact: 'high', effort: 'low', findingIds: ['F1'] },
      { label: 'Add conversion tracking', impact: 'high', effort: 'low', findingIds: ['F3'] },
      { label: 'Trust content', impact: 'medium', effort: 'medium', findingIds: ['F5'] },
      { label: 'Arabic performance', impact: 'low', effort: 'medium', findingIds: ['F7'] },
    ],
  },
}

export const ARTIFACT_FIXTURES: Artifact[] = (Object.keys(raw) as ArtifactType[]).map((type, index) =>
  Artifact.parse(base(type, index + 1, { data: raw[type] })),
)

const reportFinding = (ref: string, severity: string, withProof: 'artifact' | 'image' | 'none') => ({
  ref,
  title: `${severity} finding ${ref}: www.example.com shows a certificate error for typed visits`,
  severity,
  category: 'Security',
  type: 'verified',
  confidence: 0.92,
  verificationStatus: 'reviewer-approved',
  description: 'The certificate covers only the apex domain.',
  observed: 'Chromium net::ERR_CERT_COMMON_NAME_INVALID on https://www.example.com/.',
  whyItMatters: 'Visitors who type www are blocked before seeing the site.',
  businessImpact: 'Prospects using the www address cannot reach the portfolio.',
  businessImpactLevel: 'high',
  recommendation: 'Add www to the certificate or redirect www to the apex at the edge.',
  effort: 'low',
  affectedUrls: ['https://www.example.com/', 'https://example.com/a-very-long-path/that/should/wrap/in/print/output?with=query&and=more'],
  evidenceRefs: ['EV-32', 'EV-44'],
  proof: {
    artifact: withProof === 'artifact' ? ARTIFACT_FIXTURES.find((a) => a.type === 'comparison_bar') : null,
    image: withProof === 'image' ? { evidenceRef: 'EV-8', path: 'screenshots/home-desktop.png', caption: 'Desktop homepage' } : null,
  },
})

export const REPORT_FIXTURE: ClientReport = ClientReport.parse({
  schema: 'audivra.report.v1',
  generatedAt: '2026-10-07T12:00:00.000Z',
  title: 'Website audit — example.com',
  site: { url: 'https://example.com/', domain: 'example.com', clientName: 'Example Co — موقع تجريبي' },
  audit: { date: '2026-10-07T10:00:00.000Z', durationMs: 1_201_000, status: 'completed', complete: true },
  snapshot: {
    lines: ['The site is fast and well indexed in both languages.', 'www visitors see a certificate error.', 'Nothing is measured: no analytics.'],
    findings: { total: 9, bySeverity: { critical: 0, high: 1, medium: 4, low: 3, info: 1 }, verified: 5, observed: 4, inferred: 0 },
    pages: { discovered: 18, crawled: 18, inspected: 6 },
    evidenceCount: 44,
    keyMetrics: [
      { label: 'Performance (mobile)', value: 99, unit: 'score', evidenceId: 'EV-7', tone: 'good' },
      { label: 'LCP (mobile)', value: 1840, unit: 'ms', evidenceId: 'EV-7', tone: 'good' },
    ],
  },
  business: {
    summary: 'Bilingual portfolio.',
    businessType: 'Freelance software engineering',
    businessModel: 'Project-based services',
    likelyCustomers: 'Businesses in Egypt and the Gulf',
    primaryConversion: 'Email enquiry',
    secondaryConversions: ['Phone call'],
    acquisitionSignals: ['LinkedIn profile', 'YouTube channel'],
    confidence: 0.85,
    assumptions: ['Client acquisition is the main goal.'],
    evidenceIds: ['EV-33'],
  },
  topRisks: [reportFinding('F1', 'high', 'none'), reportFinding('F2', 'medium', 'none')],
  featuredArtifacts: [ARTIFACT_FIXTURES.find((a) => a.type === 'metric_group')],
  majorFindings: [reportFinding('F1', 'high', 'artifact'), reportFinding('F2', 'medium', 'image')],
  categoryHighlights: [{ category: 'Tracking', takeaway: 'No analytics or conversion events are recorded.', artifacts: [ARTIFACT_FIXTURES.find((a) => a.type === 'tracking_coverage')], findingRefs: ['F3'] }],
  visuals: ARTIFACT_FIXTURES.filter((a) => ['page_performance', 'journey', 'annotated_screenshot'].includes(a.type)),
  opportunities: [
    { title: 'Domain & TLS fix', why: 'Removes a hard block for www visitors.', scope: 'Vercel domain redirect + HSTS.', impact: 'high', effort: 'low', findingRefs: ['F1'] },
    { title: 'Conversion tracking', why: 'Makes enquiries measurable.', scope: null, impact: 'medium', effort: 'low', findingRefs: ['F3'] },
  ],
  actionPlan: {
    doFirst: [{ title: 'Redirect www to the apex domain', why: 'Typed visits fail today.', findingRefs: ['F1'] }],
    then: [{ title: 'Add privacy-friendly analytics with contact events', why: 'Nothing is measured.', findingRefs: ['F3'] }],
    later: [],
  },
  comparison: null,
  appendix: {
    otherFindings: [reportFinding('F8', 'low', 'none')],
    artifacts: [ARTIFACT_FIXTURES.find((a) => a.type === 'tech_map')],
    coverage: [
      { capability: 'performance', label: 'Performance (Lighthouse)', status: 'ran', tools: ['lighthouse'], reason: null, detail: '1 page' },
      { capability: 'passive-scan', label: 'Passive security scan (ZAP)', status: 'unavailable', tools: [], reason: 'Docker image not pulled', detail: null },
    ],
    technologies: [{ name: 'Next.js', category: 'JS framework', confidence: 0.95, evidenceIds: ['EV-6'] }],
    pages: [{ url: 'https://example.com/', status: 200, title: 'Example', inspected: true }],
    limitations: [
      { kind: 'could-not-verify', text: 'End-to-end email delivery was not tested.' },
      { kind: 'environment', text: 'ZAP was unavailable during this run.' },
    ],
    methodology: ['Deterministic baseline, then an AI auditor with a real browser.'],
    fullAnalysis: 'First paragraph of the analysis.\n\n- **Bold point** one\n- point two',
  },
  images: { 'EV-8': 'screenshots/home-desktop.png' },
})
