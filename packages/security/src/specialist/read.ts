import type { SpecialistCoverage, SpecialistEngineId, SpecialistImport, SpecialistRun, SpecialistRunDetail, SpecialistSignal } from '@audivra/contracts'
import {
  getEngagementRow,
  getSpecialistRunRow,
  listCandidatesForEngagement,
  listFindingsForEngagement,
  listSecurityEvidence,
  listSpecialistRunsForEngagement,
  toSpecialistRun,
  type Db,
} from '@audivra/database'
import { SecurityRequestError } from '../service.ts'

/*
 * Phase 6D read surface: specialist runs, their signals (each native result + the Audivra object it became,
 * up to a corroborated finding), the raw artifacts, and specialist coverage kept SEPARATE from deterministic
 * sensors. Everything is built from persisted state; nothing re-runs the engine, the AI or a capability.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export class SpecialistReadService {
  readonly #db: Db

  constructor(options: { db: Db }) {
    this.#db = options.db
  }

  async listRuns(engagementId: string): Promise<SpecialistRun[]> {
    await this.#engagement(engagementId)
    return listSpecialistRunsForEngagement(this.#db, engagementId)
  }

  async getRun(runId: string): Promise<SpecialistRunDetail> {
    const row = await getSpecialistRunRow(this.#db, runId)
    if (!row) throw new SecurityRequestError(404, `No specialist run ${runId}`)
    const run = toSpecialistRun(row)
    const signals = await this.#signals(run)
    const evidence = (await listSecurityEvidence(this.#db, run.engagementId)).filter((e) => run.artifactRefs.includes(e.ref)).map((e) => ({ ref: e.ref, type: e.type, title: e.title }))
    return { run, signals, artifacts: evidence }
  }

  async coverage(engagementId: string, engine: SpecialistEngineId = 'strix'): Promise<SpecialistCoverage> {
    await this.#engagement(engagementId)
    const runs = (await listSpecialistRunsForEngagement(this.#db, engagementId)).filter((r) => r.engine === engine)
    const tally = <T extends string>(items: readonly T[]): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const k of items) out[k] = (out[k] ?? 0) + 1
      return out
    }
    const imports = runs.flatMap((r) => r.imports)
    const signals = await Promise.all(runs.map((r) => this.#signals(r)))
    const corroborated = signals.flat().filter((s) => s.finding).length
    return {
      engine,
      runs: { total: runs.length, byState: tally(runs.map((r) => r.state)), byCompletion: tally(runs.map((r) => r.completion ?? 'none')) },
      signals: {
        total: imports.length,
        observations: imports.filter((i) => i.action === 'observation-created').length,
        merged: imports.filter((i) => i.action === 'merged-existing').length,
        gaps: imports.filter((i) => i.action === 'knowledge-gap').length,
        corroboratedFindings: corroborated,
      },
      caveat: 'Specialist coverage is separate from Audivra’s deterministic sensors. A clean or partial specialist run never means the application is secure.',
    }
  }

  // Map each import to a signal, resolving the Audivra finding it eventually corroborated (via candidate → finding).
  async #signals(run: SpecialistRun): Promise<SpecialistSignal[]> {
    const linked = run.imports.some((i) => i.observationId)
    const candidates = linked ? await listCandidatesForEngagement(this.#db, run.engagementId) : []
    const findings = linked ? await listFindingsForEngagement(this.#db, run.engagementId) : []
    const findingById = new Map(findings.map((f) => [f.id, f]))
    return run.imports.map((imp: SpecialistImport): SpecialistSignal => {
      let finding: SpecialistSignal['finding'] = null
      let candidateIssueKey = imp.candidateIssueKey
      if (imp.observationId) {
        const candidate = candidates.find((c) => c.source.observationIds.includes(imp.observationId!))
        if (candidate) {
          candidateIssueKey = candidate.issueKey
          const f = candidate.findingId ? findingById.get(candidate.findingId) : undefined
          if (f) finding = { id: f.id, title: f.title, severity: f.severity, verificationState: f.verificationState }
        }
      }
      // The native severity/category come from the run's native result metadata where available.
      return { runId: run.id, nativeId: imp.nativeId, title: imp.title, nativeSeverity: imp.nativeSeverity, nativeCategory: this.#nativeCategory(run, imp.nativeId), action: imp.action, matchedEntityKey: imp.matchedEntityKey, observationId: imp.observationId, candidateIssueKey, finding }
    })
  }

  #nativeCategory(run: SpecialistRun, _nativeId: string): string {
    void run
    return 'specialist'
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }
}
