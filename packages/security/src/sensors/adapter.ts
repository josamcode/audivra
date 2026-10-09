import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type {
  CapabilityFamily,
  EvidenceType,
  MutationClass,
  NetworkProfile,
  ObservationType,
  RiskClass,
  SecurityEnvironment,
  SensorResult,
  SensorResultState,
} from '@audivra/contracts'
import type { CapabilityHandles, CapabilityResult, ContainerRun, SecurityCapability, SecurityExecutionContext, ToolIo } from '../capabilities/types.ts'
import { findApprovedRuntime, runtimeImageRef } from '../execution/runtimes.ts'

export type { SecurityCapability } from '../capabilities/types.ts'

/*
 * The sensor adapter: the common shape for turning an approved external tool into an Audivra capability.
 *
 *   validated input ─► buildArgs (Audivra-built argv) ─► isolated runtime (approved tool image)
 *                   ─► structured native output ─► raw artifact (evidence) + normalized observations
 *
 * Audivra owns authorization, scope, execution, limits, parsing, evidence, provenance and the result
 * state; the tool is only a sensor. An adapter never takes user- or model-supplied CLI arguments, never
 * turns a tool signal into a finding, and always keeps the raw output as bounded evidence.
 */

/** What the adapter is handed on the host after the tool container has finished. */
export interface SensorNormalizeContext<I> {
  context: Readonly<SecurityExecutionContext>
  input: I
  run: ContainerRun
  handles: CapabilityHandles
  /** The tool's primary output file, read (bounded) from the execution workspace; null if absent/empty. */
  raw: string | null
  /** Evidence ref (`EV-n`) of the registered raw output, to back the observations; null if none. */
  evidenceRef: string | null
}

export interface SensorNormalizeResult {
  /** Observations recorded by the adapter. */
  observations: number
  /** Overrides the default state derived from the container exit and output. */
  state?: SensorResultState
  reason?: string | null
  summary?: string
}

export interface SensorAdapter<I> {
  /** Stable capability id, e.g. `discovery.http-fingerprint`. */
  id: string
  version: number
  family: CapabilityFamily
  name: string
  description: string
  /** The approved tool runtime id (its image is pinned in `runtimes.ts`). */
  runtime: string
  /** The sensor's human tool name recorded in observation provenance (e.g. `httpx`). */
  tool: string
  network: NetworkProfile
  riskClass: RiskClass
  sideEffect: MutationClass
  supportedEnvironments: readonly SecurityEnvironment[]
  requiresAuthorization: boolean
  timeoutProfile: { defaultSeconds: number; maxSeconds: number }
  evidenceTypes: readonly EvidenceType[]
  observationTypes: readonly ObservationType[]
  input: z.ZodType<I>
  /** Inputs the sensor needs beyond a target (planning metadata), e.g. `schema`, `source`, `templates`. */
  requiredInputs?: ('url' | 'schema' | 'source' | 'templates')[]
  /** Rough runtime cost class (planning metadata). */
  costClass?: 'low' | 'medium' | 'high'
  /** Typical wall-clock seconds for a bounded run (planning metadata, not a limit). */
  typicalDurationSeconds?: number
  /** Absolute URLs the request targets (scope-checked by the broker before execution). */
  targets(input: I): string[]
  /** The tool's primary structured output file, written under the execution's `outputs/` area. */
  outputFile: string
  /** Max bytes of the raw output read for parsing (and kept as evidence). */
  maxRawBytes?: number
  /** Stage input files the tool reads (under the read-only `inputs/` area). */
  stage?(context: Readonly<SecurityExecutionContext>, input: I, into: { write(relative: string, content: string | Uint8Array): Promise<string> }): Promise<void>
  /** The exact argument vector for the tool, from validated input only. */
  buildArgs(context: Readonly<SecurityExecutionContext>, input: I, io: ToolIo): string[]
  /** Normalizes the tool output into observations (recorded through `handles.observations`). */
  normalize(ctx: SensorNormalizeContext<I>): Promise<SensorNormalizeResult>
}

/** The implementation id a sensor capability carries. */
const sensorImplementation = (adapter: SensorAdapter<unknown>) => `sensor/${adapter.id}@${adapter.version}`

/**
 * Builds a `SecurityCapability` from a sensor adapter: declares it as an isolated tool capability, wires
 * `toolArgs`/`stage`, and provides a `collect` that registers the raw output as evidence, runs the
 * adapter's normalization, and returns a structured `SensorResult`.
 */
