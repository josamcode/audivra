import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { browserEnv, chromiumExecutable, DOCKER_IMAGES, findBinary, packageDir, runProcess } from '@audivra/tool-runtime'
import type { Workspace } from '../workspace.ts'

/**
 * Optional external scanners used by the baseline. All are passive or read-only:
 *  - ZAP baseline: spider (forms never submitted) + passive rules only; no active scan.
 *  - testssl.sh: protocols, certificate and cipher preference only; no vulnerability probes.
 *  - httpx: one request with Wappalyzer fingerprints.
 *  - Katana: bounded, rate-limited discovery crawl (same host only).
 *  - Pa11y: HTML_CodeSniffer checks in a headless browser.
 * Every process is registered in the ownership registry (containers by exact name).
 */

interface ScanOptions {
  auditId: string
  signal?: AbortSignal
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Containers cannot reach the host's loopback; Docker Desktop exposes it as host.docker.internal. */
export function containerTarget(url: string): { target: string; restore: (u: string) => string } {
  const parsed = new URL(url)
  if (!LOCAL_HOSTS.has(parsed.hostname)) return { target: url, restore: (u) => u }
  const original = parsed.host
  parsed.hostname = 'host.docker.internal'
  const rewritten = parsed.host
  return { target: parsed.toString(), restore: (u) => u.split(rewritten).join(original) }
}

const containerName = (auditId: string, tool: string) => `audivra-${auditId}-${tool}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')

const stripHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// ─── ZAP baseline ────────────────────────────────────────────────────────────

export type ZapRisk = 'high' | 'medium' | 'low' | 'informational'

export interface ZapAlert {
  name: string
  risk: ZapRisk
  confidence: string
  count: number
  pluginId: string
  cweid: string | null
  solution: string
  urls: string[]
}

export interface ZapSummary {
  target: string
  riskCounts: Record<ZapRisk, number>
  alerts: ZapAlert[]
  reportJson: string
  reportHtml: string | null
}

const RISKS: ZapRisk[] = ['informational', 'low', 'medium', 'high']
const CONFIDENCE = ['false positive', 'low', 'medium', 'high', 'confirmed']

/** Summarizes ZAP's traditional JSON report (zap-baseline.py -J). Pure. */
export function summarizeZapReport(report: unknown, restore: (u: string) => string = (u) => u): Pick<ZapSummary, 'riskCounts' | 'alerts'> {
  const riskCounts: Record<ZapRisk, number> = { high: 0, medium: 0, low: 0, informational: 0 }
  const alerts: ZapAlert[] = []
  const sites = Array.isArray((report as { site?: unknown })?.site) ? ((report as { site: unknown[] }).site as Record<string, unknown>[]) : []
  for (const site of sites) {
    for (const raw of Array.isArray(site.alerts) ? (site.alerts as Record<string, unknown>[]) : []) {
      const risk = RISKS[Number(raw.riskcode)] ?? 'informational'
      // ZAP marks some passive hits as false positives (confidence 0); they are not reported.
      if (Number(raw.confidence) === 0) continue
      const instances = Array.isArray(raw.instances) ? (raw.instances as Record<string, unknown>[]) : []
      const count = Number(raw.count) || instances.length || 1
      riskCounts[risk] += 1
      alerts.push({
        name: String(raw.name ?? raw.alert ?? 'Unnamed alert'),
        risk,
        confidence: CONFIDENCE[Number(raw.confidence)] ?? 'unknown',
        count,
        pluginId: String(raw.pluginid ?? ''),
        cweid: raw.cweid && raw.cweid !== '-1' ? String(raw.cweid) : null,
        solution: stripHtml(raw.solution).slice(0, 400),
        urls: [...new Set(instances.map((i) => restore(String(i.uri ?? ''))).filter(Boolean))].slice(0, 5),
      })
    }
  }
  alerts.sort((a, b) => RISKS.indexOf(b.risk) - RISKS.indexOf(a.risk) || b.count - a.count)
  return { riskCounts, alerts }
}

export async function runZapBaseline(ws: Workspace, url: string, options: ScanOptions & { spiderMinutes?: number }): Promise<{ summary: ZapSummary; command: string }> {
  const dir = ws.abs('tools/zap')
  await mkdir(dir, { recursive: true })
  const { target, restore } = containerTarget(url)
  const name = containerName(options.auditId, 'zap')
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--mount',
    `type=bind,source=${dir},target=/zap/wrk`,
    DOCKER_IMAGES.zap,
    'zap-baseline.py',
    '-t',
    target,
    '-m',
    String(options.spiderMinutes ?? 1),
    '-T',
    '5',
    '-J',
    'zap.json',
    '-r',
    'zap.html',
    '-I',
    // Passive only: the spider never fills in or submits forms, and uses one thread to stay gentle.
    '-z',
    '-config spider.processform=false -config spider.postform=false -config spider.thread=1',
  ]
  const result = await runProcess({
    command: 'docker',
    args,
    timeoutMs: 9 * 60_000,
    signal: options.signal,
    owner: { tool: 'zap', auditId: options.auditId, containerName: name },
    stdoutFile: path.join(dir, 'zap.stdout.log'),
    stderrFile: path.join(dir, 'zap.stderr.log'),
  })
  const json = path.join(dir, 'zap.json')
  if (!existsSync(json)) {
    throw new Error(result.timedOut ? 'ZAP baseline timed out' : `ZAP produced no report: ${(result.stderr || result.errorMessage || '').slice(-300)}`)
  }
  const parsed = summarizeZapReport(JSON.parse(await readFile(json, 'utf8')), restore)
  return {
    summary: { target: url, ...parsed, reportJson: 'tools/zap/zap.json', reportHtml: existsSync(path.join(dir, 'zap.html')) ? 'tools/zap/zap.html' : null },
    command: `docker run ${DOCKER_IMAGES.zap} zap-baseline.py -t ${url} -m ${options.spiderMinutes ?? 1} (passive, forms not submitted)`,
  }
}

// ─── testssl.sh ──────────────────────────────────────────────────────────────

export interface TestsslFinding {
  id: string
  severity: string
  finding: string
}

export interface TestsslSummary {
  host: string
  protocols: { name: string; offered: boolean | null; finding: string }[]
  certificate: { notAfter: string | null; expirationStatus: string | null; chainOfTrust: string | null; commonName: string | null; keySize: string | null; signatureAlgorithm: string | null }
  negotiated: { protocol: string | null; cipher: string | null; cipherOrder: string | null }
  issues: TestsslFinding[]
  severityCounts: Record<string, number>
  reportJson: string
}

const PROTOCOL_IDS: [string, string][] = [
  ['SSLv2', 'SSLv2'],
  ['SSLv3', 'SSLv3'],
  ['TLS1', 'TLS 1.0'],
  ['TLS1_1', 'TLS 1.1'],
  ['TLS1_2', 'TLS 1.2'],
  ['TLS1_3', 'TLS 1.3'],
]
const ISSUE_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

/**
 * Summarizes testssl.sh JSON output (flat array of {id, severity, finding}). Certificate ids carry a
 * " <hostCert#N>" suffix (the first certificate is used); per-cipher lines are grouped into one item
 * so the report is not flooded with every TLS detail. Pure.
 */
export function summarizeTestssl(findings: unknown, host: string): Omit<TestsslSummary, 'reportJson'> {
  const list = (Array.isArray(findings) ? findings : (findings as { scanResult?: unknown[] })?.scanResult ?? []) as Record<string, unknown>[]
  const seen = new Set<string>()
  const items: TestsslFinding[] = []
  for (const f of list) {
    if (typeof f.id !== 'string') continue
    const id = f.id.replace(/\s*<hostCert#\d+>\s*$/, '')
    const finding = String(f.finding ?? '').replace(/\s+/g, ' ').trim()
    const key = `${id}|${finding}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ id, severity: String(f.severity ?? 'INFO').toUpperCase(), finding })
  }
  const byId = new Map<string, TestsslFinding>()
  for (const f of items) if (!byId.has(f.id)) byId.set(f.id, f)
  const value = (id: string) => byId.get(id)?.finding ?? null
  const protocols = PROTOCOL_IDS.filter(([id]) => byId.has(id)).map(([id, name]) => {
    const finding = byId.get(id)!.finding
    const offered = /not offered/i.test(finding) ? false : /offered/i.test(finding) ? true : null
    return { name, offered, finding }
  })
  const severityCounts: Record<string, number> = {}
  for (const f of items) severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1
  return {
    host,
    protocols,
    certificate: {
      notAfter: value('cert_notAfter'),
      expirationStatus: value('cert_expirationStatus'),
      chainOfTrust: value('cert_chain_of_trust'),
      commonName: value('cert_commonName'),
      keySize: value('cert_keySize'),
      signatureAlgorithm: value('cert_signatureAlgorithm'),
    },
    negotiated: { protocol: value('protocol_negotiated'), cipher: value('cipher_negotiated'), cipherOrder: value('cipher_order') },
    issues: groupedIssues(items),
    severityCounts,
  }
}

