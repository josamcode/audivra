import type { ComparisonCoverage, ComparisonCoverageDimension, InvariantEvaluation, InvariantEvalStatus, SecurityComparison } from '@audivra/contracts'
import { COMPARISON_DIMENSIONS } from '@audivra/contracts'
import { listComparisonsForEngagement, listDomainDeclarationRows, type Db } from '@audivra/database'

/*
 * Phase 5 Step 4 — authorization/business coverage. It reports what the engagement can and has compared —
 * entities declared, comparisons by result and dimension, which controls were present, and which invariants
 * controlled comparisons have supported/contradicted — as counts and states, never a single fabricated
 * "security score". UNKNOWN stays visible: an invariant with no comparison is `not-tested`, not "passed".
 */

export async function comparisonCoverage(db: Db, engagementId: string): Promise<ComparisonCoverage> {
  const [identities, roles, tenants, resources, actions, states, invariantDecls, comparisons] = await Promise.all([
    listDomainDeclarationRows(db, engagementId, { kind: 'identity' }),
    listDomainDeclarationRows(db, engagementId, { kind: 'role' }),
    listDomainDeclarationRows(db, engagementId, { kind: 'tenant' }),
    listDomainDeclarationRows(db, engagementId, { kind: 'resource' }),
    listDomainDeclarationRows(db, engagementId, { kind: 'business-action' }),
    listDomainDeclarationRows(db, engagementId, { kind: 'business-state' }),
    listDomainDeclarationRows(db, engagementId, { kind: 'invariant' }),
    listComparisonsForEngagement(db, engagementId),
  ])

  const byResult: Record<string, number> = {}
  for (const c of comparisons) byResult[c.result] = (byResult[c.result] ?? 0) + 1

  const dimensions: Record<string, ComparisonCoverageDimension> = {}
  for (const dimension of COMPARISON_DIMENSIONS) {
    const forDim = comparisons.filter((c) => c.dimension === dimension)
    dimensions[dimension] = {
      tested: forDim.filter((c) => c.status === 'completed').length,
      inconsistent: forDim.filter((c) => c.result === 'inconsistent').length,
      inconclusive: forDim.filter((c) => c.result === 'inconclusive').length,
      blocked: forDim.filter((c) => c.result === 'blocked').length,
    }
  }

  const controls = { positive: 0, negative: 0, both: 0, neither: 0 }
  for (const c of comparisons) {
    if (c.controls.positive) controls.positive++
    if (c.controls.negative) controls.negative++
    if (c.controls.positive && c.controls.negative) controls.both++
    if (!c.controls.positive && !c.controls.negative) controls.neither++
  }

  const invariantStatuses = invariantDecls.map((inv) => aggregateInvariant(inv.ref, comparisons).status)
  return {
    entities: {
      identities: identities.length,
      roles: roles.length,
      tenants: tenants.length,
      resources: resources.length,
      actions: actions.length,
      businessStates: states.length,
      invariants: invariantDecls.length,
    },
    comparisons: { total: comparisons.length, byResult, sampled: comparisons.filter((c) => c.coverageSampled).length },
    dimensions,
    controls,
    invariants: {
      total: invariantDecls.length,
      supported: invariantStatuses.filter((s) => s === 'supported').length,
      contradicted: invariantStatuses.filter((s) => s === 'contradicted').length,
      inconclusive: invariantStatuses.filter((s) => s === 'inconclusive').length,
      notTested: invariantStatuses.filter((s) => s === 'not-tested').length,
    },
  }
}

function aggregateInvariant(invariantRef: string, comparisons: SecurityComparison[]): { status: InvariantEvalStatus; supporting: string[]; contradicting: string[] } {
  const linked = comparisons.filter((c) => c.invariantRef === invariantRef && c.status === 'completed')
  const supporting = linked.filter((c) => c.invariantEvaluation === 'supported').map((c) => c.id)
  const contradicting = linked.filter((c) => c.invariantEvaluation === 'contradicted').map((c) => c.id)
  const status: InvariantEvalStatus = contradicting.length ? 'contradicted' : supporting.length ? 'supported' : linked.length ? 'inconclusive' : 'not-tested'
  return { status, supporting, contradicting }
}

export async function invariantEvaluations(db: Db, engagementId: string): Promise<InvariantEvaluation[]> {
  const [invariantDecls, comparisons] = await Promise.all([listDomainDeclarationRows(db, engagementId, { kind: 'invariant' }), listComparisonsForEngagement(db, engagementId)])
  return invariantDecls.map((inv) => {
    const agg = aggregateInvariant(inv.ref, comparisons)
    const spec = inv.spec as Record<string, unknown>
    return {
      invariantRef: inv.ref,
      category: typeof spec.category === 'string' ? spec.category : 'other',
      rule: typeof spec.rule === 'string' ? spec.rule : inv.label,
      status: agg.status,
      supportingComparisonIds: agg.supporting,
      contradictingComparisonIds: agg.contradicting,
      detail: agg.status === 'not-tested' ? 'No controlled comparison has evaluated this invariant yet' : `${agg.supporting.length} supporting, ${agg.contradicting.length} contradicting comparison(s)`,
    }
  })
}
