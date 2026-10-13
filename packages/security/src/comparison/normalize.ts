import { createHash } from 'node:crypto'
import type { ComparisonArmRole, ComparisonObservation, ResponseClass, SemanticDifference } from '@audivra/contracts'
import type { ProbeCapture } from '../capabilities/comparison-probe.ts'

/*
 * Phase 5 Step 4 — response normalization and semantic comparison. A raw probe capture (status, headers, a
 * bounded body sample) becomes a bounded `ComparisonObservation`: a semantic response class, the returned
 * object/fields, a content hash computed AFTER stripping volatile noise (timestamps, ids, tokens, CSRF),
 * whether state changed and whether it bounced to login. Comparing two observations yields the semantic
 * differences, each flagged for whether it matters to authorization/business correctness. Original evidence
 * is always kept (the engine stores the evidence refs); normalization never erases a security-relevant
 * difference — it only removes incidental churn so equal responses hash equal.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Patterns for values that change between otherwise-identical responses and would defeat content equality. */
const VOLATILE_PATTERNS: [RegExp, string][] = [
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>'], // UUIDs
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<timestamp>'], // ISO timestamps
  [/\b\d{10,13}\b/g, '<epoch>'], // epoch seconds/millis
  [/"(?:csrf|_token|csrfToken|nonce|requestId|request_id|traceId|trace_id|etag)"\s*:\s*"[^"]*"/gi, '"<volatile>"'], // volatile JSON fields
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<jwt>'], // JWT-shaped tokens
]

/** Removes volatile noise so two semantically-equal responses hash equal. Keeps everything else verbatim. */
export function normalizeBody(body: string): string {
  let out = body.trim()
  for (const [pattern, replacement] of VOLATILE_PATTERNS) out = out.replace(pattern, replacement)
  return out.replace(/\s+/g, ' ')
}

