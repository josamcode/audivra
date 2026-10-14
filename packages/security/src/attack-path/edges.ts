import type { EdgeVerificationState, SecurityGraphEdge, VerificationState } from '@audivra/contracts'

/*
 * Phase 6B — classifying the verification state of a step's evidence. A finding-backed step inherits the
 * finding's own verification; a graph-relationship step inherits the fact's basis and status. The states are
 * kept distinct (verified / supported / inferred / missing / contradicted) and never collapsed into a single
 * number — a path's confidence is later bounded by its weakest meaningful edge, not an average.
 */

/** How strongly a FINDING backs a step. */
export function findingEdgeVerification(state: VerificationState): EdgeVerificationState {
  switch (state) {
    case 'verified':
      return 'verified'
    case 'supported':
      return 'supported'
    case 'inconclusive':
      return 'inferred'
    case 'rejected':
      return 'contradicted'
    default:
      // unverified / needs-evidence / blocked — not demonstrated.
      return 'missing'
  }
}

/** How strongly a GRAPH RELATIONSHIP backs a connecting step. */
export function graphEdgeVerification(edge: SecurityGraphEdge): EdgeVerificationState {
  if (edge.status === 'contradicted' || edge.conflicts.length > 0) return 'contradicted'
  if (edge.status === 'stale' || edge.status === 'superseded') return 'inferred'
  switch (edge.basis) {
    case 'observed':
    case 'declared':
    case 'derived':
      return 'verified'
    case 'inferred':
      return 'inferred'
    default:
      return 'inferred'
  }
}
