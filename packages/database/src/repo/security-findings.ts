import { and, asc, desc, eq } from 'drizzle-orm'
import type {
  CandidateSource,
  CandidateTransition,
  ConfidenceFactors,
  FindingAffectedEntity,
  FindingCategory,
  FindingStatus,
  FindingTransition,
  FindingVerifierVerdict,
  ReproductionRecord,
  SecurityFinding,
  SecurityVerificationCandidate,
  Severity,
  SeverityInputs,
  VerificationCheck,
  VerificationCheckResult,
  VerificationState,
} from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { securityFindings, securityVerificationCandidates } from '../schema.ts'
import type { DbOrTx } from './security-graph.ts'

/*
 * Phase 6A persistence for the verification boundary. Two tables, one per stage:
 *   - security_verification_candidates: a strong signal promoted for verification (NOT yet a finding).
 *   - security_findings: a synthesized finding, written only when the candidate's deterministic checks pass.
 * Both are keyed per (engagement, issueKey) so the same issue is advanced, never duplicated. Rows are
 * secret-free: they carry references (evidence refs, entity keys, execution ids), never session/credential
 * material. The repo never decides verification — it only stores what the engine computed.
 */

type CandidateVerifier = { verdict: FindingVerifierVerdict; note: string | null; providerId: string | null }

export type CandidateRow = typeof securityVerificationCandidates.$inferSelect
export type FindingRow = typeof securityFindings.$inferSelect

export const newCandidateId = () => newId('vc')
export const newFindingId = () => newId('fnd')

