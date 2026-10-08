import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { auditWorkspaceDir } from '@audivra/config'
import { EXPORT_KINDS, type ExportItem, type ExportKind } from '@audivra/contracts'
import { getChangeReport, type Db } from '@audivra/database'
import { buildClientReport, buildComparison, loadAuditData, type AuditData } from '@audivra/insights'
import { brokenLinksCsv, findingsCsv, pagesCsv, performanceCsv } from './csv.ts'
import { buildAuditExport } from './data-export.ts'
import { EXPORT_META, exportFilename, siteSlug } from './names.ts'
import { renderArtifactPng, renderArtifactSvgString, renderReportHtml, renderReportPdf, workspaceFile } from './render.ts'

export interface GeneratedExport {
  kind: ExportKind
  filename: string
  contentType: string
  /** Absolute path of the generated file (inside the audit workspace under exports/). */
  file: string
}

const exportsDir = (auditId: string) => path.join(auditWorkspaceDir(auditId), 'exports')

/** Lists exports with availability; files are generated on demand from persisted data (no AI). */
export async function listExports(db: Db, auditId: string): Promise<ExportItem[] | null> {
  const data = await loadAuditData(db, auditId)
  if (!data) return null
  const finished = ['completed', 'partial'].includes(data.row.status)
  const reasons: Partial<Record<ExportKind, string | null>> = {
    'csv-findings': data.findings.length ? null : 'No findings in this audit',
    'csv-performance': performanceCsv(data) ? null : 'No performance measurements recorded',
    'csv-broken-links': brokenLinksCsv(data) ? null : 'No broken links were found',
  }
  return Promise.all(
    EXPORT_KINDS.map(async (kind) => {
      const filename = exportFilename(data.row.domain, kind)
      const cached = path.join(exportsDir(auditId), filename)
      const reason = !finished ? 'Available when the audit has finished' : (reasons[kind] ?? null)
      return {
        kind,
        label: EXPORT_META[kind].label,
        filename,
        url: `/api/audits/${auditId}/export/${kind}`,
        available: reason === null,
        reason,
        generatedAt: existsSync(cached) ? (await stat(cached)).mtime.toISOString() : null,
      }
    }),
  )
}

async function write(auditId: string, filename: string, content: string | Buffer): Promise<string> {
  const dir = exportsDir(auditId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, filename)
  await writeFile(file, content)
  return file
}

async function reportFor(db: Db, data: AuditData) {
  const comparison = await buildComparison(db, data.row.id)
  const changes = comparison ? await getChangeReport(db, data.row.id, comparison.previous.id) : null
  return { report: buildClientReport(data, { comparison, changes }), comparison }
}

/** Generates one export from persisted data. Never re-runs the audit. */
export async function generateExport(db: Db, auditId: string, kind: ExportKind): Promise<GeneratedExport | null> {
  const data = await loadAuditData(db, auditId)
  if (!data) return null
  const filename = exportFilename(data.row.domain, kind)
  const contentType = EXPORT_META[kind].contentType
  const done = (file: string): GeneratedExport => ({ kind, filename, contentType, file })

  switch (kind) {
    case 'json': {
      const comparison = await buildComparison(db, auditId)
      return done(await write(auditId, filename, JSON.stringify(await buildAuditExport(db, data, comparison), null, 2)))
    }
    case 'csv-findings':
      return done(await write(auditId, filename, findingsCsv(data)))
    case 'csv-pages':
      return done(await write(auditId, filename, pagesCsv(data)))
    case 'csv-performance': {
      const csv = performanceCsv(data)
      return csv ? done(await write(auditId, filename, csv)) : null
    }
    case 'csv-broken-links': {
      const csv = brokenLinksCsv(data)
      return csv ? done(await write(auditId, filename, csv)) : null
    }
    case 'html': {
      const { report } = await reportFor(db, data)
      return done(await write(auditId, filename, await renderReportHtml(report, auditId, 'html')))
    }
    case 'pdf': {
      const { report } = await reportFor(db, data)
      return done(await write(auditId, filename, await renderReportPdf(report, auditId)))
    }
    case 'bundle':
      return done(await buildBundle(db, data, filename))
  }
}

function listFiles(root: string, relative: string, filter: (file: string) => boolean = () => true): string[] {
  const dir = path.join(root, relative)
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const childRel = path.posix.join(rel.split(path.sep).join('/'), entry.name)
      if (entry.isDirectory()) walk(childRel)
      else if (filter(childRel) && statSync(path.join(root, childRel)).size < 50 * 1024 * 1024) out.push(childRel)
    }
  }
  walk(relative)
  return out
}

