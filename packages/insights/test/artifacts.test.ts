import { describe, expect, it } from 'vitest'
import { ArtifactSpec, type MetricCatalogEntry, type SiteHistory } from '@audivra/contracts'
import { resolveArtifactSpec, type ResolveContext } from '../src/artifacts.ts'
import { buildMetricCatalog } from '../src/catalog.ts'
import { evidence, finding } from './helpers.ts'

const catalog: MetricCatalogEntry[] = [
  { key: 'lighthouse:/:mobile:lcp', label: 'LCP (mobile) /', value: 3012, unit: 'ms', url: 'https://example.com/', evidenceId: 'EV-4', group: 'Lighthouse', lowerIsBetter: true },
  { key: 'lighthouse:/ar:mobile:lcp', label: 'LCP (mobile) /ar', value: 4100, unit: 'ms', url: 'https://example.com/ar', evidenceId: 'EV-5', group: 'Lighthouse', lowerIsBetter: true },
  { key: 'lighthouse:/:mobile:performance', label: 'Performance', value: 91, unit: 'score', url: 'https://example.com/', evidenceId: 'EV-4', group: 'Lighthouse', lowerIsBetter: false },
]

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    evidence: [
      evidence('EV-1', { summary: 'The first product starts at 1,586 px; LCP was 2.4 s in the browser.' }),
      evidence('EV-2', { type: 'screenshot', artifactPath: 'screenshots/mobile-home.png', metadata: { viewport: '390x844' } }),
      evidence('EV-4'),
      evidence('EV-5'),
    ],
    findings: [finding('F1'), finding('F2')],
    catalog,
    summary: null,
    history: null,
    comparison: null,
    linkGraph: null,
    imageSize: async (p) => (p === 'screenshots/mobile-home.png' ? { width: 780, height: 1688 } : null),
    ...overrides,
  }
}

const spec = (type: string, data: Record<string, unknown>, extra: Partial<ArtifactSpec> = {}): ArtifactSpec =>
  ArtifactSpec.parse({
    type,
    title: 'A visual',
    question: 'What does this show?',
    description: 'Test visual.',
    evidenceIds: [],
    findingIds: [],
    category: null,
    priority: 2,
    placement: 'report',
    data,
    ...extra,
  })

