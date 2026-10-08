import {
  capabilityLabel,
  type AuditStep,
  type BaselineStats,
  type CapabilityId,
  type CoverageItem,
  type CoverageStatus,
  type EvidenceItem,
  type ToolRunItem,
} from '@audivra/contracts'
import { evidenceKind } from './catalog.ts'

export interface CoverageInput {
  targetUrl: string
  toolRuns: Pick<ToolRunItem, 'tool' | 'status' | 'error' | 'purpose'>[]
  steps: AuditStep[]
  baseline: BaselineStats | null
  evidence: EvidenceItem[]
}

type ToolState = 'completed' | 'failed' | 'skipped' | 'running' | 'absent'

function toolState(runs: CoverageInput['toolRuns'], tool: string): { state: ToolState; error: string | null; count: number } {
  const matching = runs.filter((r) => r.tool === tool)
  if (matching.length === 0) return { state: 'absent', error: null, count: 0 }
  const completed = matching.filter((r) => r.status === 'completed')
  if (completed.length) return { state: 'completed', error: null, count: completed.length }
  const running = matching.find((r) => r.status === 'running')
  if (running) return { state: 'running', error: null, count: 0 }
  const failed = matching.find((r) => r.status === 'failed')
  if (failed) return { state: 'failed', error: failed.error, count: 0 }
  return { state: 'skipped', error: matching[0]?.error ?? null, count: 0 }
}

function item(
  capability: CapabilityId,
  status: CoverageStatus,
  tools: string[],
  reason: string | null,
  detail: string | null = null,
): CoverageItem {
  return { capability, label: capabilityLabel(capability), status, tools, reason, detail }
}

function fromTool(
  capability: CapabilityId,
  run: ReturnType<typeof toolState>,
  tools: string[],
  detail: string | null,
  unavailableReason = 'Tool unavailable',
): CoverageItem {
  switch (run.state) {
    case 'completed':
      return item(capability, 'ran', tools, null, detail)
    case 'failed':
      return item(capability, 'failed', tools, run.error ?? 'Tool failed')
    case 'skipped':
      return item(capability, /unavailable|not installed|missing/i.test(run.error ?? '') ? 'unavailable' : 'skipped', tools, run.error ?? unavailableReason)
    case 'running':
      return item(capability, 'skipped', tools, 'Still running')
    default:
      return item(capability, 'skipped', tools, 'Not run in this audit')
  }
}

/** Reason of a capability whose stage is still running (not a coverage change). */
export const IN_PROGRESS = 'In progress'

function stepStatus(steps: AuditStep[], stage: AuditStep['stage']): AuditStep | undefined {
  return steps.find((s) => s.stage === stage)
}

function fromStep(capability: CapabilityId, step: AuditStep | undefined, tools: string[], detail: string | null): CoverageItem {
  if (!step) return item(capability, 'skipped', tools, 'Stage not part of this audit')
  switch (step.status) {
    case 'completed':
      return item(capability, 'ran', tools, null, detail ?? step.message)
    case 'failed':
      return item(capability, 'failed', tools, step.error?.message ?? step.message ?? 'Failed')
    case 'skipped':
      return item(capability, /disabled|unavailable/i.test(step.message ?? '') ? 'unavailable' : 'skipped', tools, step.message ?? 'Skipped')
    case 'running':
      return item(capability, 'partial', tools, IN_PROGRESS)
    default:
      return item(capability, 'skipped', tools, 'Not run yet')
  }
}