/** The complete audit bundle (ZIP): report PDF/HTML, JSON, CSVs, screenshots, artifact images, evidence, tool reports. */
async function buildBundle(db: Db, data: AuditData, filename: string): Promise<string> {
  const auditId = data.row.id
  const root = auditWorkspaceDir(auditId)
  const folder = `${siteSlug(data.row.domain)}-audivra-audit`
  const zip = new yazl.ZipFile()
  const manifest: string[] = []
  const add = (zipPath: string, content: Buffer | string) => {
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), `${folder}/${zipPath}`)
    manifest.push(zipPath)
  }
  const addFile = (zipPath: string, workspacePath: string) => {
    const file = workspaceFile(auditId, workspacePath)
    if (!file) return
    zip.addFile(file, `${folder}/${zipPath}`)
    manifest.push(zipPath)
  }

  const { report, comparison } = await reportFor(db, data)
  const warnings: string[] = []
  try {
    add('report.html', await renderReportHtml(report, auditId, 'html'))
    add('report.pdf', await renderReportPdf(report, auditId))
  } catch (error) {
    warnings.push(`Report rendering failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  add('audit.json', JSON.stringify(await buildAuditExport(db, data, comparison), null, 2))
  add('csv/findings.csv', findingsCsv(data))
  add('csv/pages.csv', pagesCsv(data))
  const perf = performanceCsv(data)
  if (perf) add('csv/performance.csv', perf)
  const broken = brokenLinksCsv(data)
  if (broken) add('csv/broken-links.csv', broken)

  for (const shot of listFiles(root, 'screenshots', (f) => /\.(png|jpe?g|webp)$/i.test(f))) addFile(shot, shot)

  for (const artifact of data.artifacts) {
    try {
      add(`artifacts/${artifact.ref}-${artifact.type}.png`, await renderArtifactPng(artifact, auditId))
      const svg = await renderArtifactSvgString(artifact)
      if (svg) add(`artifacts/${artifact.ref}-${artifact.type}.svg`, svg)
    } catch (error) {
      warnings.push(`Artifact ${artifact.ref} could not be rendered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  add(
    'evidence/evidence.json',
    JSON.stringify(
      data.evidence.map((e) => ({ ref: e.ref, type: e.type, source: e.source, title: e.title, summary: e.summary, url: e.url, file: e.artifactPath })),
      null,
      2,
    ),
  )
  const included = new Set(manifest)
  for (const e of data.evidence) {
    if (!e.artifactPath || /\.(png|jpe?g|webp)$/i.test(e.artifactPath) || included.has(`evidence/${e.artifactPath}`)) continue
    addFile(`evidence/${e.artifactPath}`, e.artifactPath)
  }
  for (const [from, to] of [
    ['tools/lighthouse', 'technical/lighthouse'],
    ['tools/zap', 'technical/zap'],
    ['tools/testssl', 'technical/tls'],
    ['tools/axe', 'technical/tool-reports/axe'],
    ['tools/pa11y', 'technical/tool-reports/pa11y'],
  ] as const) {
    // Container logs are execution noise, not reports.
    for (const file of listFiles(root, from, (f) => !/\.(stdout|stderr)\.log$/.test(f))) addFile(`${to}/${file.slice(from.length + 1)}`, file)
  }
  for (const [file, to] of [
    ['tools/httpx.json', 'technical/tool-reports/httpx.json'],
    ['tools/katana.jsonl', 'technical/tool-reports/katana.jsonl'],
    ['tools/registry.json', 'technical/tool-reports/tool-status.json'],
  ] as const) {
    if (existsSync(path.join(root, file))) addFile(to, file)
  }
  for (const file of listFiles(root, 'baseline', (f) => f.endsWith('.json') || f.endsWith('.md'))) {
    addFile(`technical/baseline/${file.slice('baseline/'.length)}`, file)
  }

  add(
    'README.md',
    [
      `# Audivra audit — ${data.row.domain}`,
      '',
      `Audited ${data.row.createdAt.toISOString().slice(0, 10)} · ${data.findings.length} findings · ${data.evidence.length} evidence items · ${data.artifacts.length} visual artifacts`,
      '',
      '| Path | Contents |',
      '| --- | --- |',
      '| report.pdf / report.html | Client report (open report.html in any browser; it is self-contained) |',
      '| audit.json | Complete structured audit data (schema audivra.audit.v1) |',
      '| csv/ | Findings, pages, performance and broken links as CSV |',
      '| screenshots/ | Desktop and mobile screenshots captured during the audit |',
      '| artifacts/ | Visual artifacts as PNG (and SVG where vector-friendly) |',
      '| evidence/ | Evidence index and supporting files (notes, script output, tool output) |',
      '| technical/ | Raw tool reports: Lighthouse, ZAP (passive), testssl.sh, axe, Pa11y, httpx, Katana and baseline data |',
      '',
      ...(warnings.length ? ['## Notes', '', ...warnings.map((w) => `- ${w}`), ''] : []),
      `Files: ${manifest.length}`,
    ].join('\n'),
  )

  const dir = exportsDir(auditId)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, filename)
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(target))
  return target
}

export async function artifactImage(db: Db, auditId: string, ref: string, format: 'png' | 'svg'): Promise<Buffer | string | null> {
  const data = await loadAuditData(db, auditId)
  const artifact = data?.artifacts.find((a) => a.ref === ref)
  if (!artifact) return null
  return format === 'png' ? renderArtifactPng(artifact, auditId) : renderArtifactSvgString(artifact)
}
