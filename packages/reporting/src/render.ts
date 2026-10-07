import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import sharp from 'sharp'
import { auditWorkspaceDir, resolveInside } from '@audivra/config'
import type { Artifact, ClientReport } from '@audivra/contracts'
import { chromiumExecutable } from '@audivra/tool-runtime'

type AssetResolver = (workspacePath: string, auditId?: string) => string

interface SsrModule {
  renderClientReportHtml(report: ClientReport, options: { resolveAsset: AssetResolver; mode: 'html' | 'pdf' }): string
  renderArtifactHtml(artifact: Artifact, options: { resolveAsset: AssetResolver; width?: number }): string
  renderArtifactSvg(artifact: Artifact): string | null
}

let ssrModule: Promise<SsrModule> | null = null
/** Loads the shared renderer lazily (it pulls in React + fonts). */
export async function ssr(): Promise<SsrModule> {
  ssrModule ??= import('@audivra/report-ui/ssr').then((m) => {
    const mod = m as unknown as Partial<SsrModule>
    if (typeof mod.renderClientReportHtml !== 'function' || typeof mod.renderArtifactHtml !== 'function') {
      ssrModule = null
      throw new Error('The report renderer (@audivra/report-ui/ssr) is not available')
    }
    return mod as SsrModule
  })
  return ssrModule
}

let browser: Promise<Browser> | null = null
/** One shared headless Chromium for PDF/PNG rendering, launched on first use. */
async function renderBrowser(): Promise<Browser> {
  browser ??= chromium.launch({ headless: true, executablePath: chromiumExecutable() ?? undefined }).catch((error: unknown) => {
    browser = null
    throw error
  })
  return browser
}

export async function closeRenderer(): Promise<void> {
  const current = browser
  browser = null
  if (current) await (await current).close().catch(() => undefined)
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i

/** Reads a workspace image and returns a compressed data: URI (screenshots → JPEG, max 1600 px wide). */
export async function embedImage(auditId: string, workspacePath: string): Promise<string | null> {
  if (!IMAGE_RE.test(workspacePath)) return null
  const file = resolveInside(auditWorkspaceDir(auditId), workspacePath)
  if (!file || !existsSync(file)) return null
  try {
    const image = sharp(file)
    const meta = await image.metadata()
    const resized = meta.width && meta.width > 1600 ? image.resize({ width: 1600 }) : image
    const buffer = await resized.jpeg({ quality: 82, mozjpeg: true }).toBuffer()
    return `data:image/jpeg;base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

function collectArtifactImages(artifact: Artifact, currentAuditId: string, out: Set<string>): void {
  if (artifact.type === 'annotated_screenshot' && artifact.data.imagePath) out.add(`${currentAuditId}|${artifact.data.imagePath}`)
  if (artifact.type === 'evidence_gallery') for (const i of artifact.data.items) if (i.imagePath) out.add(`${currentAuditId}|${i.imagePath}`)
  if (artifact.type === 'before_after') {
    out.add(`${artifact.data.before.auditId}|${artifact.data.before.imagePath}`)
    out.add(`${artifact.data.after.auditId}|${artifact.data.after.imagePath}`)
  }
}

/** Builds an embedded-asset resolver for a report (all images inlined as data: URIs). */
export async function embeddedResolver(report: ClientReport, currentAuditId: string): Promise<AssetResolver> {
  const wanted = new Set<string>()
  for (const [key, file] of Object.entries(report.images)) {
    const auditId = key.includes(':') && !key.startsWith('EV-') ? key.split(':')[0]! : currentAuditId
    wanted.add(`${auditId}|${file}`)
  }
  const artifacts = [
    ...report.featuredArtifacts,
    ...report.visuals,
    ...report.appendix.artifacts,
    ...report.categoryHighlights.flatMap((h) => h.artifacts),
    ...[...report.topRisks, ...report.majorFindings, ...report.appendix.otherFindings].flatMap((f) => (f.proof.artifact ? [f.proof.artifact] : [])),
  ]
  for (const artifact of artifacts) collectArtifactImages(artifact, currentAuditId, wanted)
  for (const finding of [...report.topRisks, ...report.majorFindings, ...report.appendix.otherFindings]) {
    if (finding.proof.image) wanted.add(`${currentAuditId}|${finding.proof.image.path}`)
  }
  const embedded = new Map<string, string>()
  for (const key of wanted) {
    const [auditId, file] = key.split('|') as [string, string]
    const uri = await embedImage(auditId, file)
    if (uri) embedded.set(key, uri)
  }
  return (workspacePath, auditId) => embedded.get(`${auditId ?? currentAuditId}|${workspacePath}`) ?? ''
}

export async function renderReportHtml(report: ClientReport, auditId: string, mode: 'html' | 'pdf'): Promise<string> {
  const { renderClientReportHtml } = await ssr()
  return renderClientReportHtml(report, { resolveAsset: await embeddedResolver(report, auditId), mode })
}

export async function renderReportPdf(report: ClientReport, auditId: string): Promise<Buffer> {
  const html = await renderReportHtml(report, auditId, 'pdf')
  const page = await (await renderBrowser()).newPage()
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 })
    await page.emulateMedia({ media: 'print' })
    // The report stylesheet defines A4 page size, margins and the page-number footer (@page rules).
    return await page.pdf({ printBackground: true, preferCSSPageSize: true })
  } finally {
    await page.close().catch(() => undefined)
  }
}

export async function renderArtifactPng(artifact: Artifact, auditId: string): Promise<Buffer> {
  const { renderArtifactHtml } = await ssr()
  const wanted = new Set<string>()
  collectArtifactImages(artifact, auditId, wanted)
  const embedded = new Map<string, string>()
  for (const key of wanted) {
    const [owner, file] = key.split('|') as [string, string]
    const uri = await embedImage(owner, file)
    if (uri) embedded.set(key, uri)
  }
  const html = renderArtifactHtml(artifact, {
    resolveAsset: (workspacePath, owner) => embedded.get(`${owner ?? auditId}|${workspacePath}`) ?? '',
    width: 960,
  })
  const page = await (await renderBrowser()).newPage({ deviceScaleFactor: 2, viewport: { width: 1040, height: 800 } })
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 })
    return await page.locator('#artifact-root').screenshot({ type: 'png' })
  } finally {
    await page.close().catch(() => undefined)
  }
}

export async function renderArtifactSvgString(artifact: Artifact): Promise<string | null> {
  const { renderArtifactSvg } = await ssr()
  return renderArtifactSvg(artifact)
}

export async function readWorkspaceFile(auditId: string, workspacePath: string): Promise<Buffer | null> {
  const file = resolveInside(auditWorkspaceDir(auditId), workspacePath)
  if (!file || !existsSync(file)) return null
  return readFile(file)
}

export function workspaceFile(auditId: string, workspacePath: string): string | null {
  const file = resolveInside(auditWorkspaceDir(auditId), workspacePath)
  return file && existsSync(file) ? file : null
}

export const basename = (p: string) => path.posix.basename(p.replace(/\\/g, '/'))