function groupedIssues(items: TestsslFinding[]): TestsslFinding[] {
  const flagged = items.filter((f) => ISSUE_SEVERITIES.has(f.severity))
  const ciphers = flagged.filter((f) => /^cipher-/.test(f.id))
  const issues = flagged.filter((f) => !/^cipher-/.test(f.id))
  if (ciphers.length) {
    const worst = SEVERITY_ORDER.find((s) => ciphers.some((c) => c.severity === s)) ?? 'LOW'
    const names = [...new Set(ciphers.map((c) => c.finding.split(' ')[2]).filter(Boolean))]
    issues.push({
      id: 'weak_ciphers',
      severity: worst,
      finding: `${names.length} legacy/weak cipher suite${names.length === 1 ? '' : 's'} offered (e.g. ${names.slice(0, 4).join(', ')})`,
    })
  }
  return issues.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)).slice(0, 25)
}

export async function runTestssl(ws: Workspace, host: string, options: ScanOptions & { port?: number }): Promise<{ summary: TestsslSummary; command: string }> {
  const dir = ws.abs('tools/testssl')
  await mkdir(dir, { recursive: true })
  const name = containerName(options.auditId, 'testssl')
  const target = `${host}:${options.port ?? 443}`
  const result = await runProcess({
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--name',
      name,
      '--mount',
      `type=bind,source=${dir},target=/data`,
      DOCKER_IMAGES.testssl,
      '--quiet',
      '--color',
      '0',
      '--warnings',
      'off',
      '--connect-timeout',
      '10',
      '--openssl-timeout',
      '10',
      // First DNS address only: one host, one result set.
      '--ip',
      'one',
      '--jsonfile',
      '/data/testssl.json',
      // Protocols, server defaults (certificate) and server preferences only — no vulnerability probes.
      '-p',
      '-S',
      '-P',
      target,
    ],
    timeoutMs: 6 * 60_000,
    signal: options.signal,
    owner: { tool: 'testssl', auditId: options.auditId, containerName: name },
    stdoutFile: path.join(dir, 'testssl.stdout.log'),
    stderrFile: path.join(dir, 'testssl.stderr.log'),
  })
  const json = path.join(dir, 'testssl.json')
  if (!existsSync(json)) {
    throw new Error(result.timedOut ? 'testssl.sh timed out' : `testssl.sh produced no report: ${(result.stderr || result.errorMessage || '').slice(-300)}`)
  }
  return {
    summary: { ...summarizeTestssl(JSON.parse(await readFile(json, 'utf8')), host), reportJson: 'tools/testssl/testssl.json' },
    command: `docker run ${DOCKER_IMAGES.testssl} -p -S -P ${target}`,
  }
}

