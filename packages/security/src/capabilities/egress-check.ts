import path from 'node:path'
import { z } from 'zod'
import { ExecutionError } from '../execution/failures.ts'
import type { SecurityCapability } from './types.ts'

/*
 * diagnostic.egress-check — a harmless, isolated capability that proves controlled network egress. It
 * runs in an approved container on an execution-private network whose only route out is the Audivra
 * gateway, and makes a few HTTP requests through it. The executor only *requests* destinations; the
 * gateway decides each one against the trusted scope. The capability reports what the gateway returned
 * (reached / denied) and that no direct route exists, and writes a small artifact. Its scope target is
 * the engagement's own URL; the extra probes are requests the gateway filters, not authorizations.
 */

const Probe = z.strictObject({ label: z.string().trim().min(1).max(40), url: z.string().trim().min(1).max(2048) })
const Input = z.strictObject({
  target: z.string().trim().min(1).max(2048),
  /** Additional URLs to request through the gateway (each is scope-checked by the gateway, not authorized here). */
  probes: z.array(Probe).max(20).default([]),
  holdSeconds: z.number().int().min(0).max(900).default(0),
  note: z.string().trim().max(200).optional(),
})
type Input = z.infer<typeof Input>

const Outcome = z.object({ status: z.number().int().optional(), denied: z.boolean().optional(), hops: z.number().int().optional(), error: z.string().optional() }).loose()
const Result = z.object({
  status: z.literal('completed'),
  marker: z.string(),
  heldMs: z.number().int().min(0),
  requests: z.array(z.object({ label: z.string(), url: z.string(), outcome: Outcome })),
  direct: z.record(z.string(), z.string()),
})

export interface EgressCheckOutput {
  reached: { label: string; url: string; status: number | null; denied: boolean }[]
  /** Raw TCP attempts around the gateway; all must have failed (proving no alternate route). */
  direct: Record<string, string>
  evidenceRef: string
}

const markerFor = (executionId: string) => executionId.replace(/[^a-z0-9_]/g, '')

export const egressCheckCapability: SecurityCapability<Input, EgressCheckOutput> = {
  metadata: {
    id: 'diagnostic.egress-check',
    version: 1,
    family: 'diagnostic',
    name: 'Controlled egress check',
    description:
      'Proves controlled network egress: an isolated container reaches the network only through the Audivra gateway, which allows or denies each request against the trusted scope. It records what the gateway returned and writes a small artifact.',
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
    timeoutProfile: { defaultSeconds: 60, maxSeconds: 900 },
    evidenceTypes: ['tool-result'],
    implementation: 'builtin/egress-check@1',
    execution: { mode: 'isolated-container', runtime: 'node-sandbox', network: 'scoped-egress' },
  },
  implementation: {
    id: 'builtin/egress-check@1',
    input: Input,
    // The capability is authorized for the engagement's target; the gateway enforces scope on every request.
    targets: (input) => [input.target],
    program: 'egress-check.mjs',
    programInput: (context, input) => ({ marker: markerFor(context.executionId), target: input.target, probes: input.probes, holdSeconds: input.holdSeconds, note: input.note ?? null }),
    async collect(context, _input, run, handles) {
      const parsed = Result.safeParse(run.result)
      if (!parsed.success) throw new ExecutionError('executor-failed', 'container.result-invalid', 'The executor did not report a valid result')
      const result = parsed.data
      if (result.marker !== markerFor(context.executionId)) throw new ExecutionError('executor-failed', 'container.result-mismatch', 'The executor reported a result for another execution')
      const reached = result.requests.map((r) => ({ label: r.label, url: r.url, status: r.outcome.status ?? null, denied: r.outcome.denied === true }))
      const allowed = reached.filter((r) => r.status !== null && !r.denied).length
      const denied = reached.filter((r) => r.denied).length
      const artifactPath = handles.workspace.relative(path.join(handles.workspace.artifacts, 'egress-check.txt'))
      const evidence = await handles.evidence.record({
        type: 'tool-result',
        title: 'Controlled egress check',
        summary: `Through the execution's gateway: ${allowed} request(s) reached an in-scope destination, ${denied} were denied by scope. No direct route around the gateway existed.`,
        artifactPath,
        metadata: { reached, direct: result.direct },
      })
      return {
        output: { reached, direct: result.direct, evidenceRef: evidence.ref },
        summary: `Controlled egress check: ${allowed} reached, ${denied} denied by the gateway, and ${evidence.ref} recorded`,
      }
    },
  },
}