describe('artifact grounding', () => {
  it('fills catalog values itself and links the evidence they came from', async () => {
    const { artifact, issues } = await resolveArtifactSpec(
      spec('comparison_bar', { unit: 'ms', lowerIsBetter: true, items: [{ label: 'English', metricKey: 'lighthouse:/:mobile:lcp', value: 1 }, { label: 'Arabic', metricKey: 'lighthouse:/ar/:mobile:lcp' }] }),
      context(),
    )
    expect(issues).toEqual([])
    const data = artifact!.data as { items: { value: number; evidenceId: string }[] }
    // The planner's number (1) is ignored: the catalog value is authoritative. Trailing slashes are tolerated.
    expect(data.items.map((i) => i.value)).toEqual([3012, 4100])
    expect(artifact!.evidenceRefs.sort()).toEqual(['EV-4', 'EV-5'])
  })

  it('accepts literal numbers only when they appear in the cited evidence (rounding and unit changes allowed)', async () => {
    const ok = await resolveArtifactSpec(
      spec('metric_group', { items: [{ label: 'First product', value: 1586, unit: 'px', evidenceId: 'EV-1' }, { label: 'LCP', value: 2400, unit: 'ms', evidenceId: 'ev1' }] }),
      context(),
    )
    expect(ok.artifact).not.toBeNull()
    const invented = await resolveArtifactSpec(spec('metric', { item: { label: 'Revenue lost', value: 48000, unit: 'count', evidenceId: 'EV-1' } }), context())
    expect(invented.artifact).toBeNull()
    expect(invented.issues.join(' ')).toMatch(/does not appear in EV-1/)
  })

  it('rejects non-finite values, unknown metric keys and visuals without any evidence', async () => {
    const nan = await resolveArtifactSpec(spec('metric', { item: { label: 'x', value: Number.NaN, evidenceId: 'EV-1' } }), context())
    expect(nan.artifact).toBeNull()
    const unknown = await resolveArtifactSpec(spec('metric', { item: { label: 'x', metricKey: 'lighthouse:/nope:mobile:lcp' } }), context())
    expect(unknown.issues.join(' ')).toMatch(/not in the catalog/)
    const journey = await resolveArtifactSpec(
      spec('journey', { steps: [{ label: 'Home', kind: 'page', status: 'ok' }, { label: 'Contact', kind: 'page', status: 'friction' }] }),
      context(),
    )
    expect(journey.artifact).toBeNull()
    expect(journey.issues.join(' ')).toMatch(/needs at least one piece of evidence/)
  })

  it('drops references to evidence and findings that do not exist', async () => {
    const { artifact, issues } = await resolveArtifactSpec(
      spec(
        'journey',
        { steps: [{ label: 'Home', kind: 'page', status: 'ok', evidenceId: 'EV-1' }, { label: 'Book', kind: 'action', status: 'blocked', evidenceId: 'EV-77', findingId: 'F9' }] },
        { evidenceIds: ['EV-1', 'EV-404'], findingIds: ['F1', 'F99'] },
      ),
      context(),
    )
    expect(artifact!.evidenceRefs).toEqual(['EV-1'])
    expect(artifact!.findingRefs).toEqual(['F1'])
    expect(issues.join(' ')).toMatch(/EV-77 does not exist/)
    expect(issues.join(' ')).toMatch(/finding F9 does not exist/)
  })

  it('never draws a trend from fewer than two real audits', async () => {
    const one = await resolveArtifactSpec(spec('trend_metric', { metricKey: 'lighthouse.performance' }), context())
    expect(one.artifact).toBeNull()
    const history: SiteHistory = {
      siteKey: 'example.com',
      audits: [],
      series: [
        {
          key: 'lighthouse.performance',
          label: 'Performance score',
          unit: 'score',
          lowerIsBetter: false,
          points: [
            { auditId: 'a1', at: '2026-10-01T00:00:00Z', value: 82 },
            { auditId: 'a2', at: '2026-10-08T00:00:00Z', value: 91 },
          ],
        },
      ],
    }
    const two = await resolveArtifactSpec(spec('trend_metric', { metricKey: 'lighthouse.performance' }), context({ history }))
    expect((two.artifact!.data as { points: unknown[] }).points).toHaveLength(2)
  })

  it('converts CSS-pixel regions from a 2x screenshot into image fractions and rejects regions off the image', async () => {
    const { artifact, issues } = await resolveArtifactSpec(
      spec('annotated_screenshot', {
        evidenceId: 'EV-2',
        coordinateSpace: 'css-px',
        viewportWidth: 390,
        regions: [
          { x: 20, y: 422, width: 350, height: 84, marker: '1', title: 'CTA below the fold', description: 'd' },
          { x: 20, y: 5000, width: 50, height: 50, marker: '2', title: 'Outside', description: 'd' },
        ],
      }),
      context(),
    )
    const regions = (artifact!.data as { regions: { x: number; y: number; w: number; h: number }[] }).regions
    expect(regions).toHaveLength(1)
    expect(regions[0]).toEqual({ x: 0.0513, y: 0.5, w: 0.8974, h: 0.0995, marker: '1', title: 'CTA below the fold', description: 'd', severity: undefined, findingId: undefined })
    expect(issues.join(' ')).toMatch(/outside the image/)
  })

  it('rejects unknown artifact types at the schema boundary', () => {
    expect(ArtifactSpec.safeParse({ type: 'pie3d', title: 'x', question: 'what?', description: '', evidenceIds: [], findingIds: [], category: null, priority: 1, placement: 'report', data: {} }).success).toBe(false)
  })
})

describe('metric catalog', () => {
  it('indexes numbers the auditor recorded under metadata.metrics', () => {
    const entries = buildMetricCatalog([evidence('EV-9', { source: 'auditor', metadata: { metrics: { first_product_top_px: 1586, lcp_ms: 3010, label: 'not a number' } } })])
    expect(entries.map((e) => [e.key, e.unit])).toEqual([
      ['evidence:EV-9:first_product_top_px', 'px'],
      ['evidence:EV-9:lcp_ms', 'ms'],
    ])
  })
})
