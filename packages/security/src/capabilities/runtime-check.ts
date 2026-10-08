import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { SecurityCapability } from './types.ts'

/*
 * diagnostic.runtime-check — a harmless, deterministic capability that proves the durable execution
 * runtime end to end without touching the target: it holds an owned child process (Node itself, idle,
 * no network, no files) for a few seconds, writes a small text artifact and returns structured
 * metadata. Its single "target" is the engagement's own URL, so the request is scope-checked like any
 * other, but nothing is ever sent to it (requiresNetwork: false).
 */

const Input = z.strictObject({
  target: z.string().trim().min(1).max(2048),
  /** How long the owned child process is held (Audivra's timeout still applies). */
  holdSeconds: z.number().int().min(0).max(900).default(2),
  note: z.string().trim().max(200).optional(),
})
type Input = z.infer<typeof Input>

export interface RuntimeCheckOutput {
  heldMs: number
  holdSeconds: number
  holderExitCode: number | null
  artifactPath: string
  evidenceRef: string
  platform: string
  node: string
}

export const runtimeCheckCapability: SecurityCapability<Input, RuntimeCheckOutput> = {
  metadata: {
    id: 'diagnostic.runtime-check',
    version: 1,
    family: 'diagnostic',
    name: 'Runtime check',
    description:
      'Proves the execution runtime without contacting the target: holds an owned, idle child process for a few seconds, writes a small text artifact and returns structured metadata.',
    riskClass: 'passive',
    sideEffect: 'read-only',
    supportedEnvironments: ['production', 'staging', 'isolated-lab'],
    requiresAuthorization: true,
    requiresIdentity: false,
    requiresNetwork: false,
    requiresExternalIntegration: false,
    supportsCancellation: true,
    rateLimitClass: 'none',
    resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: true },
    timeoutProfile: { defaultSeconds: 30, maxSeconds: 900 },
    evidenceTypes: ['tool-result'],
    implementation: 'builtin/runtime-check@1',
  },
  implementation: {
    id: 'builtin/runtime-check@1',
    input: Input,
    targets: (input) => [input.target],
    async execute(context, input, handles) {
      const started = Date.now()
      // The script is fixed; the only value in it is a validated integer.
      const hold = await handles.processes.run({ command: process.execPath, args: ['-e', `setTimeout(() => {}, ${input.holdSeconds * 1000})`], cwd: 'tmp' })
      if (hold.failed) throw new Error(`The owned holding process did not finish: ${hold.errorMessage ?? `exit ${hold.exitCode}`}`)
      const heldMs = Date.now() - started
      const file = path.join(handles.workspace.artifacts, 'runtime-check.txt')
      const lines = [
        'Audivra runtime check',
        `execution:   ${context.executionId}`,
        `capability:  ${context.capability.id} v${context.capability.version}`,
        `engagement:  ${context.engagementId} (configuration v${context.configVersion})`,
        `environment: ${context.environment}`,
        `scope:       v${context.scope.version} (${context.scope.hash.slice(0, 12)})`,
        `policy:      ${context.policy.profileKey} v${context.policy.profileVersion}`,
        `held:        ${heldMs} ms in an owned child process (exit ${hold.exitCode})`,
        input.note ? `note:        ${input.note}` : null,
        `runtime:     node ${process.version} on ${process.platform}`,
      ]
      await writeFile(file, `${lines.filter(Boolean).join('\n')}\n`, 'utf8')
      const artifactPath = handles.workspace.relative(file)
      const evidence = await handles.evidence.record({
        type: 'tool-result',
        title: 'Runtime check passed',
        summary: `The execution runtime held an owned child process for ${(heldMs / 1000).toFixed(1)} s and wrote a text artifact. The target was not contacted.`,
        artifactPath,
        metadata: { heldMs, holdSeconds: input.holdSeconds, holderExitCode: hold.exitCode },
      })
      return {
        output: { heldMs, holdSeconds: input.holdSeconds, holderExitCode: hold.exitCode, artifactPath, evidenceRef: evidence.ref, platform: process.platform, node: process.version },
        summary: `Runtime check passed: held an owned process for ${(heldMs / 1000).toFixed(1)} s and recorded ${evidence.ref}`,
      }
    },
  },
}
