import { z } from 'zod'
import type { SensorResult } from '@audivra/contracts'
import type { ScopedResponse } from '../http-client.ts'
import type { SecurityCapability } from './types.ts'

/*
 * Phase 5 Step 4 — the two reviewed identity-aware capabilities the differential-comparison engine runs. They
 * are NOT arbitrary HTTP: each takes one in-scope URL (scope-checked by the broker) and a fixed method class,
 * runs under an established session (the trusted runtime injects the material same-origin; the input never
 * carries a secret), and records a bounded, normalized capture of the response the identity saw. The read
 * probe is passive/read-only; the action probe is state-changing/reversible-write and is therefore gated by
 * policy + environment (only an isolated lab allows it by default) and by the engagement's authorization.
 *
 *   access.identity-read    GET/HEAD one resource as an identity → structured response capture (evidence)
 *   access.identity-action  a state-changing request as an identity → structured response capture (evidence)
 *
 * The capture — status, a bounded response-header subset, a bounded body sample + its full hash — is stored
 * as `network-request` evidence under `metadata.probe`; the comparison engine normalizes and compares it.
 * Request headers (which carry the injected session) are NEVER stored.
 */

const BODY_SAMPLE_BYTES = 8192

/** A bounded, secret-free capture of what one identity saw. Request headers (the session) are not included. */
export interface ProbeCapture {
  method: string
  status: number
  finalUrl: string
  contentType: string | null
  contentLength: number | null
  redirectLocation: string | null
  bodyBytes: number
  bodySha256: string | null
  bodySample: string
  authenticated: boolean
  identityRef: string | null
  sessionRef: string | null
}

const headerStr = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

function capture(response: ScopedResponse, method: string, authenticated: boolean, identityRef: string | null, sessionRef: string | null): ProbeCapture {
  const contentLength = headerStr(response.headers['content-length'])
  return {
    method,
    status: response.status,
    finalUrl: response.finalUrl,
    contentType: headerStr(response.headers['content-type']),
    contentLength: contentLength !== null ? Number(contentLength) : null,
    redirectLocation: headerStr(response.headers.location),
    bodyBytes: response.bodyBytes,
    bodySha256: response.bodySha256,
    // Bounded sample for field/object extraction; the full body is never stored.
    bodySample: (response.body ?? '').slice(0, BODY_SAMPLE_BYTES),
    authenticated,
    identityRef,
    sessionRef,
  }
}

const ReadInput = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  method: z.enum(['GET', 'HEAD']).default('GET'),
})
type ReadInput = z.infer<typeof ReadInput>

export const identityReadCapability: SecurityCapability<ReadInput, SensorResult> = {
  metadata: {
    id: 'access.identity-read',
    version: 1,
    family: 'discovery',
    name: 'Read a resource as an identity',
    description: 'Requests one in-scope resource URL as a given identity (or anonymously) and records a bounded, normalized capture of the response for differential-authorization comparison. Read-only.',
    riskClass: 'passive',
    sideEffect: 'read-only',
    supportedEnvironments: ['production', 'staging', 'isolated-lab'],
    requiresAuthorization: true,
    requiresIdentity: false,
    requiresNetwork: true,
    requiresExternalIntegration: false,
    supportsCancellation: true,
    rateLimitClass: 'light',
    resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: false },
    timeoutProfile: { defaultSeconds: 20, maxSeconds: 60 },
    evidenceTypes: ['network-request'],
    implementation: 'builtin/identity-read@1',
    sensor: { tool: 'identity-read', observationTypes: ['http-response'], requiredInputs: ['url'], costClass: 'low', typicalDurationSeconds: 3 },
    identity: { supportsIdentity: true, requiresIdentity: false, supportsAnonymous: true, requiresSession: false },
  },
  implementation: {
    id: 'builtin/identity-read@1',
    input: ReadInput,
    targets: (input) => [input.url],
    async execute(context, input, handles) {
      const response = await handles.http.request({ url: input.url, method: input.method, followRedirects: false, captureBody: BODY_SAMPLE_BYTES })
      const identity = context.identity?.identityRef ?? null
      const session = context.identity?.sessionRef ?? null
      const probe = capture(response, input.method, session !== null, identity, session)
      const evidence = await handles.evidence.record({
        type: 'network-request',
        title: `${input.method} ${input.url} → ${response.status}${identity ? ` as ${identity}` : ' (anonymous)'}`.slice(0, 200),
        summary: `Read ${input.url} → HTTP ${response.status}, ${response.bodyBytes} bytes${identity ? ` as identity ${identity}` : ' anonymously'}.`,
        url: response.finalUrl,
        metadata: { probe },
      })
      await handles.observations.record({
        type: 'http-response',
        asset: input.url,
        subject: 'access',
        title: `HTTP ${response.status}${identity ? ` as ${identity}` : ''}`,
        value: { status: response.status, method: input.method, authenticated: session !== null },
        evidenceRef: evidence.ref,
        confidence: 1,
      })
      const summary = `${input.method} ${input.url} → ${response.status}${identity ? ` as ${identity}` : ' (anonymous)'}`
      return { output: { state: 'success', tool: 'identity-read', toolVersion: 'builtin/identity-read@1', observations: 1, summary, reason: null }, summary }
    },
  },
}

