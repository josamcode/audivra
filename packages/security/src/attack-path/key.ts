import { createHash } from 'node:crypto'
import type { EndImpact, StartCondition } from '@audivra/contracts'

/*
 * Phase 6B — a stable, engagement-unique, key-safe identity for a path: its start condition, the ordered
 * semantic transitions (impact classes the steps reach), the end impact, and the principal affected entities.
 * The same underlying route discovered from different findings produces the same key, so provenance is
 * merged rather than shown as duplicate paths. Designed so Phase 6C can compare paths across assessments.
 */

export function attackPathKey(start: StartCondition, transitions: readonly string[], end: EndImpact, principalEntityKeys: readonly string[]): string {
  const startToken = `${start.kind}:${start.entityKey ?? start.identityRef ?? 'none'}`
  const endToken = `${end.impactClass}:${end.entityKey ?? 'none'}`
  const entities = [...new Set(principalEntityKeys)].sort().join(',')
  const basis = `${startToken}|${transitions.join('>')}|${endToken}|${entities}`
  return `path:${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`
}