// ─── httpx ───────────────────────────────────────────────────────────────────

export interface HttpxSummary {
  url: string
  statusCode: number | null
  title: string | null
  webserver: string | null
  cdn: string | null
  technologies: string[]
}

/** Parses httpx -j output (first JSON line). Pure. */
export function parseHttpxOutput(stdout: string): HttpxSummary | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const r = JSON.parse(line) as Record<string, unknown>
      return {
        url: String(r.url ?? r.input ?? ''),
        statusCode: typeof r.status_code === 'number' ? r.status_code : null,
        title: typeof r.title === 'string' ? r.title : null,
        webserver: typeof r.webserver === 'string' ? r.webserver : null,
        cdn: typeof r.cdn_name === 'string' ? r.cdn_name : null,
        technologies: Array.isArray(r.tech) ? [...new Set((r.tech as unknown[]).map(String))] : [],
      }
    } catch {
      continue
    }
  }
  return null
}

export async function runHttpx(url: string, options: ScanOptions): Promise<{ summary: HttpxSummary; command: string }> {
  const binary = findBinary('httpx')
  if (!binary) throw new Error('httpx is not installed')
  const args = ['-u', url, '-td', '-title', '-sc', '-server', '-cdn', '-fr', '-j', '-silent', '-nc', '-timeout', '15', '-retries', '1']
  const result = await runProcess({ command: binary, args, timeoutMs: 60_000, signal: options.signal, owner: { tool: 'httpx', auditId: options.auditId } })
  const summary = parseHttpxOutput(result.stdout)
  if (!summary) throw new Error(`httpx returned no result: ${(result.stderr || result.errorMessage || 'no output').slice(-300)}`)
  return { summary, command: `httpx -u ${url} -td -title -sc -server -fr -j` }
}

