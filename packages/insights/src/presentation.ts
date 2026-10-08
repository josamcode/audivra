import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { auditWorkspaceDir, resolveInside } from '@audivra/config'
import type { Artifact, ArtifactSpec } from '@audivra/contracts'
import { replaceArtifacts, type Db, type NewArtifact } from '@audivra/database'
import { buildComparison, buildSiteHistory, loadAuditData, type AuditData } from './audit-data.ts'
import { fallbackArtifactSpecs, resolveArtifactSpec, type LinkGraph, type ResolveContext } from './artifacts.ts'

export interface PresentationContext extends ResolveContext {
  data: AuditData
}

async function readLinkGraph(auditId: string): Promise<LinkGraph | null> {
  const root = auditWorkspaceDir(auditId)
  const file = resolveInside(root, 'baseline/link-graph.json')
  if (!file || !existsSync(file)) return null
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as LinkGraph
    return Array.isArray(parsed.pages) && Array.isArray(parsed.edges) ? parsed : null
  } catch {
    return null
  }
}

/** Everything the artifact resolver needs for one audit (history and comparison included). */
export async function presentationContext(db: Db, auditId: string): Promise<PresentationContext | undefined> {
  const data = await loadAuditData(db, auditId)
  if (!data) return undefined
  const root = auditWorkspaceDir(auditId)
  const sizes = new Map<string, { width: number; height: number } | null>()
  const [history, comparison, linkGraph] = await Promise.all([
    buildSiteHistory(db, data.row.siteKey, { benchmark: data.row.benchmark, includeAuditId: auditId }),
    buildComparison(db, auditId),
    readLinkGraph(auditId),
  ])
  return {
    data,
    evidence: data.evidence,
    findings: data.findings,
    catalog: data.catalog,
    summary: data.row.summary ?? null,
    history,
    comparison,
    linkGraph,
    journeys: data.journeys,
    imageSize: async (workspacePath) => {
      if (sizes.has(workspacePath)) return sizes.get(workspacePath)!
      const file = resolveInside(root, workspacePath)
      let size: { width: number; height: number } | null = null
      if (file && existsSync(file)) {
        try {
          const meta = await sharp(file).metadata()
          if (meta.width && meta.height) size = { width: meta.width, height: meta.height }
        } catch {
          size = null
        }
      }
      sizes.set(workspacePath, size)
      return size
    },
  }
}

export interface ResolvedSet {
  artifacts: NewArtifact[]
  issues: string[]
}

/** Resolves specs in order, dropping rejected ones and exact duplicates. */
export async function resolveSpecs(specs: ArtifactSpec[], ctx: ResolveContext): Promise<ResolvedSet> {
  const artifacts: NewArtifact[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    const { artifact, issues: specIssues } = await resolveArtifactSpec(spec, ctx)
    issues.push(...specIssues)
    if (!artifact) continue
    const signature = `${artifact.type}:${JSON.stringify(artifact.data)}`
    if (seen.has(signature)) {
      issues.push(`${spec.type} "${spec.title}": dropped as a duplicate of an earlier artifact`)
      continue
    }
    seen.add(signature)
    artifacts.push(artifact)
  }
  return { artifacts, issues }
}

/** Generates and stores the deterministic (no-AI) artifact set for an audit. */
export async function generateSystemArtifacts(db: Db, auditId: string): Promise<{ artifacts: Artifact[]; issues: string[] }> {
  const ctx = await presentationContext(db, auditId)
  if (!ctx) throw new Error(`Audit ${auditId} not found`)
  const { artifacts, issues } = await resolveSpecs(fallbackArtifactSpecs(ctx), ctx)
  const stored = await replaceArtifacts(
    db,
    auditId,
    artifacts.map((a) => ({ ...a, createdBy: 'system' as const })),
  )
  return { artifacts: stored, issues }
}
