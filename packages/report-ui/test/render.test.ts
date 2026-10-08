import { ARTIFACT_TYPES, type AuditComparison } from '@audivra/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArtifactView, SVG_EXPORTABLE_TYPES } from '../src/artifact-view.tsx'
import { LineChart } from '../src/charts/svg-charts.tsx'
import { ClientReportDocument } from '../src/report/document.tsx'
import { EXPORT_PALETTE } from '../src/theme.ts'
import { formatValue, thresholdTone } from '../src/format.ts'
import { renderArtifactHtml, renderArtifactSvg, renderClientReportHtml } from '../src/ssr.tsx'
import { ARTIFACT_FIXTURES, REPORT_FIXTURE } from './fixtures.ts'

const resolveAsset = (path: string, auditId?: string) => `asset://${auditId ?? 'current'}/${path}`
/** Document body only (embedded base64 fonts can contain any character sequence). */
const body = (html: string) => html.slice(html.indexOf('<body'))

describe('artifact renderers (SSR)', () => {
  it('has a fixture for every artifact type', () => {
    expect(new Set(ARTIFACT_FIXTURES.map((a) => a.type))).toEqual(new Set(ARTIFACT_TYPES))
  })

  for (const artifact of ARTIFACT_FIXTURES) {
    it(`renders ${artifact.type} without throwing and shows its content`, () => {
      const html = renderArtifactHtml(artifact, { resolveAsset })
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).toContain('id="artifact-root"')
      expect(body(html)).toContain(artifact.title)
      expect(body(html)).not.toContain('undefined')
      expect(body(html)).not.toContain('NaN')
      expect(html).not.toMatch(/<script/i)
    })
  }

  it('renders resolved numbers in their units', () => {
    const perf = ARTIFACT_FIXTURES.find((a) => a.type === 'page_performance')!
    const html = renderArtifactHtml(perf, { resolveAsset })
    expect(html).toContain('1.8 s')
    expect(html).toContain('3.0 s')
    expect(html).toContain('0.113')
    const tracking = renderArtifactHtml(ARTIFACT_FIXTURES.find((a) => a.type === 'tracking_coverage')!, { resolveAsset })
    expect(tracking).toContain('Conversion event')
    expect(tracking).toContain('page_view only')
  })

  it('positions annotation regions with fractional coordinates', () => {
    const html = renderArtifactHtml(ARTIFACT_FIXTURES.find((a) => a.type === 'annotated_screenshot')!, { resolveAsset })
    expect(html).toContain('left:5%')
    expect(html).toContain('top:32%')
    expect(html).toContain('asset://current/screenshots/home-mobile.png')
  })

  it('resolves before/after images in their own audits', () => {
    const html = renderArtifactHtml(ARTIFACT_FIXTURES.find((a) => a.type === 'before_after')!, { resolveAsset })
    expect(html).toContain('asset://prevaudit01/screenshots/en-mobile.png')
    expect(html).toContain('asset://fixture0001/screenshots/en-mobile.png')
  })

  it('exports SVG only for vector-friendly types', () => {
    for (const artifact of ARTIFACT_FIXTURES) {
      const svg = renderArtifactSvg(artifact)
      if (SVG_EXPORTABLE_TYPES.has(artifact.type)) {
        expect(svg, artifact.type).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
        expect(svg).not.toContain('var(--')
        expect(svg).not.toContain('NaN')
      } else {
        expect(svg, artifact.type).toBeNull()
      }
    }
  })
})