/** Derives the explicit coverage table for an audit. Every capability gets a status and a reason. */
export function computeCoverage(input: CoverageInput): CoverageItem[] {
  const runs = input.toolRuns
  const kinds = new Set(input.evidence.map(evidenceKind))
  const stats = input.baseline
  const https = input.targetUrl.startsWith('https:')

  const crawler = toolState(runs, 'crawler')
  const katana = toolState(runs, 'katana')
  const crawl = fromTool(
    'crawl',
    crawler,
    ['crawler', ...(katana.state === 'completed' ? ['katana'] : [])],
    stats ? `${stats.pagesCrawled} pages crawled · ${stats.pagesDiscovered} URLs discovered` : null,
  )
  if (crawl.status === 'ran' && katana.state !== 'completed' && katana.state !== 'absent') {
    crawl.detail = `${crawl.detail ?? ''}${crawl.detail ? ' · ' : ''}Katana ${katana.state === 'failed' ? 'failed' : 'unavailable'}`
  }

  const links = fromTool('links', toolState(runs, 'link-checker'), ['link-checker'], stats ? `${stats.brokenLinks} broken target(s)` : null)

  const lighthouse = toolState(runs, 'lighthouse')
  const performance = fromTool('performance', lighthouse, ['lighthouse'], lighthouse.count ? `${lighthouse.count} Lighthouse run(s)` : null)

  const seo = crawler.state === 'completed' ? item('seo', 'ran', ['crawler'], null, 'Titles, descriptions, headings, canonicals, robots, sitemap') : item('seo', 'failed', ['crawler'], 'Crawl did not complete')

  const browserRuns = toolState(runs, 'playwright')
  const browser = fromTool('browser', browserRuns, ['playwright'], browserRuns.count ? `${browserRuns.count} page(s) at desktop and mobile` : null, 'Chromium not installed')

  const pa11y = toolState(runs, 'pa11y')
  const axeRan = kinds.has('axe')
  const pa11yRan = pa11y.state === 'completed'
  const accessibility = axeRan || pa11yRan
    ? item(
        'accessibility',
        'ran',
        [...(axeRan ? ['axe-core'] : []), ...(pa11yRan ? ['pa11y'] : [])],
        null,
        [
          axeRan ? null : 'axe-core results missing',
          pa11y.state === 'failed' ? 'Pa11y failed' : pa11y.state === 'skipped' ? `Pa11y skipped (${pa11y.error ?? 'no reason'})` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      )
    : stats?.skippedCapabilities.some((s) => /axe/i.test(s.capability))
      ? item('accessibility', 'unavailable', ['axe-core'], 'axe-core unavailable')
      : item('accessibility', browser.status === 'ran' ? 'partial' : 'skipped', ['axe-core'], 'No automated accessibility results recorded')

  const mobile = kinds.has('screenshot') && input.evidence.some((e) => e.type === 'screenshot' && /mobile|390/i.test(`${e.title} ${String(e.metadata.viewport ?? '')}`))
    ? item('mobile', 'ran', ['playwright'], null, '390×844 viewport, overflow check')
    : item('mobile', browser.status === 'ran' ? 'partial' : 'skipped', ['playwright'], 'No mobile capture recorded')

  const tracking = kinds.has('tracking')
    ? item('tracking', 'ran', ['playwright'], null, stats?.trackingDetected.length ? `Detected: ${stats.trackingDetected.join(', ')}` : 'No tracking detected on load')
    : item('tracking', 'skipped', ['playwright'], 'Browser inspection did not run')

  const localization = kinds.has('localization')
    ? item('localization', 'ran', ['crawler', 'playwright'], null, stats?.languages.length ? `Languages: ${stats.languages.join(', ')}` : null)
    : item('localization', crawler.state === 'completed' ? 'partial' : 'skipped', ['crawler'], 'No localization facts recorded')

  const httpx = toolState(runs, 'httpx')
  const technology = kinds.has('technology') || httpx.state === 'completed'
    ? item('technology', 'ran', ['signatures', ...(httpx.state === 'completed' ? ['httpx'] : [])], null, httpx.state === 'failed' ? 'httpx failed; signature hints available' : null)
    : item('technology', browser.status === 'ran' ? 'ran' : 'skipped', ['signatures'], browser.status === 'ran' ? null : 'Browser inspection did not run', 'No technology signatures matched')

  const headers = fromTool('security-headers', toolState(runs, 'http'), ['http'], null)

  const tlsRun = toolState(runs, 'tls')
  const testssl = toolState(runs, 'testssl')
  let tls: CoverageItem
  if (!https) tls = item('tls', 'not-applicable', [], 'Target is served over plain HTTP')
  else if (tlsRun.state !== 'completed') tls = fromTool('tls', tlsRun, ['tls'], null)
  else if (testssl.state === 'completed') tls = item('tls', 'ran', ['tls', 'testssl'], null, 'Handshake, certificate, protocols and ciphers')
  else
    tls = item(
      'tls',
      'partial',
      ['tls'],
      testssl.state === 'absent' ? 'Deep TLS scan (testssl.sh) not run' : `testssl.sh ${testssl.state === 'failed' ? 'failed' : 'skipped'}: ${testssl.error ?? ''}`.trim(),
      'Certificate and protocol from a passive handshake',
    )

  const zap = toolState(runs, 'zap')
  const passive = zap.state === 'absent' ? item('passive-scan', 'skipped', ['zap'], 'Not run in this audit') : fromTool('passive-scan', zap, ['zap'], 'ZAP baseline (spider + passive rules)')

  const investigation = fromStep('ai-investigation', stepStatus(input.steps, 'investigation'), ['claude'], null)
  const reviewStep = stepStatus(input.steps, 'review')
  const revisionStep = stepStatus(input.steps, 'revision')
  const review = fromStep('ai-review', reviewStep, ['claude'], revisionStep?.status === 'completed' ? 'Reviewed, then one verification pass' : reviewStep?.status === 'completed' ? 'Reviewed; no verification pass needed' : null)
  const visuals = fromStep('visuals', stepStatus(input.steps, 'presenting'), ['claude'], null)

  return [crawl, links, performance, seo, accessibility, browser, mobile, tracking, localization, technology, headers, tls, passive, investigation, review, visuals]
}

export function coverageCounts(items: CoverageItem[]): Record<CoverageStatus, number> {
  const counts = { ran: 0, partial: 0, skipped: 0, failed: 0, unavailable: 0, 'not-applicable': 0 }
  for (const entry of items) counts[entry.status]++
  return counts
}
