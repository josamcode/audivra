import { createHash } from 'node:crypto'
import type { ComparisonDimension, EvidenceCheck, HypothesisCategory, HypothesisStatus, SecurityActor, SecurityComparison, SecurityHypothesis } from '@audivra/contracts'
import { getEngagementRow, getHypothesisRow, insertHypothesis, listComparisonsForEngagement, newHypothesisId, recordSecurityEvent, toHypothesis, updateHypothesis, type Db } from '@audivra/database'
import { assessChecks } from '../reasoning/hypotheses.ts'
import type { KnowledgeView } from '../reasoning/knowledge.ts'

/*
 * Phase 5 Step 4 — authorization/business hypotheses and their deterministic update from comparisons. These
 * hypotheses are owned by the comparison engine (the sensor researcher never produces them). Their only
 * evidence is `comparison-result` checks, so a hypothesis moves ONLY when a stored comparison linked to it
 * settles — never because a model said so. An INCONSISTENT comparison supports a boundary-weakness
 * hypothesis; a CONSISTENT one contradicts (disproves) it; adequate controls make an inconsistent signal a
 * confirmed signal (still not a verified vulnerability — that is a later phase).
 */

const DIMENSION_CATEGORY: Record<ComparisonDimension, HypothesisCategory> = {
  'object-boundary': 'object-boundary',
  'role-boundary': 'role-boundary',
  'tenant-boundary': 'tenant-boundary',
  'function-level': 'function-level',
  'field-boundary': 'field-boundary',
  'session-boundary': 'session-boundary',
  'state-transition': 'business-rule',
  ownership: 'object-boundary',
}

export function boundaryEvidenceChecks(dimension: ComparisonDimension): EvidenceCheck[] {
  return [
    { check: 'comparison-result', dimension, results: ['inconsistent'], effect: 'supports' },
    { check: 'comparison-result', dimension, results: ['consistent'], effect: 'contradicts' },
  ]
}

function boundaryDedupeKey(dimension: ComparisonDimension, resourceRef: string, subjectIdentityRef: string | null): string {
  return `auth:${createHash('sha256').update(`${dimension}|${resourceRef}|${subjectIdentityRef ?? 'anon'}`).digest('hex').slice(0, 24)}`
}

export interface BoundaryHypothesisInput {
  engagementId: string
  dimension: ComparisonDimension
  resourceRef: string
  subjectIdentityRef: string | null
  claim: string
  rationale: string
  invariantRef?: string | null
  origin?: 'ai' | 'user'
}

/** Finds or creates the authorization hypothesis a comparison investigates (idempotent on its dedupe key). */
export async function ensureBoundaryHypothesis(db: Db, input: BoundaryHypothesisInput): Promise<SecurityHypothesis> {
  const dedupeKey = boundaryDedupeKey(input.dimension, input.resourceRef, input.subjectIdentityRef)
  const existing = (await listComparisonHypotheses(db, input.engagementId)).find((h) => h.dedupeKey === dedupeKey)
  if (existing) return existing
  const id = newHypothesisId()
  const row = await insertHypothesis(db, {
    id,
    engagementId: input.engagementId,
    dedupeKey,
    claim: input.claim,
    category: DIMENSION_CATEGORY[input.dimension],
    status: 'needs-evidence',
    statusReason: 'Awaiting a differential comparison',
    confidence: 0.3,
    impact: 'high',
    rationale: input.rationale,
    evidenceChecks: boundaryEvidenceChecks(input.dimension),
    checkResults: [],
    candidateCapabilities: [],
    origin: { kind: input.origin ?? 'user', runId: null, providerId: null, model: null, promptVersion: null },
    review: { verdict: 'not-reviewed', note: null, providerId: null },
    history: [{ at: new Date().toISOString(), from: null, to: 'needs-evidence', reason: 'Boundary hypothesis created for differential comparison', actor: input.origin === 'ai' ? 'ai' : 'user', runId: null }],
  })
  return toHypothesis(row, [])
}

async function listComparisonHypotheses(db: Db, engagementId: string): Promise<SecurityHypothesis[]> {
  const { listHypothesisRows, listHypothesisLinks } = await import('@audivra/database')
  const rows = await listHypothesisRows(db, engagementId, { limit: 500 })
  const links = await listHypothesisLinks(db, rows.map((r) => r.id))
  return rows.map((r) => toHypothesis(r, links))
}

/** A minimal knowledge view carrying only the comparisons — enough to evaluate `comparison-result` checks. */
function comparisonView(comparisons: SecurityComparison[]): KnowledgeView {
  return {
    engagement: { id: '', environment: null, targetUrl: '', scope: {} as never, configVersion: 0 },
    nodes: new Map(),
    nodesByKey: new Map(),
    edges: [],
    adjacency: new Map(),
    observationsByNode: new Map(),
    observations: new Map(),
    gaps: new Map(),
    hypotheses: [],
    actions: [],
    capabilities: [],
    comparisons,
  }
}

/**
 * Re-evaluates an authorization hypothesis from the engagement's stored comparisons and transitions it
 * deterministically. Returns the new status when it changed.
 */
export async function reassessBoundaryHypothesis(db: Db, hypothesisId: string, actor: SecurityActor): Promise<HypothesisStatus | null> {
  const row = await getHypothesisRow(db, hypothesisId)
  if (!row) return null
  const hypothesis = toHypothesis(row, [])
  const comparisons = await listComparisonsForEngagement(db, row.engagementId)
  const outcome = assessChecks(hypothesis.evidenceChecks, comparisonView(comparisons), hypothesisId)
  const to: HypothesisStatus | null = outcome.status
  if (!to || to === hypothesis.status) {
    if (JSON.stringify(outcome.results) !== JSON.stringify(hypothesis.checkResults)) await updateHypothesis(db, hypothesisId, { checkResults: outcome.results })
    return null
  }
  const transition = { at: new Date().toISOString(), from: hypothesis.status, to, reason: outcome.reason, actor: actor.kind === 'agent' ? ('ai' as const) : ('user' as const), runId: null }
  await updateHypothesis(db, hypothesisId, {
    status: to,
    statusReason: outcome.reason,
    confidence: outcome.confidence ?? hypothesis.confidence,
    checkResults: outcome.results,
    history: [...hypothesis.history, transition],
  })
  const engagement = await getEngagementRow(db, row.engagementId)
  await recordSecurityEvent(db, {
    engagementId: row.engagementId,
    type: to === 'disproved' ? 'hypothesis.disproved' : 'hypothesis.updated',
    message: `Comparison evidence moved "${hypothesis.claim.slice(0, 80)}" to ${to}: ${outcome.reason}`,
    actor: { kind: 'system', id: 'audivra-comparison', agentRunId: null },
    configVersion: engagement?.configVersion ?? 0,
    data: { hypothesisId, to },
  })
  return to
}