const ActionInput = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  body: z.string().max(16_384).optional(),
  contentType: z.string().max(128).optional(),
})
type ActionInput = z.infer<typeof ActionInput>

export const identityActionCapability: SecurityCapability<ActionInput, SensorResult> = {
  metadata: {
    id: 'access.identity-action',
    version: 1,
    family: 'discovery',
    name: 'Perform a state-changing action as an identity',
    description:
      'Performs one in-scope state-changing request (POST/PUT/PATCH/DELETE) as a given identity and records a bounded capture of the response, for business-state and authorization comparisons. State-changing and reversible-write: permitted only where the environment policy allows it (an isolated lab by default), and only against authorized, in-scope targets.',
    riskClass: 'state-changing',
    sideEffect: 'reversible-write',
    supportedEnvironments: ['staging', 'isolated-lab'],
    requiresAuthorization: true,
    requiresIdentity: false,
    requiresNetwork: true,
    requiresExternalIntegration: false,
    supportsCancellation: true,
    rateLimitClass: 'light',
    resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: false },
    timeoutProfile: { defaultSeconds: 20, maxSeconds: 60 },
    evidenceTypes: ['network-request'],
    implementation: 'builtin/identity-action@1',
    sensor: { tool: 'identity-action', observationTypes: ['http-response'], requiredInputs: ['url'], costClass: 'low', typicalDurationSeconds: 3 },
    identity: { supportsIdentity: true, requiresIdentity: false, supportsAnonymous: true, requiresSession: false },
  },
  implementation: {
    id: 'builtin/identity-action@1',
    input: ActionInput,
    targets: (input) => [input.url],
    async execute(context, input, handles) {
      const response = await handles.http.request({ url: input.url, method: input.method, followRedirects: false, captureBody: BODY_SAMPLE_BYTES, ...(input.body !== undefined ? { body: input.body, contentType: input.contentType ?? 'application/json' } : {}) })
      const identity = context.identity?.identityRef ?? null
      const session = context.identity?.sessionRef ?? null
      const probe = capture(response, input.method, session !== null, identity, session)
      const evidence = await handles.evidence.record({
        type: 'network-request',
        title: `${input.method} ${input.url} → ${response.status}${identity ? ` as ${identity}` : ' (anonymous)'}`.slice(0, 200),
        summary: `${input.method} ${input.url} → HTTP ${response.status}${identity ? ` as identity ${identity}` : ' anonymously'}.`,
        url: response.finalUrl,
        metadata: { probe },
      })
      await handles.observations.record({
        type: 'http-response',
        asset: input.url,
        subject: `action:${input.method}`,
        title: `${input.method} → HTTP ${response.status}${identity ? ` as ${identity}` : ''}`,
        value: { status: response.status, method: input.method, authenticated: session !== null, mutating: true },
        evidenceRef: evidence.ref,
        confidence: 1,
      })
      const summary = `${input.method} ${input.url} → ${response.status}${identity ? ` as ${identity}` : ' (anonymous)'}`
      return { output: { state: 'success', tool: 'identity-action', toolVersion: 'builtin/identity-action@1', observations: 1, summary, reason: null }, summary }
    },
  },
}
