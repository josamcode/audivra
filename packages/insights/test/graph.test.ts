import { describe, expect, it } from 'vitest'
import { buildEvidenceGraph, GRAPH_MAX_DEPTH, pageKey, parseFocus, type GraphInput } from '../src/graph.ts'
import { finding, journey } from './helpers.ts'

function input(overrides: Partial<GraphInput> = {}): GraphInput {
  return {
    findings: [
      finding('F1', { title: 'WhatsApp button hidden on mobile', evidenceRefs: ['EV-1', 'EV-2'], journeyRefs: ['J1'], affectedUrls: ['https://example.com/implants'] }),
      finding('F2', { title: 'Slow LCP on the homepage', evidenceRefs: ['EV-3'], affectedUrls: ['https://example.com/'] }),
      finding('F3', { title: 'Shares EV-2 with F1', evidenceRefs: ['EV-2'], affectedUrls: [] }),
    ],
    evidence: [
      { ref: 'EV-1', type: 'screenshot', title: 'Mobile screenshot of /implants', url: 'https://example.com/implants', source: 'auditor', toolRunId: null, agentRunId: 'ar1' },
      { ref: 'EV-2', type: 'browser-observation', title: 'WhatsApp click', url: 'https://example.com/implants#book', source: 'auditor', toolRunId: null, agentRunId: 'ar1' },
      { ref: 'EV-3', type: 'metric', title: 'Lighthouse mobile', url: 'https://example.com/', source: 'baseline', toolRunId: 'tr1', agentRunId: null },
      { ref: 'EV-4', type: 'dom-observation', title: 'Unrelated capture on the homepage', url: 'https://example.com/', source: 'baseline', toolRunId: 'tr1', agentRunId: null },
    ],
    journeys: [journey('J1', { steps: journey('J1').steps.map((s) => ({ ...s, evidenceIds: s.evidenceIds.slice(0, 1).map(() => 'EV-1') })) })],
    artifacts: [{ ref: 'A1', title: 'Annotated mobile screenshot', type: 'annotated_screenshot', evidenceRefs: ['EV-1'], findingRefs: ['F1'] }],
    toolRuns: [{ id: 'tr1', tool: 'lighthouse', purpose: 'Performance of the homepage', status: 'completed' }],
    agentRuns: [{ id: 'ar1', role: 'auditor', status: 'completed' }],
    pages: [
      { url: 'https://example.com/', title: 'Home', pageType: 'home' },
      { url: 'https://example.com/implants', title: 'Implants', pageType: 'service' },
    ],
    ...overrides,
  }
}

describe('evidence graph', () => {
  it('parses focus strings and normalizes page identity', () => {
    expect(parseFocus('finding:F1')).toEqual({ kind: 'finding', key: 'F1' })
    expect(parseFocus('page:https://example.com/implants/#x')).toEqual({ kind: 'page', key: 'https://example.com/implants' })
    expect(parseFocus('nonsense')).toBeNull()
    expect(pageKey('https://example.com/a/#top')).toBe('https://example.com/a')
  })

  it('returns null for a focus that does not exist', () => {
    expect(buildEvidenceGraph(input(), 'finding:F99')).toBeNull()
    expect(buildEvidenceGraph(input(), 'bogus')).toBeNull()
  })

  it('centres on a finding with its evidence, pages, journey and visual at one step', () => {
    const graph = buildEvidenceGraph(input(), 'finding:F1', 1)!
    expect(graph.focus).toBe('finding:F1')
    const near = graph.nodes.filter((n) => n.distance === 1).map((n) => n.id)
    expect(near).toEqual(expect.arrayContaining(['evidence:EV-1', 'evidence:EV-2', 'journey:J1', 'page:https://example.com/implants', 'artifact:A1']))
    expect(graph.nodes.every((n) => n.distance <= 1)).toBe(true)
    expect(graph.edges.find((e) => e.from === 'finding:F1' && e.to === 'evidence:EV-1')?.kind).toBe('supported-by')
    expect(graph.expandable).toBe(true)
  })

  it('only contains stored relationships: every edge joins two included nodes', () => {
    const graph = buildEvidenceGraph(input(), 'finding:F1', 3)!
    const ids = new Set(graph.nodes.map((n) => n.id))
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
    // F3 is related only through the shared evidence item.
    expect(graph.nodes.find((n) => n.id === 'finding:F3')?.distance).toBe(2)
    expect(graph.depth).toBe(GRAPH_MAX_DEPTH)
    expect(graph.expandable).toBe(false)
  })

  it('does not walk through page and run hubs unless they are the focus', () => {
    const graph = buildEvidenceGraph(input(), 'finding:F2', 3)!
    // F2 → EV-3 → (lighthouse run, homepage). EV-4 is only reachable through those hubs.
    expect(graph.nodes.some((n) => n.id === 'tool:tr1')).toBe(true)
    expect(graph.nodes.some((n) => n.id === 'evidence:EV-4')).toBe(false)
    const page = buildEvidenceGraph(input(), 'page:https://example.com/', 1)!
    expect(page.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['evidence:EV-3', 'evidence:EV-4', 'finding:F2']))
  })

  it('stays bounded and says when it left items out', () => {
    const many = input({
      findings: [finding('F1', { evidenceRefs: Array.from({ length: 30 }, (_, i) => `EV-${i + 10}`), affectedUrls: [] })],
      evidence: Array.from({ length: 30 }, (_, i) => ({
        ref: `EV-${i + 10}`,
        type: 'metric' as const,
        title: `Metric ${i}`,
        url: null,
        source: 'baseline' as const,
        toolRunId: null,
        agentRunId: null,
      })),
      journeys: [],
      artifacts: [],
    })
    const graph = buildEvidenceGraph(many, 'finding:F1', 2, 12)!
    expect(graph.nodes).toHaveLength(12)
    expect(graph.truncated).toBe(true)
  })

  it('keeps www, apex and http pages apart in labels', () => {
    const graph = buildEvidenceGraph(
      input({
        findings: [finding('F1', { evidenceRefs: ['EV-1'], affectedUrls: ['https://www.example.com/', 'http://www.example.com/', 'https://example.com/'] })],
        artifacts: [],
        journeys: [],
      }),
      'finding:F1',
      1,
    )!
    const labels = graph.nodes.filter((n) => n.kind === 'page').map((n) => n.label).sort()
    expect(labels).toEqual(['example.com/', 'http://www.example.com/', 'www.example.com/'])
  })

  it('treats a visual that covers many findings as context, not a path to them', () => {
    const matrix = { ref: 'A2', title: 'Impact and effort', type: 'impact_effort', evidenceRefs: [], findingRefs: ['F1', 'F2', 'F3'] }
    const graph = buildEvidenceGraph(input({ artifacts: [matrix] }), 'finding:F2', 2)!
    expect(graph.nodes.some((n) => n.id === 'artifact:A2')).toBe(true)
    // F1 and F3 are linked to F2 only through the matrix, which is not walked through.
    expect(graph.nodes.some((n) => n.id === 'finding:F1')).toBe(false)
    const centred = buildEvidenceGraph(input({ artifacts: [matrix] }), 'artifact:A2', 1)!
    expect(centred.nodes.filter((n) => n.kind === 'finding')).toHaveLength(3)
  })

  it('labels runs by what produced the evidence', () => {
    const graph = buildEvidenceGraph(input(), 'evidence:EV-1', 1)!
    const run = graph.nodes.find((n) => n.kind === 'tool')!
    expect(run.label).toBe('AI auditor')
    expect(graph.edges.find((e) => e.to === run.id)?.kind).toBe('produced-by')
  })
})