describe('client report (SSR)', () => {
  it('produces a complete self-contained document', () => {
    const html = renderClientReportHtml(REPORT_FIXTURE, { resolveAsset, mode: 'html' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('data:font/woff2;base64,')
    expect(html).toContain('Executive snapshot')
    expect(html).toContain('What matters most')
    expect(html).toContain('Recommended action plan')
    expect(html).toContain('Technical appendix')
    expect(html).toContain('<details')
    expect(html).not.toMatch(/<script/i)
    expect(body(html)).not.toMatch(/https?:\/\/(?!example\.com|www\.example\.com|josamcode\.com|www\.w3\.org)[a-z]/i)
    expect(html).toContain('dir="auto"')
    expect(html).toContain('موقع تجريبي')
  })

  it('expands disclosures and adds page rules in pdf mode', () => {
    const html = renderClientReportHtml(REPORT_FIXTURE, { resolveAsset, mode: 'pdf' })
    expect(html).not.toContain('<details')
    expect(html).toContain('@page')
    expect(html).toContain('Full analysis')
  })

  it('contains no internal run metadata', () => {
    const html = renderClientReportHtml(REPORT_FIXTURE, { resolveAsset, mode: 'html' })
    for (const forbidden of ['prompt', 'turns', 'agent_run', 'session', 'claude']) {
      expect(body(html).toLowerCase()).not.toContain(forbidden)
    }
  })

  it('shows the audit focus and the primary journey with judged dimensions only', () => {
    const html = body(renderClientReportHtml(REPORT_FIXTURE, { resolveAsset, mode: 'html' }))
    expect(html).toContain('Audit focus')
    expect(html).toContain('Portfolio / personal brand')
    expect(html).toContain('Primary journey')
    expect(html).toContain('Email enquiry from a project page')
    expect(html).toContain('No contact link at the end of the case study.')
    expect(html).toContain('av-step-friction')
    // Unverified steps read as such, never as working.
    expect(html).toContain('av-step-unknown')
    expect(html).toContain('rp-health-problem')
    expect(html).toContain('Not assessed in this audit: visibility, performance, accessibility, continuity.')
    // No overall journey score or conversion rate is invented.
    expect(html).not.toMatch(/journey score|conversion rate/i)
  })

  it('puts the change interpretation above the comparison and never calls "not found again" fixed', () => {
    const comparison: AuditComparison = {
      siteKey: 'example.com',
      current: { id: 'fixture0001', createdAt: '2026-10-07T10:00:00.000Z', finishedAt: '2026-10-07T10:20:00.000Z', status: 'completed', findingCount: 9 },
      previous: { id: 'prevaudit01', createdAt: '2026-09-01T10:00:00.000Z', finishedAt: '2026-09-01T10:20:00.000Z', status: 'completed', findingCount: 9 },
      summary: { new: 1, resolved: 1, improved: 0, regressed: 0, unchanged: 7 },
      findings: [
        {
          status: 'resolved',
          current: null,
          previous: { ref: 'F4', title: 'Contact form fields have no labels', severity: 'medium', category: 'Accessibility', issueKey: null, affectedUrls: [] },
          matchedBy: null,
          matchScore: null,
        },
      ],
      metrics: [],
      technologies: { added: [], removed: [], unchanged: ['Next.js'] },
      tracking: { added: ['Google Analytics 4'], removed: [], unchanged: [] },
      journeys: [
        {
          journeyKey: 'portfolio-email-enquiry',
          name: 'Email enquiry from a project page',
          type: 'portfolio-contact',
          status: 'changed',
          currentRef: 'J1',
          previousRef: 'J1',
          primaryBefore: true,
          primaryAfter: true,
          pathBefore: ['Homepage', 'Case study', 'Email link'],
          pathAfter: ['Homepage', 'Case study', 'Email link'],
          pathChanged: false,
          health: [{ dimension: 'tracking', before: 'healthy', after: 'problem' }],
          steps: [{ label: 'Case study', before: 'ok', after: 'friction' }],
        },
      ],
      coverage: [],
      screenshots: [],
    }
    const html = body(renderClientReportHtml({ ...REPORT_FIXTURE, comparison }, { resolveAsset, mode: 'html' }))
    expect(html).toContain('What changed since the previous audit')
    const headline = html.indexOf('The www certificate error is new')
    const counts = html.indexOf('rp-change-summary')
    expect(headline).toBeGreaterThan(-1)
    expect(counts).toBeGreaterThan(headline)
    expect(html).toContain('Not found again')
    expect(html).toContain('it is not proof that it was fixed')
    expect(html).not.toMatch(/usually because it was fixed/i)
    expect(html).toContain('Case study: ok → friction')
    expect(html).toContain('Tracking now detected: Google Analytics 4.')
    // The old trailing comparison section is gone: changes appear once, before opportunities.
    expect(html.indexOf('id="changes"')).toBeLessThan(html.indexOf('id="opportunities"'))
    expect(html).not.toContain('id="comparison"')
  })

  it('renders the wider screen variant from the same content', () => {
    const paper = renderToStaticMarkup(createElement(ClientReportDocument, { report: REPORT_FIXTURE, resolveAsset }))
    const screen = renderToStaticMarkup(createElement(ClientReportDocument, { report: REPORT_FIXTURE, resolveAsset, variant: 'screen' }))
    expect(screen).toContain('rp-document rp-screen')
    expect(screen.replace(' rp-screen', '')).toBe(paper)
  })
})

describe('formatting', () => {
  it('formats units deterministically', () => {
    expect(formatValue(1840, 'ms')).toBe('1.8 s')
    expect(formatValue(820, 'ms')).toBe('820 ms')
    expect(formatValue(0.97, 'score')).toBe('97')
    expect(formatValue(326, 'kb')).toBe('326 KB')
    expect(formatValue(2_500_000, 'bytes')).toBe('2.4 MB')
    expect(formatValue(1, 'days')).toBe('1 day')
    expect(formatValue(0.113, 'none')).toBe('0.113')
  })

  it('applies documented thresholds', () => {
    expect(thresholdTone('performance', 95)).toBe('good')
    expect(thresholdTone('performance', 60)).toBe('warning')
    expect(thresholdTone('lcp', 4200, 'ms')).toBe('bad')
    expect(thresholdTone('lcp', 2.1, 's')).toBe('good')
    expect(thresholdTone('cls', 0.18)).toBe('warning')
  })
})

describe('app integration', () => {
  it('renders host actions in app mode only', () => {
    const artifact = ARTIFACT_FIXTURES.find((a) => a.type === 'bar_chart')!
    const actions = createElement('button', { type: 'button' }, 'Export')
    const app = renderToStaticMarkup(createElement(ArtifactView, { artifact, resolveAsset, mode: 'app', actions }))
    expect(app).toContain('av-actions')
    expect(app).toContain('>Export</button>')
    const report = renderToStaticMarkup(createElement(ArtifactView, { artifact, resolveAsset, mode: 'report', actions }))
    expect(report).not.toContain('av-actions')
    expect(report).not.toContain('Export')
  })

  it('tells same-day audits apart on the time axis', () => {
    const points = [
      { x: '2026-10-07T02:38:00.000Z', value: 15, auditId: 'a' },
      { x: '2026-10-07T03:41:00.000Z', value: 17, auditId: 'b' },
    ]
    const svg = renderToStaticMarkup(
      createElement(LineChart, { series: [{ label: 'Findings', points }], unit: 'count', palette: EXPORT_PALETTE }),
    )
    expect(svg).toContain('7 Oct 02:38')
    expect(svg).toContain('7 Oct 03:41')
  })

  it('thins date labels on long histories but always labels the latest audit', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      x: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString(),
      value: 50 + i,
      auditId: `a${i}`,
    }))
    const svg = renderToStaticMarkup(
      createElement(LineChart, {
        series: [{ label: 'Performance', points }],
        unit: 'score',
        palette: EXPORT_PALETTE,
        width: 400,
      }),
    )
    const labels = svg.match(/<text[^>]*text-anchor="middle"[^>]*>\d{1,2} [A-Z][a-z]{2}<\/text>/g) ?? []
    expect(labels.length).toBeGreaterThan(1)
    expect(labels.length).toBeLessThan(30)
    expect(svg).toContain('>23 Jul<')
  })
})
