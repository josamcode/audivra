import { ARTIFACT_TYPES } from '@audivra/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArtifactView, SVG_EXPORTABLE_TYPES } from '../src/artifact-view.tsx'
import { LineChart } from '../src/charts/svg-charts.tsx'
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
