import type { IdentityCoverageItem } from '@audivra/contracts'
import { listCredentialRows, listDomainDeclarationRows, listObservationsForGraph, listSessionRows, type Db } from '@audivra/database'

/*
 * Identity coverage (Phase 5 Step 3): a read-only, secret-free summary of what an engagement can actually
 * authenticate as — which declared identities have a resolvable credential, an active (validated) session,
 * and an authenticated surface observed under them. It never gates anything; it makes the honest state
 * visible (`UNKNOWN != FALSE`).
 */
export async function identityCoverage(db: Db, engagementId: string, now: () => Date = () => new Date()): Promise<IdentityCoverageItem[]> {
  const [identities, credentials, sessions, observations] = await Promise.all([
    listDomainDeclarationRows(db, engagementId, { kind: 'identity' }),
    listCredentialRows(db, engagementId),
    listSessionRows(db, engagementId),
    listObservationsForGraph(db, engagementId),
  ])
  const nowMs = now().getTime()
  const activeCredentialRefs = new Set(credentials.filter((c) => c.status === 'active').map((c) => c.ref))
  // observation count per identity, from each contribution's (secret-free) identityRef stamp.
  const observedByIdentity = new Map<string, number>()
  for (const o of observations) {
    const refs = new Set<string>()
    for (const c of o.contributions) if (c.identityRef) refs.add(c.identityRef)
    for (const ref of refs) observedByIdentity.set(ref, (observedByIdentity.get(ref) ?? 0) + 1)
  }
  return identities.map((identity) => {
    const spec = identity.spec as Record<string, unknown>
    const credentialRef = typeof spec.credentialRef === 'string' && spec.credentialRef.trim() ? spec.credentialRef.trim() : null
    const authMethod = typeof spec.authMethod === 'string' ? spec.authMethod : 'unknown'
    const forIdentity = sessions.filter((s) => s.identityRef === identity.ref)
    const established = forIdentity.some((s) => s.status !== 'pending')
    const active = forIdentity.find((s) => s.status === 'active' && (!s.expiresAt || s.expiresAt.getTime() > nowMs))
    return {
      ref: identity.ref,
      label: identity.label,
      authMethod,
      credentialConfigured: credentialRef !== null,
      credentialAvailable: credentialRef !== null && activeCredentialRefs.has(credentialRef),
      sessionEstablished: established,
      sessionActive: !!active,
      sessionValidated: !!active, // a session reaches `active` only after authentication/validation succeeded
      observationsUnderIdentity: observedByIdentity.get(identity.ref) ?? 0,
      sessionStatus: active?.status ?? forIdentity[0]?.status ?? null,
      sessionExpiresAt: active?.expiresAt ? active.expiresAt.toISOString() : null,
    }
  })
}
