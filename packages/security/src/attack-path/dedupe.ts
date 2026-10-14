import { IMPACT_RANK } from './conditions.ts'
import type { CandidatePath } from './discover.ts'
import { attackPathKey } from './key.ts'

/*
 * Phase 6B — path deduplication and dominance. The same semantic route discovered from different findings
 * collapses onto one stable pathKey (provenance merged, never shown twice). A shorter route that is an
 * ordered prefix of a longer route reaching a greater impact is marked as dominated by the longer one, so the
 * client sees the meaningful path rather than twenty trivial variations — both are kept and related, never
 * blindly listed.
 */

export interface KeyedPath extends CandidatePath {
  pathKey: string
  /** pathKey of a path that dominates this one (null when it stands alone). */
  dominatedBy: string | null
}

export function keyOf(path: CandidatePath): string {
  return attackPathKey(path.start, path.transitions, path.end, path.affectedEntityKeys)
}

/** Merge duplicates by pathKey, then compute dominance (a path that is a prefix of a stronger one). */
export function dedupeAndDominate(paths: CandidatePath[]): KeyedPath[] {
  // 1. Merge by stable key.
  const byKey = new Map<string, CandidatePath>()
  for (const p of paths) {
    const k = keyOf(p)
    const existing = byKey.get(k)
    if (!existing) {
      byKey.set(k, p)
      continue
    }
    // Keep the one with more evidence; union the provenance refs.
    const merged: CandidatePath = existing.steps.length >= p.steps.length ? existing : p
    merged.findingIds = [...new Set([...existing.findingIds, ...p.findingIds])]
    merged.comparisonIds = [...new Set([...existing.comparisonIds, ...p.comparisonIds])]
    merged.invariantRefs = [...new Set([...existing.invariantRefs, ...p.invariantRefs])]
    byKey.set(k, merged)
  }
  const keyed: KeyedPath[] = [...byKey.values()].map((p) => ({ ...p, pathKey: keyOf(p), dominatedBy: null }))

  // 2. Dominance: P is dominated by Q when P's ordered findings are a prefix of Q's AND Q reaches a greater
  //    (or equal, but longer) impact from the same start. Keep both; relate them.
  for (const p of keyed) {
    for (const q of keyed) {
      if (p === q || p.dominatedBy) continue
      if (q.findingIds.length <= p.findingIds.length) continue
      if (!isPrefix(p.findingIds, q.findingIds)) continue
      if (p.start.kind !== q.start.kind || p.start.entityKey !== q.start.entityKey) continue
      if (IMPACT_RANK[q.impactClass] < IMPACT_RANK[p.impactClass]) continue
      p.dominatedBy = q.pathKey
      break
    }
  }
  return keyed
}

function isPrefix(short: readonly string[], long: readonly string[]): boolean {
  if (short.length >= long.length) return false
  return short.every((id, i) => long[i] === id)
}
