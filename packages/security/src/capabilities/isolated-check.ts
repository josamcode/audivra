import path from 'node:path'
import { z } from 'zod'
import { ExecutionError } from '../execution/failures.ts'
import type { SecurityCapability } from './types.ts'

/*
 * diagnostic.isolated-check — a harmless, deterministic capability that proves the isolated container
 * backend end to end without touching the target: the reviewed executor `isolated-check.mjs` runs in the
 * approved node-sandbox runtime, reports what the sandbox looks like from the inside, holds for a few
 * seconds and writes a small artifact. Evidence is registered afterwards on the host, by `collect`, only
 * after the container's result has been validated. Its single "target" is the engagement's own URL, so
 * the request is scope-checked like any other, but nothing is ever sent to it (no network at all).
 */

const Input = z.strictObject({
  target: z.string().trim().min(1).max(2048),
  /** How long the executor holds (Audivra's timeout still applies). */
  holdSeconds: z.number().int().min(0).max(900).default(2),
  note: z.string().trim().max(200).optional(),
})
type Input = z.infer<typeof Input>

const Sandbox = z.object({
  uid: z.number().int(),
  gid: z.number().int(),
  writable: z.object({ root: z.boolean(), inputs: z.boolean(), tmp: z.boolean(), outputs: z.boolean() }),
  dockerControl: z.array(z.string()).max(20),
  hostPaths: z.array(z.string()).max(20),
  mounts: z.array(z.string()).max(50),
  markers: z.array(z.string()).max(60),
  network: z.array(z.string()).max(20),
  cgroup: z.object({ memoryMax: z.string().nullable(), pidsMax: z.string().nullable(), cpuMax: z.string().nullable() }),
  capabilities: z.string().nullable(),
  noNewPrivileges: z.string().nullable(),
  node: z.string().max(40),
})
export type IsolatedSandboxReport = z.infer<typeof Sandbox>

const Result = z.object({ status: z.literal('completed'), marker: z.string(), heldMs: z.number().int().min(0), sandbox: Sandbox })

export interface IsolatedCheckOutput {
  heldMs: number
  sandbox: IsolatedSandboxReport
  artifactPath: string
  evidenceRef: string
  log: { bytes: number }
}

const markerFor = (executionId: string) => executionId.replace(/[^a-z0-9_]/g, '')

export const isolatedCheckCapability: SecurityCapability<Input, IsolatedCheckOutput> = {
  metadata: {
    id: 'diagnostic.isolated-check',
    version: 1,
    family: 'diagnostic',
    name: 'Isolated runtime check',
    description:
      'Proves the isolated container runtime without contacting the target: an approved container with no network and a read-only root holds for a few seconds, reports what it can see and writes a small artifact.',
    riskClass: 'passive',
    sideEffect: 'read-only',
    supportedEnvironments: ['production', 'staging', 'isolated-lab'],
    requiresAuthorization: true,
    requiresIdentity: false,
    requiresNetwork: false,
    requiresExternalIntegration: false,
    supportsCancellation: true,
    rateLimitClass: 'none',
    resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: false },
    timeoutProfile: { defaultSeconds: 30, maxSeconds: 900 },
    evidenceTypes: ['tool-result'],
    implementation: 'builtin/isolated-check@1',
    execution: { mode: 'isolated-container', runtime: 'node-sandbox' },
  },
  implementation: {
    id: 'builtin/isolated-check@1',
    input: Input,
    targets: (input) => [input.target],
    program: 'isolated-check.mjs',
    // The executor gets a marker, a duration and an optional note — nothing about authorization,
    // scope, policy or the engagement.
    programInput: (context, input) => ({ marker: markerFor(context.executionId), holdSeconds: input.holdSeconds, note: input.note ?? null }),
    async collect(context, _input, run, handles) {
      const parsed = Result.safeParse(run.result)
      if (!parsed.success) throw new ExecutionError('executor-failed', 'container.result-invalid', 'The executor did not report a valid result')
      const result = parsed.data
      if (result.marker !== markerFor(context.executionId)) throw new ExecutionError('executor-failed', 'container.result-mismatch', 'The executor reported a result for another execution')
      const artifactPath = handles.workspace.relative(path.join(handles.workspace.artifacts, 'isolated-check.txt'))
      const seconds = (result.heldMs / 1000).toFixed(1)
      const evidence = await handles.evidence.record({
        type: 'tool-result',
        title: 'Isolated runtime check passed',
        summary: `An approved container (no network, read-only root filesystem, user ${result.sandbox.uid}) held for ${seconds} s and wrote a text artifact. The target was not contacted.`,
        artifactPath,
        metadata: {
          heldMs: result.heldMs,
          user: `${result.sandbox.uid}:${result.sandbox.gid}`,
          network: result.sandbox.network,
          readOnlyRoot: !result.sandbox.writable.root,
          cgroup: result.sandbox.cgroup,
        },
      })
      return {
        output: { heldMs: result.heldMs, sandbox: result.sandbox, artifactPath, evidenceRef: evidence.ref, log: { bytes: run.log.bytes } },
        summary: `Isolated runtime check passed: an approved container held for ${seconds} s and recorded ${evidence.ref}`,
      }
    },
  },
}
