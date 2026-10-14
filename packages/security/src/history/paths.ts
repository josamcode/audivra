import type { AttackPathDiffEntry, PathEdgeLite, PathHistoryClass, PathVerificationChange, SecurityAttackPath } from '@audivra/contracts'

/*
 * Phase 6C — compare attack paths across assessments using the 6B stable pathKey. A path that is no longer
 * rediscovered is `disappeared`, NOT "fixed" — a path can vanish because a scanner simply did not re-walk it,
 * so disappearance is reported honestly and never asserted as a remediation. A matched path shows removed
 * verified edges, new edges, verification-state changes and any impact change.
 */

const edgeLite = (p: SecurityAttackPath): PathEdgeLite[] => p.steps.map((s) => ({ label: `${s.fromCondition} → ${s.toCondition}`, edgeVerification: s.edgeVerification }))

export function diffAttackPaths(previous: readonly SecurityAttackPath[], current: readonly SecurityAttackPath[]): AttackPathDiffEntry[] {
  const curByKey = new Map(current.map((p) => [p.pathKey, p]))
  const prevByKey = new Map(previous.map((p) => [p.pathKey, p]))
  const entries: AttackPathDiffEntry[] = []

  for (const prev of previous) {
    const cur = curByKey.get(prev.pathKey)
    if (!cur) {
      entries.push({
        class: 'disappeared',
        pathKey: prev.pathKey,
        title: prev.title,
        previousPathId: prev.id,
        currentPathId: null,
        previousState: prev.state,
        currentState: null,
        removedVerifiedEdges: edgeLite(prev).filter((e) => e.edgeVerification === 'verified'),
        newEdges: [],
        verificationChanges: [],
        impactChange: null,
        reason: 'The path was not rediscovered in the current assessment (not necessarily fixed — coverage may differ)',
      })
      continue
    }
    const prevEdges = edgeLite(prev)
    const curEdges = edgeLite(cur)
    const curLabels = new Set(curEdges.map((e) => e.label))
    const prevLabels = new Set(prevEdges.map((e) => e.label))
    const removedVerifiedEdges = prevEdges.filter((e) => e.edgeVerification === 'verified' && !curLabels.has(e.label))
    const newEdges = curEdges.filter((e) => !prevLabels.has(e.label))
    const verificationChanges: PathVerificationChange[] = []
    for (const pe of prevEdges) {
      const ce = curEdges.find((c) => c.label === pe.label)
      if (ce && ce.edgeVerification !== pe.edgeVerification) verificationChanges.push({ label: pe.label, from: pe.edgeVerification, to: ce.edgeVerification })
    }
    const impactChange = prev.impactPriority !== cur.impactPriority ? { from: prev.impactPriority, to: cur.impactPriority } : null

    let cls: PathHistoryClass
    let reason: string
    const weakened = removedVerifiedEdges.length > 0 || verificationChanges.some((c) => rank(c.to) > rank(c.from))
    if (cur.missingEvidence.length > prev.missingEvidence.length) {
      cls = 'missing-evidence'
      reason = 'The current path has new missing evidence'
    } else if (removedVerifiedEdges.length && cur.state !== 'verified') {
      cls = weakened && cur.state === 'speculative' ? 'partially-remains' : 'changed'
      reason = `A previously verified edge is gone (${removedVerifiedEdges.map((e) => e.label).join('; ')})`
    } else if (newEdges.length || verificationChanges.length || impactChange) {
      cls = 'changed'
      reason = 'The path steps or impact changed'
    } else {
      cls = 'still-present'
      reason = 'The path is present and unchanged'
    }
    entries.push({ class: cls, pathKey: prev.pathKey, title: cur.title, previousPathId: prev.id, currentPathId: cur.id, previousState: prev.state, currentState: cur.state, removedVerifiedEdges, newEdges, verificationChanges, impactChange, reason })
  }
  // Paths newly present in the current assessment are not part of the historical diff (they are new paths,
  // shown by the current assessment's own report); we only track the fate of previously-known paths.
  void prevByKey
  return entries
}

const rank = (s: PathEdgeLite['edgeVerification']): number => ({ verified: 0, supported: 1, inferred: 2, missing: 3, contradicted: 4 })[s]
