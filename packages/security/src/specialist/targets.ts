import type { RequestSpecialistRunInput, ScopeManifest, SpecialistMode, SpecialistTarget } from '@audivra/contracts'
import { findDomainDeclarationByRef, getFindingRow, listDomainDeclarationRows, toFinding, type Db } from '@audivra/database'
import { evaluateUrl } from '../scope.ts'

/*
 * Phase 6D — Audivra constructs the specialist target set and classifies EVERY target against the engagement
 * scope. A target that Strix might discover does not become authorized because Strix discovered it; only
 * targets Audivra built from its own trusted state are ever passed to the engine, and out-of-scope ones are
 * omitted. For source-only runs, the "target" is an execution-owned staged source tree — no network.
 */

const str = (spec: Record<string, unknown>, key: string): string | null => (typeof spec[key] === 'string' && (spec[key] as string).trim() ? (spec[key] as string).trim() : null)

export async function buildSpecialistTargets(db: Db, engagementId: string, scope: ScopeManifest, input: RequestSpecialistRunInput, mode: SpecialistMode): Promise<SpecialistTarget[]> {
  const targets: SpecialistTarget[] = []
  const seen = new Set<string>()
  const addUrl = (url: string | null, assetKey: string | null) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    targets.push({ kind: 'url', value: url, assetKey, inScope: evaluateUrl(scope, url, { kind: 'target' }).decision === 'allow' })
  }

  // Resources named explicitly → their declared canonical URLs.
  for (const ref of input.resourceRefs) {
    const decl = await findDomainDeclarationByRef(db, engagementId, 'resource', ref)
    if (decl) addUrl(str(decl.spec as Record<string, unknown>, 'canonicalUrl') ?? str(decl.spec as Record<string, unknown>, 'endpointUrl'), decl.key)
  }
  // Findings to deepen → the declared URL of each finding's affected resource(s), when resolvable.
  for (const id of input.findingIds) {
    const row = await getFindingRow(db, id)
    if (!row) continue
    const finding = toFinding(row)
    for (const entity of finding.affectedEntities.filter((e) => e.kind === 'resource')) {
      const decl = await findDomainDeclarationByRef(db, engagementId, 'resource', entity.label)
      if (decl) addUrl(str(decl.spec as Record<string, unknown>, 'canonicalUrl'), decl.key)
    }
  }
  // Source-only: a staged, reviewed source tree (no network). Only the explicitly staged input is used.
  if (mode === 'source-only' && input.stagedSourceRef) {
    targets.push({ kind: 'staged-source', value: input.stagedSourceRef, assetKey: null, inScope: true })
  }
  // Fallback for a live run with no explicit resources: the engagement's declared resources (in-scope only).
  if (mode !== 'source-only' && targets.filter((t) => t.kind === 'url').length === 0) {
    for (const decl of await listDomainDeclarationRows(db, engagementId, { kind: 'resource' })) {
      addUrl(str(decl.spec as Record<string, unknown>, 'canonicalUrl'), decl.key)
    }
  }
  return targets
}

/** The targets that may actually be passed to the engine (in-scope only). */
export const inScopeTargets = (targets: readonly SpecialistTarget[]): SpecialistTarget[] => targets.filter((t) => t.inScope)
