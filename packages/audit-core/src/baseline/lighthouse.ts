import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromiumExecutable, packageDir, runProcess } from '@audivra/tool-runtime'
import type { Workspace } from '../workspace.ts'

export interface LighthouseSummary {
  url: string
  formFactor: 'mobile' | 'desktop'
  scores: {
    performance: number | null
    accessibility: number | null
    bestPractices: number | null
    seo: number | null
  }
  metrics: {
    fcpMs: number | null
    lcpMs: number | null
    tbtMs: number | null
    cls: number | null
    speedIndexMs: number | null
    ttiMs: number | null
    serverResponseMs: number | null
  }
  totalBytes: number | null
  /** Top failing audits with estimated savings — leads, not conclusions. */
  opportunities: {
    id: string
    title: string
    savingsMs: number | null
    savingsBytes: number | null
    displayValue: string | null
  }[]
  diagnostics: { id: string; title: string; displayValue: string | null; score: number | null }[]
  runWarnings: string[]
  jsonPath: string
  htmlPath: string | null
}

type LhAudit = {
  id: string
  title: string
  score: number | null
  scoreDisplayMode: string
  displayValue?: string
  numericValue?: number
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number }
  metricSavings?: { LCP?: number; FCP?: number; TBT?: number }
}

type LhReport = {
  finalDisplayedUrl?: string
  categories: Record<string, { score: number | null; auditRefs: { id: string; group?: string }[] }>
  audits: Record<string, LhAudit>
  runWarnings?: string[]
  runtimeError?: { message?: string }
}

const score = (value: number | null | undefined) => (value == null ? null : Math.round(value * 100))
const num = (audit: LhAudit | undefined) =>
  audit?.numericValue == null ? null : Math.round(audit.numericValue)

/** Extracts the facts we surface from a Lighthouse JSON report (pure; unit-tested). */
export function summarizeLighthouse(
  report: LhReport,
  formFactor: 'mobile' | 'desktop',
  jsonPath: string,
  htmlPath: string | null,
): LighthouseSummary {
  const a = report.audits
  const perfRefs = new Set(report.categories.performance?.auditRefs.map((r) => r.id) ?? [])
  const opportunities = Object.values(a)
    .filter((x) => perfRefs.has(x.id) && x.details?.type === 'opportunity' && (x.score ?? 1) < 0.9)
    .map((x) => ({
      id: x.id,
      title: x.title,
      savingsMs: x.details?.overallSavingsMs != null ? Math.round(x.details.overallSavingsMs) : null,
      savingsBytes: x.details?.overallSavingsBytes != null ? Math.round(x.details.overallSavingsBytes) : null,
      displayValue: x.displayValue ?? null,
    }))
    .sort((x, y) => (y.savingsMs ?? 0) - (x.savingsMs ?? 0))
    .slice(0, 8)
  const diagnostics = Object.values(a)
    .filter(
      (x) =>
        perfRefs.has(x.id) &&
        x.scoreDisplayMode !== 'informative' &&
        x.scoreDisplayMode !== 'notApplicable' &&
        x.details?.type !== 'opportunity' &&
        x.score !== null &&
        x.score < 0.9 &&
        ![
          'first-contentful-paint',
          'largest-contentful-paint',
          'total-blocking-time',
          'cumulative-layout-shift',
          'speed-index',
          'interactive',
        ].includes(x.id),
    )
    .map((x) => ({ id: x.id, title: x.title, displayValue: x.displayValue ?? null, score: x.score }))
    .slice(0, 10)
  const cls = a['cumulative-layout-shift']?.numericValue
  return {
    url: report.finalDisplayedUrl ?? '',
    formFactor,
    scores: {
      performance: score(report.categories.performance?.score),
      accessibility: score(report.categories.accessibility?.score),
      bestPractices: score(report.categories['best-practices']?.score),
      seo: score(report.categories.seo?.score),
    },
    metrics: {
      fcpMs: num(a['first-contentful-paint']),
      lcpMs: num(a['largest-contentful-paint']),
      tbtMs: num(a['total-blocking-time']),
      cls: cls == null ? null : Math.round(cls * 1000) / 1000,
      speedIndexMs: num(a['speed-index']),
      ttiMs: num(a['interactive']),
      serverResponseMs: num(a['server-response-time']),
    },
    totalBytes: num(a['total-byte-weight']),
    opportunities,
    diagnostics,
    runWarnings: report.runWarnings ?? [],
    jsonPath,
    htmlPath,
  }
}

export function lighthouseCliPath(): string | null {
  const dir = packageDir('lighthouse')
  if (!dir) return null
  const cli = path.join(dir, 'cli', 'index.js')
  return existsSync(cli) ? cli : null
}

/** Runs Lighthouse in a child process against the project's Chromium build. */
export async function runLighthouse(
  url: string,
  ws: Workspace,
  options: { name: string; formFactor: 'mobile' | 'desktop'; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ summary: LighthouseSummary; command: string }> {
  const cli = lighthouseCliPath()
  if (!cli) throw new Error('Lighthouse is not installed')
  const chrome = chromiumExecutable()
  const base = `tools/lighthouse/${options.name}`
  const outBase = ws.abs(base)
  const args = [
    cli,
    url,
    '--output=json',
    '--output=html',
    `--output-path=${outBase}`,
    '--quiet',
    '--max-wait-for-load=45000',
    '--only-categories=performance,accessibility,best-practices,seo',
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu',
    ...(options.formFactor === 'desktop' ? ['--preset=desktop'] : []),
  ]
  const result = await runProcess({
    command: process.execPath,
    args,
    cwd: ws.root,
    env: chrome ? { CHROME_PATH: chrome } : {},
    timeoutMs: options.timeoutMs ?? 180_000,
    signal: options.signal,
    stdoutFile: ws.abs(`${base}.stdout.log`),
    stderrFile: ws.abs(`${base}.stderr.log`),
  })
  const jsonPath = `${base}.report.json`
  const htmlPath = `${base}.report.html`
  // On Windows Lighthouse can exit non-zero while cleaning up Chrome's temp dir after a successful run,
  // so success is judged by the report itself.
  if (!existsSync(ws.abs(jsonPath))) {
    throw new Error(
      result.timedOut
        ? 'Lighthouse timed out'
        : `Lighthouse produced no report: ${(result.stderr || result.errorMessage || '').slice(-400)}`,
    )
  }
  const report = JSON.parse(await readFile(ws.abs(jsonPath), 'utf8')) as LhReport
  if (report.runtimeError?.message)
    throw new Error(`Lighthouse runtime error: ${report.runtimeError.message}`)
  return {
    summary: summarizeLighthouse(
      report,
      options.formFactor,
      jsonPath,
      existsSync(ws.abs(htmlPath)) ? htmlPath : null,
    ),
    command: `lighthouse ${url} ${options.formFactor === 'desktop' ? '--preset=desktop ' : ''}--output=json --output=html`,
  }
}
