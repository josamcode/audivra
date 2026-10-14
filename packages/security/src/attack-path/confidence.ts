import { EDGE_VERIFICATION_RANK, SEVERITY_RANK, type AttackStep, type EdgeVerificationState, type ImpactClass, type PathState, type Severity, type TrustBoundaryKind } from '@audivra/contracts'
import type { CandidatePath } from './discover.ts'

/*
 * Phase 6B — a path's verification state and confidence are bounded by its WEAKEST meaningful edge, never an
 * average of its strong ones: a verified→verified→inferred path is partially-verified, not verified; a path
 * with a missing edge is speculative; a path with a contradicted step is rejected. Path impact/priority is a
 * SEPARATE axis (final impact, boundaries crossed, starting privilege, edge strength) — it never silently
 * inflates a finding's own severity.
 */

const BY_RANK: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
const clampRank = (rank: number): Severity => BY_RANK[Math.max(0, Math.min(4, rank))]!

export interface PathVerdict {
  state: PathState
  confidence: number
  reason: string
  weakest: EdgeVerificationState
}

/** The weakest edge decides. */
export function pathVerdict(steps: readonly { edgeVerification: EdgeVerificationState }[]): PathVerdict {
  const weakest = steps.reduce<EdgeVerificationState>((w, s) => (EDGE_VERIFICATION_RANK[s.edgeVerification] > EDGE_VERIFICATION_RANK[w] ? s.edgeVerification : w), 'verified')
  const hasStrong = steps.some((s) => s.edgeVerification === 'verified' || s.edgeVerification === 'supported')
  switch (weakest) {
    case 'verified':
      return { state: 'verified', confidence: 0.9, reason: 'every step is verified', weakest }
    case 'supported':
      return { state: 'supported', confidence: 0.7, reason: 'the weakest step is supported', weakest }
    case 'inferred':
      return { state: hasStrong ? 'partially-verified' : 'speculative', confidence: 0.45, reason: 'an inferred step bounds the path', weakest }
    case 'missing':
      return { state: 'speculative', confidence: 0.25, reason: 'a required connecting edge is missing', weakest }
    case 'contradicted':
      return { state: 'rejected', confidence: 0.05, reason: 'a step is contradicted by stored evidence', weakest }
  }
}

const IMPACT_BASE: Record<ImpactClass, Severity> = {
  'unauthorized-data-access': 'high',
  'cross-tenant-access': 'critical',
  'unauthorized-state-change': 'high',
  'privilege-boundary-crossed': 'critical',
  'sensitive-capability-reached': 'medium',
  'security-control-bypassed': 'medium',
}

/**
 * Path priority — a separate axis from finding severity. Starts from the final impact, is raised a little by
 * each additional trust boundary crossed, and is lowered when the path is not fully verified or starts from a
 * highly-privileged position (a route that needs admin to begin with is less of a priority than one from
 * anonymous).
 */
export function pathImpactPriority(path: CandidatePath, verdict: PathVerdict): Severity {
  if (verdict.state === 'rejected') return 'info'
  // Impact subtotal: final impact, raised by extra boundaries and a no-privilege start. Clamped before the
  // verification penalty so a strong impact can never absorb the penalty by going arbitrarily negative.
  let rank = SEVERITY_RANK[IMPACT_BASE[path.impactClass]]
  if (new Set<TrustBoundaryKind>(path.boundariesCrossed).size >= 2) rank -= 1
  if (path.start.kind === 'anonymous') rank -= 1
  if (path.start.kind === 'tenant-admin') rank += 1
  rank = Math.max(0, Math.min(4, rank))
  // A path that is not fully verified is a lower priority than a demonstrated one.
  if (verdict.state === 'partially-verified' || verdict.state === 'supported') rank += 1
  if (verdict.state === 'speculative') rank += 2
  return clampRank(rank)
}

/** Confidence from the path's steps (same rule; convenience over a resolved step list). */
export function confidenceFromSteps(steps: readonly AttackStep[]): number {
  return pathVerdict(steps).confidence
}
