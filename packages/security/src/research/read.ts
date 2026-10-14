import type { ResearchTimelineEntry, SecurityResearchRun, SecurityResearchRunDetail } from '@audivra/contracts'
import { getEngagementRow, getResearchRunRow, listFindingsForEngagement, listResearchActions, listResearchRunsForEngagement, toResearchRun, type Db } from '@audivra/database'
import { SecurityRequestError } from '../service.ts'

/*
 * Phase 6E read surface: research runs, a run's actions + a concise decision timeline, and the findings the
 * run surfaced (read from the authoritative finding store, never asserted here). Everything is built from
 * persisted state; nothing re-runs the loop, the AI or a capability.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export class ResearchReadService {
  readonly #db: Db

  constructor(options: { db: Db }) {
    this.#db = options.db
  }

  async listRuns(engagementId: string): Promise<SecurityResearchRun[]> {
    await this.#engagement(engagementId)
    return listResearchRunsForEngagement(this.#db, engagementId)
  }

  async getRun(runId: string): Promise<SecurityResearchRunDetail> {
    const row = await getResearchRunRow(this.#db, runId)
    if (!row) throw new SecurityRequestError(404, `No research run ${runId}`)
    const run = toResearchRun(row)
    const actions = await listResearchActions(this.#db, runId)
    const timeline: ResearchTimelineEntry[] = actions
      .filter((a) => a.state !== 'proposed')
      .map((a) => ({
        at: a.updatedAt,
        type: `${a.kind}.${a.state}`,
        message: a.state === 'rejected' ? `Rejected ${a.kind}${a.rejection ? ` (${a.rejection})` : ''}: ${a.reason}` : `${a.kind}${a.usefulness ? ` → ${a.usefulness}` : ''}: ${a.outcome || a.reason}`,
        level: a.state === 'blocked' || a.rejection ? ('warn' as const) : ('info' as const),
      }))
    const findings = (await listFindingsForEngagement(this.#db, run.engagementId)).map((f) => ({ id: f.id, title: f.title, severity: f.severity, verificationState: f.verificationState }))
    return { run, actions, timeline, findings }
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }
}
