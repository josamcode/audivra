import type { AttackPathCoverage, AttackPathDetail, AttackPathReport, PathState, SecurityAttackPath } from '@audivra/contracts'
import { PATH_PRESENTABLE_STATES } from '@audivra/contracts'
import { getAttackPathRow, listFindingsForEngagement, listSecurityEvidence, listAttackPathsForEngagement, toAttackPath, type Db } from '@audivra/database'
import { SecurityRequestError } from '../service.ts'

/*
 * Phase 6B read side — attack paths, their detail, coverage and the report section, built ONLY from persisted
 * state (no re-discovery, no AI, no capability). Verified and partially-verified paths are kept apart from
 * speculative candidates, and every path's open evidence gaps are surfaced honestly rather than hidden.
 */

export class AttackPathReadService {
  readonly #db: Db

  constructor(options: { db: Db }) {
    this.#db = options.db
  }

  /** Paths for an engagement. By default dominated subpaths are hidden (set `includeDominated` to show them). */
  async listPaths(engagementId: string, options: { state?: PathState; includeDominated?: boolean } = {}): Promise<SecurityAttackPath[]> {
    const paths = await listAttackPathsForEngagement(this.#db, engagementId)
    return paths.filter((p) => (!options.state || p.state === options.state) && (options.includeDominated || !p.dominatedBy))
  }

  async getPath(pathId: string): Promise<AttackPathDetail> {
    const row = await getAttackPathRow(this.#db, pathId)
    if (!row) throw new SecurityRequestError(404, `No attack path ${pathId}`)
    const path = toAttackPath(row)
    const [findingRows, evidenceItems] = await Promise.all([listFindingsForEngagement(this.#db, path.engagementId), listSecurityEvidence(this.#db, path.engagementId)])
    const findings = findingRows
      .filter((f) => path.findingIds.includes(f.id))
      .map((f) => ({ id: f.id, title: f.title, category: f.category, severity: f.severity, verificationState: f.verificationState }))
    const evidenceRefs = new Set(path.steps.flatMap((s) => s.evidenceRefs))
    const evidence = evidenceItems.filter((e) => evidenceRefs.has(e.ref)).map((e) => ({ ref: e.ref, type: e.type, title: e.title }))
    return { path, findings, evidence }
  }

  async coverage(engagementId: string): Promise<AttackPathCoverage> {
    const paths = await listAttackPathsForEngagement(this.#db, engagementId)
    const primary = paths.filter((p) => !p.dominatedBy)
    const tally = <T extends string>(items: readonly T[]): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const k of items) out[k] = (out[k] ?? 0) + 1
      return out
    }
    return {
      total: primary.length,
      byState: tally(primary.map((p) => p.state)),
      byImpact: tally(primary.map((p) => p.impactClass)),
      missingEvidenceEdges: paths.reduce((n, p) => n + p.missingEvidence.length, 0),
      boundariesCrossed: tally(primary.flatMap((p) => p.boundariesCrossed)),
    }
  }

  async report(engagementId: string): Promise<AttackPathReport> {
    const [paths, coverage] = await Promise.all([listAttackPathsForEngagement(this.#db, engagementId), this.coverage(engagementId)])
    const primary = paths.filter((p) => !p.dominatedBy)
    return {
      engagementId,
      generatedAt: new Date().toISOString(),
      verifiedPaths: primary.filter((p) => p.state === 'verified'),
      partiallyVerifiedPaths: primary.filter((p) => p.state === 'partially-verified'),
      openEvidenceGaps: primary.filter((p) => PATH_PRESENTABLE_STATES.includes(p.state) && p.missingEvidence.length).map((p) => ({ pathId: p.id, title: p.title, missing: p.missingEvidence })),
      coverage,
    }
  }
}