// ─── Katana ──────────────────────────────────────────────────────────────────

export interface KatanaSummary {
  endpoints: number
  pageUrls: string[]
  /** Requests refused with 403/429/503 (bot protection or rate limiting): discovery is incomplete. */
  blocked: number
  outputFile: string
}

const NON_PAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf|zip|map|webmanifest)(\?|$)/i
/** Framework internals and API routes that are never user-facing pages. */
const INTERNAL_PATH = /^\/(_next|__nextjs|_nuxt|_astro|_app|cdn-cgi|wp-json|wp-admin|api)(\/|$)/i

type KatanaLine = {
  request?: { endpoint?: string }
  endpoint?: string
  response?: { status_code?: number; headers?: Record<string, string> }
}

/**
 * Same-host page URLs from Katana JSONL output. JavaScript parsing yields many non-pages (escaped
 * strings such as "/ar%5C", framework chunks, API routes, RSC prefetch variants), so a URL only counts
 * as a page when Katana fetched it and received a 2xx HTML response. Pure.
 */
export function parseKatanaOutput(jsonl: string, startUrl: string, limit = 150): { endpoints: number; pageUrls: string[]; blocked: number } {
  const host = new URL(startUrl).host
  const pages = new Set<string>()
  let endpoints = 0
  let blocked = 0
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: KatanaLine
    try {
      record = JSON.parse(line) as KatanaLine
    } catch {
      continue
    }
    const endpoint = record.request?.endpoint ?? record.endpoint
    if (!endpoint) continue
    endpoints++
    const status = record.response?.status_code
    if (status === 403 || status === 429 || status === 503) blocked++
    const headers = record.response?.headers ?? {}
    const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
    if (!status || status < 200 || status >= 300 || !/text\/html/i.test(contentType)) continue
    if (/%5c|\\/i.test(endpoint)) continue
    try {
      const u = new URL(endpoint)
      if (u.host !== host || NON_PAGE.test(u.pathname) || INTERNAL_PATH.test(u.pathname) || u.searchParams.has('_rsc')) continue
      u.hash = ''
      pages.add(u.toString())
    } catch {
      continue
    }
  }
  return { endpoints, pageUrls: [...pages].slice(0, limit), blocked }
}

export async function runKatana(ws: Workspace, url: string, options: ScanOptions & { depth?: number; seconds?: number }): Promise<{ summary: KatanaSummary; command: string }> {
  const binary = findBinary('katana')
  if (!binary) throw new Error('Katana is not installed')
  const outputFile = 'tools/katana.jsonl'
  await mkdir(ws.abs('tools'), { recursive: true })
  const args = [
    '-u',
    url,
    '-d',
    String(options.depth ?? 2),
    '-jc',
    '-fs',
    'fqdn',
    '-rl',
    '2',
    '-c',
    '2',
    '-ct',
    `${options.seconds ?? 45}s`,
    '-timeout',
    '10',
    '-ef',
    'png,jpg,jpeg,gif,svg,webp,avif,ico,css,woff,woff2,ttf,eot,mp4,webm,mp3,pdf,zip',
    // Keep the output small: no raw requests/responses or bodies (headers and status stay).
    '-or',
    '-ob',
    '-j',
    '-silent',
    '-nc',
    '-o',
    ws.abs(outputFile),
  ]
  const result = await runProcess({
    command: binary,
    args,
    timeoutMs: ((options.seconds ?? 45) + 60) * 1000,
    signal: options.signal,
    owner: { tool: 'katana', auditId: options.auditId },
  })
  if (!existsSync(ws.abs(outputFile))) throw new Error(`Katana produced no output: ${(result.stderr || result.errorMessage || '').slice(-300)}`)
  const parsed = parseKatanaOutput(await readFile(ws.abs(outputFile), 'utf8'), url)
  return { summary: { ...parsed, outputFile }, command: `katana -u ${url} -d ${options.depth ?? 2} -jc -fs fqdn -rl 2 -ct ${options.seconds ?? 45}s` }
}