export function toCandidate(row: CandidateRow): SecurityVerificationCandidate {
  return {
    id: row.id,
    engagementId: row.engagementId,
    issueKey: row.issueKey,
    claim: row.claim,
    category: row.category,
    affectedEntityKeys: row.affectedEntityKeys,
    supportingEvidenceRefs: row.supportingEvidenceRefs,
    contradictingEvidenceRefs: row.contradictingEvidenceRefs,
    source: row.source,
    requiredChecks: row.requiredChecks,
    checkResults: row.checkResults,
    status: row.status,
    statusReason: row.statusReason,
    verifier: row.verifier,
    findingId: row.findingId ?? null,
    history: row.history,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toFinding(row: FindingRow): SecurityFinding {
  return {
    id: row.id,
    engagementId: row.engagementId,
    issueKey: row.issueKey,
    title: row.title,
    category: row.category,
    severity: row.severity,
    severityReason: row.severityReason,
    confidence: row.confidence,
    verificationState: row.verificationState,
    status: row.status,
    affectedEntities: row.affectedEntities,
    claim: row.claim,
    evidenceRefs: row.evidenceRefs,
    contradictingEvidenceRefs: row.contradictingEvidenceRefs,
    impact: row.impact,
    remediation: row.remediation,
    reproduction: row.reproduction ?? null,
    severityInputs: row.severityInputs,
    confidenceFactors: row.confidenceFactors,
    candidateIds: row.candidateIds,
    hypothesisIds: row.hypothesisIds,
    comparisonIds: row.comparisonIds,
    invariantRefs: row.invariantRefs,
    reviewed: row.reviewed,
    reviewNote: row.reviewNote ?? null,
    history: row.history,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ── Candidates ──────────────────────────────────────────────────────────────────────────────────────────

export interface CreateCandidateRecord {
  id: string
  engagementId: string
  issueKey: string
  claim: string
  category: FindingCategory
  affectedEntityKeys: string[]
  supportingEvidenceRefs: string[]
  contradictingEvidenceRefs: string[]
  source: CandidateSource
  requiredChecks: VerificationCheck[]
  status: VerificationState
  statusReason: string
  history: CandidateTransition[]
}

export interface CandidatePatch {
  claim?: string
  affectedEntityKeys?: string[]
  supportingEvidenceRefs?: string[]
  contradictingEvidenceRefs?: string[]
  requiredChecks?: VerificationCheck[]
  checkResults?: VerificationCheckResult[]
  status?: VerificationState
  statusReason?: string
  verifier?: CandidateVerifier
  findingId?: string | null
  history?: CandidateTransition[]
}

export async function insertCandidate(db: DbOrTx, input: CreateCandidateRecord): Promise<CandidateRow> {
  const [row] = await db
    .insert(securityVerificationCandidates)
    .values({ ...input, claim: input.claim.slice(0, 2000) })
    .returning()
  if (!row) throw new Error('Failed to record verification candidate')
  return row
}

export async function updateCandidate(db: DbOrTx, id: string, patch: CandidatePatch): Promise<CandidateRow | undefined> {
  const [row] = await db
    .update(securityVerificationCandidates)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securityVerificationCandidates.id, id))
    .returning()
  return row
}

export async function getCandidateRow(db: DbOrTx, id: string): Promise<CandidateRow | undefined> {
  const [row] = await db.select().from(securityVerificationCandidates).where(eq(securityVerificationCandidates.id, id))
  return row
}

export async function findCandidateByIssueKey(db: DbOrTx, engagementId: string, issueKey: string): Promise<CandidateRow | undefined> {
  const [row] = await db
    .select()
    .from(securityVerificationCandidates)
    .where(and(eq(securityVerificationCandidates.engagementId, engagementId), eq(securityVerificationCandidates.issueKey, issueKey)))
  return row
}

export async function listCandidateRows(
  db: DbOrTx,
  engagementId: string,
  options: { status?: VerificationState; limit?: number } = {},
): Promise<CandidateRow[]> {
  return db
    .select()
    .from(securityVerificationCandidates)
    .where(
      and(
        eq(securityVerificationCandidates.engagementId, engagementId),
        options.status ? eq(securityVerificationCandidates.status, options.status) : undefined,
      ),
    )
    .orderBy(asc(securityVerificationCandidates.createdAt))
    .limit(Math.min(options.limit ?? 500, 2000))
}

export async function listCandidatesForEngagement(db: DbOrTx, engagementId: string, limit = 2000): Promise<SecurityVerificationCandidate[]> {
  return (await listCandidateRows(db, engagementId, { limit })).map(toCandidate)
}

// ── Findings ────────────────────────────────────────────────────────────────────────────────────────────

export interface CreateFindingRecord {
  id: string
  engagementId: string
  issueKey: string
  title: string
  category: FindingCategory
  severity: Severity
  severityReason: string
  confidence: number
  verificationState: VerificationState
  status: FindingStatus
  affectedEntities: FindingAffectedEntity[]
  claim: string
  evidenceRefs: string[]
  contradictingEvidenceRefs: string[]
  impact: string
  remediation: string
  reproduction: ReproductionRecord | null
  severityInputs: SeverityInputs
  confidenceFactors: ConfidenceFactors
  candidateIds: string[]
  hypothesisIds: string[]
  comparisonIds: string[]
  invariantRefs: string[]
  reviewed: boolean
  reviewNote: string | null
  history: FindingTransition[]
}

export interface FindingPatch {
  title?: string
  severity?: Severity
  severityReason?: string
  confidence?: number
  verificationState?: VerificationState
  status?: FindingStatus
  affectedEntities?: FindingAffectedEntity[]
  claim?: string
  evidenceRefs?: string[]
  contradictingEvidenceRefs?: string[]
  impact?: string
  remediation?: string
  reproduction?: ReproductionRecord | null
  severityInputs?: SeverityInputs
  confidenceFactors?: ConfidenceFactors
  candidateIds?: string[]
  hypothesisIds?: string[]
  comparisonIds?: string[]
  invariantRefs?: string[]
  reviewed?: boolean
  reviewNote?: string | null
  history?: FindingTransition[]
}

export async function insertFinding(db: DbOrTx, input: CreateFindingRecord): Promise<FindingRow> {
  const [row] = await db
    .insert(securityFindings)
    .values({ ...input, title: input.title.slice(0, 300) })
    .returning()
  if (!row) throw new Error('Failed to record security finding')
  return row
}

export async function updateFinding(db: DbOrTx, id: string, patch: FindingPatch): Promise<FindingRow | undefined> {
  const [row] = await db
    .update(securityFindings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(securityFindings.id, id))
    .returning()
  return row
}

export async function getFindingRow(db: DbOrTx, id: string): Promise<FindingRow | undefined> {
  const [row] = await db.select().from(securityFindings).where(eq(securityFindings.id, id))
  return row
}

export async function findFindingByIssueKey(db: DbOrTx, engagementId: string, issueKey: string): Promise<FindingRow | undefined> {
  const [row] = await db
    .select()
    .from(securityFindings)
    .where(and(eq(securityFindings.engagementId, engagementId), eq(securityFindings.issueKey, issueKey)))
  return row
}

export async function listFindingRows(
  db: DbOrTx,
  engagementId: string,
  options: { category?: FindingCategory; status?: FindingStatus; verificationState?: VerificationState; limit?: number } = {},
): Promise<FindingRow[]> {
  return db
    .select()
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.engagementId, engagementId),
        options.category ? eq(securityFindings.category, options.category) : undefined,
        options.status ? eq(securityFindings.status, options.status) : undefined,
        options.verificationState ? eq(securityFindings.verificationState, options.verificationState) : undefined,
      ),
    )
    .orderBy(desc(securityFindings.createdAt))
    .limit(Math.min(options.limit ?? 500, 2000))
}

export async function listFindingsForEngagement(db: DbOrTx, engagementId: string, limit = 2000): Promise<SecurityFinding[]> {
  return (await listFindingRows(db, engagementId, { limit })).map(toFinding)
}
