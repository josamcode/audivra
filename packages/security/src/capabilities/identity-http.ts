import { z } from 'zod'
import type { SensorResult } from '@audivra/contracts'
import type { SecurityCapability } from './types.ts'

/*
 * discovery.identity-http (Phase 5 Step 3) — an identity-aware HTTP observation. It requests one in-scope
 * URL exactly like `discovery.http-observe`, but it can run under an established session: the trusted runtime
 * injects the session's cookies/token into the scoped HTTP client (same-origin only) BEFORE the capability
 * runs, so the capability never sees — and its input never carries — any credential. Its observations and
 * evidence are automatically tagged with the identity/session they were captured under (by the handle
 * layer), which later authorization comparisons (Step 4) will rely on. It also runs anonymously, unchanged.
 */

const Input = z.strictObject({
  url: z.string().trim().min(1).max(2048),
})
type Input = z.infer<typeof Input>

const headerStr = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

export const identityHttpCapability: SecurityCapability<Input, SensorResult> = {
  metadata: {
    id: 'discovery.identity-http',
    version: 1,
    family: 'discovery',
    name: 'Identity-aware HTTP observation',
    description:
      'Requests one in-scope URL and records its status, headers and whether it looks authenticated. It can run under an established session (the runtime injects the session material; the capability input never carries a secret) or anonymously.',
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
    evidenceTypes: ['http-header'],
    implementation: 'builtin/identity-http@1',
    sensor: { tool: 'identity-http', observationTypes: ['http-response', 'http-header'], requiredInputs: ['url'], costClass: 'low', typicalDurationSeconds: 5 },
    // Identity-aware, but anonymous by default — existing anonymous behaviour is preserved.
    identity: { supportsIdentity: true, requiresIdentity: false, supportsAnonymous: true, requiresSession: false },
  },
  implementation: {
    id: 'builtin/identity-http@1',
    input: Input,
    targets: (input) => [input.url],
    async execute(context, input, handles) {
      const response = await handles.http.request({ url: input.url, method: 'GET', followRedirects: false })
      const identity = context.identity?.identityRef ?? null
      const session = context.identity?.sessionRef ?? null
      const server = headerStr(response.headers.server)
      const evidence = await handles.evidence.record({
        type: 'http-header',
        title: `HTTP ${response.status} from ${response.finalUrl}`.slice(0, 200),
        summary: `GET ${input.url} → ${response.status}${identity ? ` as identity ${identity}` : ' (anonymous)'}; ${Object.keys(response.headers).length} headers.`,
        url: response.finalUrl,
        metadata: { status: response.status, headers: response.headers, identityRef: identity, sessionRef: session },
      })
      // The observation's identity/session provenance is stamped by the handle layer from the trusted snapshot.
      await handles.observations.record({
        type: 'http-response',
        asset: input.url,
        subject: 'response',
        title: `HTTP ${response.status}${identity ? ` as ${identity}` : ''}`,
        value: { status: response.status, authenticated: session !== null, method: 'GET' },
        evidenceRef: evidence.ref,
        confidence: 1,
      })
      if (server) {
        await handles.observations.record({ type: 'http-header', asset: input.url, subject: 'server', title: `Server: ${server}`, value: { header: 'server', value: server }, evidenceRef: evidence.ref, confidence: 1 })
      }
      const summary = `GET ${input.url} → ${response.status}${identity ? ` as identity ${identity}` : ' (anonymous)'}`
      return { output: { state: 'success', tool: 'identity-http', toolVersion: 'builtin/identity-http@1', observations: server ? 2 : 1, summary, reason: null }, summary }
    },
  },
}
