import {
  HypothesisStatus,
  type HypothesisCategory,
  type ReasoningAction,
  type ReasoningCoverage,
  type ReasoningRun,
  type SecurityActor,
  type SecurityHypothesis,
  type SecurityHypothesisDetail,
  type SecurityObservation,
} from '@audivra/contracts'
import {
  countReasoningActions,
  getEngagementRow,
  getGraphNodeRows,
  getHypothesisRow,
  getReasoningRunRow,
  graphCounts,
  listGraphNodes,
  listHypothesisLinks,
  listHypothesisRows,
  listKnowledgeGaps,
  listReasoningActionRows,
  listReasoningRunRows,
  listSecurityObservations,
  toHypothesis,
  toReasoningAction,
  toReasoningRun,
  type Db,
} from '@audivra/database'
import { SecurityRequestError } from '../service.ts'
import type { ReasoningEngine } from './engine.ts'

/*
 * What the API may do with reasoning: read hypotheses (with everything needed to answer "why is Audivra
 * investigating this?"), runs, proposed actions and reasoning coverage; start a bounded run; cancel one.
 * There is no endpoint that runs a prompt, takes a capability id or input, or executes an action — a run's
 * actions come only from the validated planner and the broker.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/
const HYPOTHESIS_ID = /^hy_[0-9a-z]{14}$/
const RUN_ID = /^rr_[0-9a-z]{14}$/

function brief(o: SecurityObservation) {
  return { id: o.id, type: o.type, title: o.title, asset: o.asset, tools: [...new Set(o.contributions.map((c) => c.tool))], evidenceRefs: o.evidenceRefs }
}

export class ReasoningService {
  readonly #db: Db
  readonly #engine: ReasoningEngine | null

  constructor(options: { db: Db; engine?: ReasoningEngine | null }) {
    this.#db = options.db
    this.#engine = options.engine ?? null
  }

  async hypotheses(engagementId: string, filters: { status?: string; category?: HypothesisCategory } = {}): Promise<SecurityHypothesis[]> {
    await this.#engagement(engagementId)
    const status = filters.status ? HypothesisStatus.safeParse(filters.status) : null
    if (status && !status.success) throw new SecurityRequestError(400, `Unknown hypothesis status ${filters.status}`)
    const rows = await listHypothesisRows(this.#db, engagementId, { statuses: status?.success ? [status.data] : undefined, limit: 500 })
    const links = await listHypothesisLinks(this.#db, rows.map((r) => r.id))
    return rows.map((r) => toHypothesis(r, links)).filter((h) => !filters.category || h.category === filters.category)
  }

  async hypothesis(id: string): Promise<SecurityHypothesisDetail> {
    const row = HYPOTHESIS_ID.test(id) ? await getHypothesisRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Hypothesis not found')
    const links = await listHypothesisLinks(this.#db, [row.id])
    const hypothesis = toHypothesis(row, links)
    const nodes = await getGraphNodeRows(this.#db, hypothesis.subjectEntityIds)
    const observationIds = new Set([...hypothesis.supportingObservationIds, ...hypothesis.contradictingObservationIds])
    const observations = observationIds.size ? (await listSecurityObservations(this.#db, row.engagementId, { limit: 20_000 })).filter((o) => observationIds.has(o.id)) : []
    const byId = new Map(observations.map((o) => [o.id, o]))
    const gaps = hypothesis.gapIds.length ? (await listKnowledgeGaps(this.#db, row.engagementId)).filter((g) => hypothesis.gapIds.includes(g.id)) : []
    const actions = (await listReasoningActionRows(this.#db, { hypothesisIds: [row.id], limit: 100 })).map(toReasoningAction)
    return {
      hypothesis,
      entities: nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, basis: n.basis, status: n.status })),
      supporting: hypothesis.supportingObservationIds.map((id) => byId.get(id)).filter((o): o is SecurityObservation => !!o).map(brief),
      contradicting: hypothesis.contradictingObservationIds.map((id) => byId.get(id)).filter((o): o is SecurityObservation => !!o).map(brief),
      gaps: gaps.map((g) => ({ id: g.id, kind: g.kind, question: g.question, status: g.status })),
      actions,
    }
  }

  async runs(engagementId: string): Promise<ReasoningRun[]> {
    await this.#engagement(engagementId)
    return (await listReasoningRunRows(this.#db, engagementId, 50)).map(toReasoningRun)
  }

  async run(id: string): Promise<ReasoningRun> {
    const row = RUN_ID.test(id) ? await getReasoningRunRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Reasoning run not found')
    return toReasoningRun(row)
  }

  async actions(engagementId: string, runId?: string): Promise<ReasoningAction[]> {
    await this.#engagement(engagementId)
    return (await listReasoningActionRows(this.#db, { engagementId, runId, limit: 300 })).map(toReasoningAction)
  }

  async start(engagementId: string, input: unknown, actor: SecurityActor): Promise<ReasoningRun> {
    if (!this.#engine) throw new SecurityRequestError(409, 'Reasoning is not available in this process')
    return this.#engine.start(engagementId, input, actor)
  }

  async cancel(runId: string, actor: SecurityActor): Promise<ReasoningRun> {
    if (!this.#engine) throw new SecurityRequestError(409, 'Reasoning is not available in this process')
    if (!RUN_ID.test(runId)) throw new SecurityRequestError(404, 'Reasoning run not found')
    return this.#engine.cancel(runId, actor)
  }

  /** Reasoning coverage: what is known, unknown, investigated, blocked and exhausted — never a score. */
  async coverage(engagementId: string): Promise<ReasoningCoverage> {
    await this.#engagement(engagementId)
    const [counts, endpoints, technologies, hypotheses, actions, runs] = await Promise.all([
      graphCounts(this.#db, engagementId),
      listGraphNodes(this.#db, engagementId, { kind: 'endpoint', limit: 1000 }),
      listGraphNodes(this.#db, engagementId, { kind: 'technology', limit: 1000 }),
      listHypothesisRows(this.#db, engagementId, { limit: 500 }),
      countReasoningActions(this.#db, engagementId),
      listReasoningRunRows(this.#db, engagementId, 1),
    ])
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
    const inScope = endpoints.filter((e) => e.scopeClass === 'in-scope' && e.status !== 'stale' && e.status !== 'superseded')
    const byStatus: Record<string, number> = {}
    for (const h of hypotheses) byStatus[h.status] = (byStatus[h.status] ?? 0) + 1
    const actionRows = await listReasoningActionRows(this.#db, { engagementId, limit: 1000 })
    const investigated = new Set(actionRows.filter((a) => a.status === 'completed' || a.status === 'failed' || a.status === 'queued').map((a) => a.hypothesisId).filter(Boolean)).size
    const gaps = { open: 0, resolved: 0, byKind: {} as Record<string, { open: number; resolved: number }> }
    for (const g of counts.gaps) {
      const entry = (gaps.byKind[g.kind] ??= { open: 0, resolved: 0 })
      if (g.status === 'open') {
        gaps.open += g.n
        entry.open += g.n
      } else if (g.status === 'resolved') {
        gaps.resolved += g.n
        entry.resolved += g.n
      }
    }
    const latest = runs[0]
    return {
      graph: {
        entities: sum(counts.byKind),
        relationships: sum(counts.byRelation),
        observed: (counts.byBasis.observed ?? 0) + (counts.edgeByBasis.observed ?? 0),
        inferred: (counts.byBasis.inferred ?? 0) + (counts.edgeByBasis.inferred ?? 0),
        contradicted: (counts.byStatus.contradicted ?? 0) + (counts.edgeByStatus.contradicted ?? 0),
        stale: (counts.byStatus.stale ?? 0) + (counts.edgeByStatus.stale ?? 0),
        endpointsInspected: { known: inScope.filter((e) => typeof e.attributes.status === 'number').length, total: inScope.length },
        technologiesCorroborated: { corroborated: technologies.filter((t) => t.corroboration >= 2).length, total: technologies.length },
      },
      gaps,
      hypotheses: { total: hypotheses.length, byStatus, investigated, blocked: byStatus.blocked ?? 0, exhausted: byStatus.exhausted ?? 0 },
      actions: { total: sum(actions), byStatus: actions },
      latestRun: latest ? { id: latest.id, status: latest.status, stopReason: latest.stopReason, aiCoverage: latest.aiCoverage, finishedAt: latest.finishedAt?.toISOString() ?? null } : null,
    }
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }
}
