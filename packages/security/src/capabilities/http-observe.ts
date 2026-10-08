import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { SecurityCapability } from './types.ts'

/*
 * discovery.http-observe — the Phase 1 pipeline capability. It requests one in-scope URL with a safe
 * method (as a browser would load it), follows redirects only where the scope engine allows each hop,
 * and records the status, headers and redirect chain. It sends nothing a normal page load would not.
 */

const Input = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  followRedirects: z.boolean().default(true),
})
type Input = z.infer<typeof Input>

export interface HttpObservation {
  requestedUrl: string
  finalUrl: string
  status: number
  redirects: { from: string; to: string; status: number }[]
  blockedRedirect: { location: string; rule: string; reason: string } | null
  headers: Record<string, string | string[]>
  bodyBytes: number
  bodySha256: string | null
}

export const httpObserveCapability: SecurityCapability<Input, HttpObservation> = {
  metadata: {
    id: 'discovery.http-observe',
    version: 1,
    family: 'discovery',
    name: 'Observe an in-scope URL',
    description:
      'Requests one in-scope URL with GET or HEAD and records the status, response headers and redirect chain. Each redirect is evaluated against scope before it is followed.',
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
    timeoutProfile: { defaultSeconds: 15, maxSeconds: 60 },
    evidenceTypes: ['http-header'],
    implementation: 'builtin/http-observe@1',
  },
  implementation: {
    id: 'builtin/http-observe@1',
    input: Input,
    targets: (input) => [input.url],
    async execute(context, input, handles) {
      const response = await handles.http.request({ url: input.url, method: input.method, followRedirects: input.followRedirects })
      const observation: HttpObservation = {
        requestedUrl: response.requestedUrl,
        finalUrl: response.finalUrl,
        status: response.status,
        redirects: response.redirects,
        blockedRedirect: response.blockedRedirect
          ? { location: response.blockedRedirect.location, rule: response.blockedRedirect.evaluation.rule, reason: response.blockedRedirect.evaluation.reason }
          : null,
        headers: response.headers,
        bodyBytes: response.bodyBytes,
        bodySha256: response.bodySha256,
      }
      await mkdir(handles.workspace.dir, { recursive: true })
      const file = path.join(handles.workspace.dir, 'http-observe.json')
      await writeFile(file, JSON.stringify({ observation, network: handles.http.attempts }, null, 2), 'utf8')
      const hops = response.redirects.length
      await handles.evidence.record({
        type: 'http-header',
        title: `HTTP ${response.status} from ${response.finalUrl}`.slice(0, 200),
        summary: [
          `${input.method} ${input.url} → ${response.status}${hops ? ` after ${hops} redirect${hops === 1 ? '' : 's'}` : ''}.`,
          observation.blockedRedirect ? `A redirect to ${observation.blockedRedirect.location} was not followed: ${observation.blockedRedirect.reason}.` : null,
          `${Object.keys(response.headers).length} response headers, ${response.bodyBytes} body bytes.`,
        ]
          .filter(Boolean)
          .join(' '),
        url: response.finalUrl,
        artifactPath: handles.workspace.relative(file),
        metadata: { status: response.status, redirects: response.redirects, blockedRedirect: observation.blockedRedirect, headers: response.headers },
      })
      return {
        output: observation,
        summary: `${input.method} ${context.allowedTargets[0] ?? input.url} returned ${response.status}${observation.blockedRedirect ? ' (out-of-scope redirect not followed)' : ''}`,
      }
    },
  },
}