export function defineSensor<I>(adapter: SensorAdapter<I>): SecurityCapability<I, SensorResult> {
  const runtime = findApprovedRuntime(adapter.runtime)
  if (!runtime || runtime.kind !== 'tool') throw new Error(`Sensor ${adapter.id} names ${adapter.runtime}, which is not an approved tool runtime`)
  const maxRaw = adapter.maxRawBytes ?? 4 * 1024 * 1024

  return {
    metadata: {
      id: adapter.id,
      version: adapter.version,
      family: adapter.family,
      name: adapter.name,
      description: adapter.description,
      riskClass: adapter.riskClass,
      sideEffect: adapter.sideEffect,
      supportedEnvironments: [...adapter.supportedEnvironments],
      requiresAuthorization: adapter.requiresAuthorization,
      requiresIdentity: false,
      requiresNetwork: adapter.network === 'scoped-egress',
      requiresExternalIntegration: false,
      supportsCancellation: true,
      rateLimitClass: adapter.network === 'scoped-egress' ? 'standard' : 'none',
      resourceProfile: { disk: 'large', containerImage: null, spawnsProcesses: false },
      timeoutProfile: adapter.timeoutProfile,
      evidenceTypes: [...adapter.evidenceTypes],
      implementation: sensorImplementation(adapter as SensorAdapter<unknown>),
      sensor: {
        tool: adapter.tool,
        observationTypes: [...adapter.observationTypes],
        requiredInputs: adapter.requiredInputs ?? (adapter.network === 'scoped-egress' ? ['url'] : []),
        costClass: adapter.costClass ?? 'medium',
        typicalDurationSeconds: adapter.typicalDurationSeconds ?? 60,
      },
      execution: { mode: 'isolated-container', runtime: adapter.runtime, network: adapter.network },
    },
    implementation: {
      id: sensorImplementation(adapter as SensorAdapter<unknown>),
      input: adapter.input,
      targets: adapter.targets,
      stage: adapter.stage,
      toolArgs: adapter.buildArgs,
      async collect(context, input, run, handles): Promise<CapabilityResult<SensorResult>> {
        const toolVersion = runtimeImageRef(runtime)
        // Register the tool's primary output as the raw evidence backing every observation.
        let raw: string | null = null
        let evidenceRef: string | null = null
        const file = path.join(handles.workspace.outputs, adapter.outputFile)
        try {
          const content = await readFile(file, 'utf8')
          raw = content.length > maxRaw ? content.slice(0, maxRaw) : content
          const artifactPath = handles.workspace.relative(file)
          if (artifactPath) {
            const ev = await handles.evidence.record({
              type: 'tool-result',
              title: `${adapter.tool} output`,
              summary: `Raw ${adapter.tool} output for ${adapter.id}.`,
              artifactPath,
              metadata: { tool: adapter.tool, bytes: content.length },
            })
            evidenceRef = ev.ref
          }
        } catch {
          // Missing or unreadable output: raw stays null and the sensor is classified as partial/failed.
        }

        const defaultState: SensorResultState = run.exitCode === 0 ? (raw && raw.trim() ? 'success' : 'partial') : 'failed'
        let result: SensorNormalizeResult = { observations: 0 }
        let normalizeError: string | null = null
        try {
          result = await adapter.normalize({ context, input, run, handles, raw, evidenceRef })
        } catch (error) {
          normalizeError = error instanceof Error ? error.message : String(error)
        }
        const state: SensorResultState = normalizeError ? 'partial' : (result.state ?? defaultState)
        const reason = normalizeError ? `Output could not be fully parsed: ${normalizeError}` : (result.reason ?? (state === 'success' ? null : `${adapter.tool} exited ${run.exitCode} with ${raw ? 'partial' : 'no'} output`))
        const summary = result.summary ?? `${adapter.tool}: ${result.observations} observation${result.observations === 1 ? '' : 's'}${state === 'success' ? '' : ` (${state})`}`
        return {
          output: { state, tool: adapter.tool, toolVersion, observations: result.observations, summary, reason },
          summary,
        }
      },
    },
  }
}

/** Safe parse of newline-delimited JSON (JSONL): yields each valid object, skips malformed lines. */
export function parseJsonl(text: string | null, max = 5000): Record<string, unknown>[] {
  if (!text) return []
  const out: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || out.length >= max) continue
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object') out.push(value as Record<string, unknown>)
    } catch {
      /* skip malformed line */
    }
  }
  return out
}