function parseJson(sample: string): Record<string, unknown> | unknown[] | null {
  try {
    const value = JSON.parse(sample)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** Fields and the object id a JSON response concerns (bounded, deterministic). */
function bodyShape(sample: string): { fields: string[]; objectRef: string | null; businessResult: string | null } {
  const value = parseJson(sample)
  if (!value) return { fields: [], objectRef: null, businessResult: null }
  const record = Array.isArray(value) ? (value[0] && typeof value[0] === 'object' ? (value[0] as Record<string, unknown>) : {}) : value
  const fields = Object.keys(record).slice(0, 40).sort()
  const idKey = ['id', 'uuid', 'ref', 'key', 'slug'].find((k) => typeof record[k] === 'string' || typeof record[k] === 'number')
  const stateKey = ['state', 'status', 'result', 'stage', 'phase'].find((k) => typeof record[k] === 'string')
  return {
    fields,
    objectRef: idKey ? String(record[idKey]).slice(0, 120) : null,
    businessResult: stateKey ? String(record[stateKey]).slice(0, 120) : null,
  }
}

export function responseClassOf(status: number, redirectLocation: string | null, bodyBytes: number): ResponseClass {
  if (status === 401) return 'auth-required'
  if (status === 403) return 'denied'
  if (status === 404) return 'not-found'
  if (status >= 300 && status < 400) return redirectLocation && /login|signin|sign-in|auth|account\/login/i.test(redirectLocation) ? 'redirect-login' : 'other'
  if (status >= 500) return 'error'
  if (status >= 200 && status < 300) return bodyBytes === 0 ? 'empty' : 'success'
  return 'other'
}

/** Turns one probe capture into a bounded, normalized observation. */
export function normalizeProbe(probe: ProbeCapture, executionId: string | null, evidenceRefs: string[]): ComparisonObservation {
  const responseClass = responseClassOf(probe.status, probe.redirectLocation, probe.bodyBytes)
  const shape = bodyShape(probe.bodySample)
  const normalizedHash = probe.bodySample ? createHash('sha256').update(normalizeBody(probe.bodySample)).digest('hex').slice(0, 32) : probe.bodySha256
  const mutated = !SAFE_METHODS.has(probe.method) && probe.status >= 200 && probe.status < 300
  return {
    executionId,
    status: probe.status,
    responseClass,
    bodyBytes: probe.bodyBytes,
    normalizedHash,
    fields: shape.fields,
    returnedFields: shape.fields.length,
    objectRef: shape.objectRef,
    stateMutation: mutated,
    redirectToLogin: responseClass === 'redirect-login' || responseClass === 'auth-required',
    businessResult: shape.businessResult,
    authenticatedAs: probe.authenticated ? (probe.identityRef ?? 'authenticated') : null,
    evidenceRefs,
  }
}

/** Did the identity obtain the protected resource/effect (vs. being denied / bounced)? */
export function grantedAccess(o: ComparisonObservation): boolean {
  return o.responseClass === 'success' || (o.stateMutation && o.responseClass !== 'denied' && o.responseClass !== 'auth-required')
}

/** Normalized semantic differences between two arms (each flagged for security relevance). */
export function diffObservations(a: ComparisonObservation, b: ComparisonObservation, roles: [ComparisonArmRole, ComparisonArmRole]): SemanticDifference[] {
  const diffs: SemanticDifference[] = []
  const add = (aspect: SemanticDifference['aspect'], av: unknown, bv: unknown, securityRelevant: boolean, detail: string) => diffs.push({ aspect, between: roles, a: av, b: bv, securityRelevant, detail })

  if (a.responseClass !== b.responseClass) {
    const accessDiff = grantedAccess(a) !== grantedAccess(b)
    add('response-class', a.responseClass, b.responseClass, accessDiff, `${roles[0]} saw ${a.responseClass}; ${roles[1]} saw ${b.responseClass}`)
  } else if (a.status !== b.status) {
    add('status', a.status, b.status, false, `Different status with the same response class (${a.status} vs ${b.status})`)
  }
  // Both reached the resource but got different objects/content — a possible object/field boundary issue.
  if (grantedAccess(a) && grantedAccess(b)) {
    if (a.objectRef !== b.objectRef && (a.objectRef || b.objectRef)) add('object', a.objectRef, b.objectRef, true, `Different object returned (${a.objectRef ?? 'none'} vs ${b.objectRef ?? 'none'})`)
    if (a.normalizedHash !== b.normalizedHash) add('content', a.normalizedHash, b.normalizedHash, a.objectRef === b.objectRef, 'Response content differs after normalization')
    const extra = a.fields.filter((f) => !b.fields.includes(f))
    const missing = b.fields.filter((f) => !a.fields.includes(f))
    if (extra.length || missing.length) add('fields', a.fields, b.fields, extra.length > 0 || missing.length > 0, `Different fields returned (${roles[0]} extra: ${extra.join(',') || 'none'}; ${roles[1]} extra: ${missing.join(',') || 'none'})`)
    if ((a.businessResult ?? null) !== (b.businessResult ?? null)) add('business-result', a.businessResult, b.businessResult, true, `Different business result (${a.businessResult ?? 'none'} vs ${b.businessResult ?? 'none'})`)
  }
  if (a.stateMutation !== b.stateMutation) add('state', a.stateMutation, b.stateMutation, true, `${roles[0]} ${a.stateMutation ? 'changed' : 'did not change'} state; ${roles[1]} ${b.stateMutation ? 'changed' : 'did not change'} state`)
  if (a.redirectToLogin !== b.redirectToLogin) add('redirect', a.redirectToLogin, b.redirectToLogin, false, 'One arm was bounced to login and the other was not')
  if ((a.authenticatedAs ?? null) !== (b.authenticatedAs ?? null)) add('authenticated-identity', a.authenticatedAs, b.authenticatedAs, false, `Authenticated as ${a.authenticatedAs ?? 'anonymous'} vs ${b.authenticatedAs ?? 'anonymous'}`)
  return diffs
}

/** Reads a probe capture out of a comparison capability's evidence metadata. */
export function probeFromEvidence(metadata: Record<string, unknown>): ProbeCapture | null {
  const probe = metadata.probe
  if (!probe || typeof probe !== 'object') return null
  const p = probe as Record<string, unknown>
  if (typeof p.status !== 'number' || typeof p.method !== 'string') return null
  return {
    method: p.method,
    status: p.status,
    finalUrl: typeof p.finalUrl === 'string' ? p.finalUrl : '',
    contentType: typeof p.contentType === 'string' ? p.contentType : null,
    contentLength: typeof p.contentLength === 'number' ? p.contentLength : null,
    redirectLocation: typeof p.redirectLocation === 'string' ? p.redirectLocation : null,
    bodyBytes: typeof p.bodyBytes === 'number' ? p.bodyBytes : 0,
    bodySha256: typeof p.bodySha256 === 'string' ? p.bodySha256 : null,
    bodySample: typeof p.bodySample === 'string' ? p.bodySample : '',
    authenticated: p.authenticated === true,
    identityRef: typeof p.identityRef === 'string' ? p.identityRef : null,
    sessionRef: typeof p.sessionRef === 'string' ? p.sessionRef : null,
  }
}