// ─── Pa11y ───────────────────────────────────────────────────────────────────

export interface Pa11yIssue {
  code: string
  type: string
  message: string
  selector: string
  context: string
}

export interface Pa11ySummary {
  url: string
  errors: number
  warnings: number
  notices: number
  byCode: { code: string; count: number; message: string }[]
  issues: Pa11yIssue[]
  reportJson: string
}

/** Parses `pa11y --reporter json` output (an array of issues). Pure. */
export function summarizePa11y(issues: unknown, url: string): Omit<Pa11ySummary, 'reportJson'> {
  const list = (Array.isArray(issues) ? issues : []) as Record<string, unknown>[]
  const parsed: Pa11yIssue[] = list.map((i) => ({
    code: String(i.code ?? ''),
    type: String(i.type ?? 'error'),
    message: String(i.message ?? '').slice(0, 300),
    selector: String(i.selector ?? '').slice(0, 200),
    context: String(i.context ?? '').slice(0, 200),
  }))
  const counts = new Map<string, { code: string; count: number; message: string }>()
  for (const issue of parsed) {
    const entry = counts.get(issue.code) ?? { code: issue.code, count: 0, message: issue.message }
    entry.count++
    counts.set(issue.code, entry)
  }
  return {
    url,
    errors: parsed.filter((i) => i.type === 'error').length,
    warnings: parsed.filter((i) => i.type === 'warning').length,
    notices: parsed.filter((i) => i.type === 'notice').length,
    byCode: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    issues: parsed.slice(0, 60),
  }
}

export async function runPa11y(ws: Workspace, url: string, options: ScanOptions & { name: string }): Promise<{ summary: Pa11ySummary; command: string }> {
  const dir = packageDir('pa11y')
  const cli = dir ? path.join(dir, 'bin', 'pa11y.js') : null
  if (!cli || !existsSync(cli)) throw new Error('Pa11y is not installed')
  const chrome = chromiumExecutable()
  if (!chrome) throw new Error('Chromium is not installed')
  await mkdir(ws.abs('tools/pa11y'), { recursive: true })
  const configFile = ws.abs('tools/pa11y/config.json')
  await writeFile(
    configFile,
    JSON.stringify({ standard: 'WCAG2AA', timeout: 60_000, chromeLaunchConfig: { executablePath: chrome, args: ['--no-sandbox', '--disable-gpu'] } }, null, 2),
  )
  const reportJson = `tools/pa11y/${options.name}.json`
  const result = await runProcess({
    command: process.execPath,
    args: [cli, url, '--runner', 'htmlcs', '--reporter', 'json', '--config', configFile],
    env: browserEnv(),
    timeoutMs: 120_000,
    signal: options.signal,
    owner: { tool: 'pa11y', auditId: options.auditId },
  })
  // Exit code 2 means "issues found"; anything without parseable JSON is a failure.
  const start = result.stdout.indexOf('[')
  if (start < 0) throw new Error(`Pa11y produced no report: ${(result.stderr || result.errorMessage || '').slice(-300)}`)
  const issues = JSON.parse(result.stdout.slice(start)) as unknown
  await writeFile(ws.abs(reportJson), JSON.stringify(issues, null, 2))
  return { summary: { ...summarizePa11y(issues, url), reportJson }, command: `pa11y ${url} --runner htmlcs --reporter json` }
}
