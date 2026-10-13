import type { Logger } from '@audivra/config'
import type { ComparisonCoverage, ComparisonDimension, ComparisonResult, InvariantEvaluation, SecurityActor, SecurityComparison, SecurityComparisonDetail } from '@audivra/contracts'
import {
  findDomainDeclarationByRef,
  getComparisonRow,
  getEngagementRow,
  getHypothesisRow,
  listComparisonRows,
  listDomainDeclarationRows,
  listSecurityEvidence,
  listSessionsForGraph,
  toComparison,
  type Db,
} from '@audivra/database'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import { comparisonCoverage, invariantEvaluations } from './coverage.ts'
import type { ComparisonEngine } from './engine.ts'
import { proposeComparisons, type PlannerInput, type RankedPlan } from './plan.ts'

/*
 * Phase 5 Step 4 — the API/orchestration surface for differential comparisons: validate+persist a plan,
 * list/read comparisons and their evidence, propose useful comparisons deterministically, and report
 * invariant evaluations and authorization/business coverage. Executing a comparison goes through the engine
 * (and, in production, the worker); nothing here runs an arbitrary request.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/
const COMPARISON_ID = /^cmp_[0-9a-z]{14}$/

export class ComparisonService {
  readonly #db: Db
  readonly #engine: ComparisonEngine

  constructor(options: { db: Db; engine: ComparisonEngine; log?: Logger }) {
    this.#db = options.db
    this.#engine = options.engine
  }

  /** Validate + persist a comparison plan (does not execute). */
  async plan(engagementId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityComparison> {
    return this.#engine.plan(engagementId, input, actor)
  }

  async list(engagementId: string, options: { dimension?: ComparisonDimension; result?: ComparisonResult } = {}): Promise<SecurityComparison[]> {
    await this.#engagement(engagementId)
    return (await listComparisonRows(this.#db, engagementId, options)).map(toComparison)
  }

  async get(comparisonId: string): Promise<SecurityComparisonDetail> {
    const row = COMPARISON_ID.test(comparisonId) ? await getComparisonRow(this.#db, comparisonId) : undefined
    if (!row) throw new SecurityRequestError(404, 'Comparison not found')
    const comparison = toComparison(row)
    const hRow = comparison.hypothesisId ? await getHypothesisRow(this.#db, comparison.hypothesisId) : undefined
    const invRow = comparison.invariantRef ? await findDomainDeclarationByRef(this.#db, comparison.engagementId, 'invariant', comparison.invariantRef) : undefined
    const evidence = (await listSecurityEvidence(this.#db, comparison.engagementId)).filter((e) => comparison.evidenceRefs.includes(e.ref))
    return {
      comparison,
      hypothesis: hRow ? { id: hRow.id, claim: hRow.claim, status: hRow.status } : null,
      invariant: invRow ? { ref: invRow.ref, rule: typeof (invRow.spec as Record<string, unknown>).rule === 'string' ? ((invRow.spec as Record<string, unknown>).rule as string) : invRow.label, category: typeof (invRow.spec as Record<string, unknown>).category === 'string' ? ((invRow.spec as Record<string, unknown>).category as string) : 'other' } : null,
      evidence: evidence.map((e) => ({ ref: e.ref, type: e.type, title: e.title, identityRef: e.provenance.identityRef, sessionRef: e.provenance.sessionRef })),
    }
  }

  async coverage(engagementId: string): Promise<ComparisonCoverage> {
    await this.#engagement(engagementId)
    return comparisonCoverage(this.#db, engagementId)
  }

  async invariants(engagementId: string): Promise<InvariantEvaluation[]> {
    await this.#engagement(engagementId)
    return invariantEvaluations(this.#db, engagementId)
  }

  /** Deterministically propose a bounded, ranked set of useful comparisons (no AI required). */
  async propose(engagementId: string): Promise<RankedPlan[]> {
    const engagement = await this.#engagement(engagementId)
    const input = await this.#plannerInput(engagementId, engagement.environment)
    return proposeComparisons(input)
  }

  async #plannerInput(engagementId: string, environment: string | null): Promise<PlannerInput> {
    const str = (spec: Record<string, unknown>, key: string): string | null => (typeof spec[key] === 'string' && (spec[key] as string).trim() ? (spec[key] as string).trim() : null)
    const list = (spec: Record<string, unknown>, key: string): string[] => (Array.isArray(spec[key]) ? (spec[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [])
    const [identityRows, resourceRows, invariantRows, sessions] = await Promise.all([
      listDomainDeclarationRows(this.#db, engagementId, { kind: 'identity' }),
      listDomainDeclarationRows(this.#db, engagementId, { kind: 'resource' }),
      listDomainDeclarationRows(this.#db, engagementId, { kind: 'invariant' }),
      listSessionsForGraph(this.#db, engagementId),
    ])
    const withSession = new Set(sessions.filter((s) => s.status === 'active').map((s) => s.identityRef))
    const existing = await listComparisonRows(this.#db, engagementId, { limit: 2000 })
    return {
      environment: environment ?? 'production',
      identities: identityRows.map((d) => ({ ref: d.ref, tenantRef: str(d.spec, 'tenantRef'), roleRefs: list(d.spec, 'roleRefs'), hasSession: withSession.has(d.ref) })),
      resources: resourceRows.map((d) => ({ ref: d.ref, ownerRef: str(d.spec, 'ownerRef'), tenantRef: str(d.spec, 'tenantRef'), testData: str(d.spec, 'testData') ?? 'unknown', url: str(d.spec, 'canonicalUrl') ?? str(d.spec, 'endpointUrl') })),
      invariants: invariantRows.map((d) => ({ ref: d.ref, category: str(d.spec, 'category') ?? 'other', rule: str(d.spec, 'rule') ?? d.label, resourceRefs: affectedResourceRefs(d.spec) })),
      existingDedupeKeys: new Set(existing.map((c) => c.dedupeKey)),
    }
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }
}

function affectedResourceRefs(spec: Record<string, unknown>): string[] {
  const affects = Array.isArray(spec.affects) ? spec.affects : []
  return affects.filter((a): a is { kind: string; ref: string } => !!a && typeof a === 'object' && 'kind' in a && (a as { kind: unknown }).kind === 'resource' && typeof (a as { ref: unknown }).ref === 'string').map((a) => a.ref)
}
