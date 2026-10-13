import { z } from 'zod'
import type { ObservationType, SensorResult } from '@audivra/contracts'
import { CapabilityRegistry } from '../capabilities/registry.ts'
import type { CapabilityHandles, SecurityCapability } from '../capabilities/types.ts'

/*
 * Deterministic fixture sensors for tests and the reasoning benchmark. They are ordinary capabilities —
 * registered, decided by the broker, run by the durable runtime, scope-checked by the scoped HTTP client —
 * but in-process and tiny, so the reasoning loop can be exercised end to end without Docker images. Each
 * plays a distinct "tool" so independent corroboration is meaningful:
 *
 *   discovery.fixture-inspect      probe-inspect      low cost    response, Server header, fingerprint
 *   discovery.fixture-fingerprint  probe-fingerprint  medium cost technology from Server / X-Powered-By
 *   discovery.fixture-deepscan     probe-deepscan     high cost   the same evidence, expensively (cost tests)
 *
 * They are never part of the shipped catalog.
 */

const Input = z.strictObject({ url: z.string().trim().min(1).max(2048) })
type Input = z.infer<typeof Input>

function header(headers: Record<string, string | string[]>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}

function fixtureSensor(spec: {
  id: string
  name: string
  tool: string
  costClass: 'low' | 'medium' | 'high'
  observationTypes: ObservationType[]
  record: (handles: CapabilityHandles, url: string, response: { status: number; headers: Record<string, string | string[]> }, evidenceRef: string) => Promise<number>
}): SecurityCapability<Input, SensorResult> {
  const implementation = `fixture/${spec.id}@1`
  return {
    metadata: {
      id: spec.id,
      version: 1,
      family: 'discovery',
      name: spec.name,
      description: `Deterministic test sensor (${spec.tool}): one safe GET of an in-scope URL through the scoped HTTP client.`,
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
      implementation,
      sensor: { tool: spec.tool, observationTypes: spec.observationTypes, requiredInputs: ['url'], costClass: spec.costClass, typicalDurationSeconds: 2 },
    },
    implementation: {
      id: implementation,
      input: Input,
      targets: (input) => [input.url],
      async execute(_context, input, handles) {
        const response = await handles.http.request({ url: input.url, method: 'GET', followRedirects: false })
        const evidence = await handles.evidence.record({ type: 'http-header', title: `${spec.tool}: HTTP ${response.status} from ${input.url}`.slice(0, 200), summary: `${spec.tool} response headers for ${input.url}`, url: input.url, metadata: { status: response.status, headers: response.headers } })
        const observations = await spec.record(handles, input.url, response, evidence.ref)
        const summary = `${spec.tool}: ${observations} observation${observations === 1 ? '' : 's'}`
        return { output: { state: 'success', tool: spec.tool, toolVersion: `${spec.tool}@fixture-1`, observations, summary, reason: null }, summary }
      },
    },
  }
}

export const fixtureInspectSensor = fixtureSensor({
  id: 'discovery.fixture-inspect',
  name: 'Fixture inspection',
  tool: 'probe-inspect',
  costClass: 'low',
  observationTypes: ['http-response', 'http-header', 'technology'],
  async record(handles, url, response, evidenceRef) {
    let n = 0
    await handles.observations.record({ type: 'http-response', asset: url, subject: 'response', title: `HTTP ${response.status}`, value: { status: response.status, method: 'GET' }, evidenceRef, confidence: 1 })
    n++
    const server = header(response.headers, 'server')
    if (server) {
      await handles.observations.record({ type: 'http-header', asset: url, subject: 'server', title: `Server: ${server}`, value: { header: 'server', value: server }, evidenceRef, confidence: 1 })
      await handles.observations.record({ type: 'technology', asset: url, subject: server.split(/[/ ]/)[0]!, title: `Technology: ${server.split(/[/ ]/)[0]}`, sourceType: 'tool-inferred', value: { technology: server.replace('/', ':') }, evidenceRef, confidence: 0.9 })
      n += 2
    }
    return n
  },
})

export const fixtureFingerprintSensor = fixtureSensor({
  id: 'discovery.fixture-fingerprint',
  name: 'Fixture fingerprint',
  tool: 'probe-fingerprint',
  costClass: 'medium',
  observationTypes: ['technology'],
  async record(handles, url, response, evidenceRef) {
    let n = 0
    for (const value of [header(response.headers, 'server'), header(response.headers, 'x-powered-by')]) {
      if (!value) continue
      const name = value.split(/[/ ]/)[0]!
      await handles.observations.record({ type: 'technology', asset: url, subject: name, title: `Technology: ${name}`, sourceType: 'tool-inferred', value: { technology: value.replace('/', ':') }, evidenceRef, confidence: 0.85 })
      n++
    }
    return n
  },
})

export const fixtureDeepscanSensor = fixtureSensor({
  id: 'discovery.fixture-deepscan',
  name: 'Fixture deep scan (expensive)',
  tool: 'probe-deepscan',
  costClass: 'high',
  observationTypes: ['technology', 'http-response'],
  async record(handles, url, response, evidenceRef) {
    const server = header(response.headers, 'server')
    if (!server) return 0
    const name = server.split(/[/ ]/)[0]!
    await handles.observations.record({ type: 'technology', asset: url, subject: name, title: `Technology: ${name}`, sourceType: 'tool-inferred', value: { technology: server.replace('/', ':') }, evidenceRef, confidence: 0.85 })
    return 1
  },
})

/** A registry with only the fixture sensors (the planner then has nothing that needs Docker). */
export function createFixtureSensorRegistry(options: { deepscan?: boolean } = {}): CapabilityRegistry {
  const registry = new CapabilityRegistry().register(fixtureInspectSensor).register(fixtureFingerprintSensor)
  if (options.deepscan) registry.register(fixtureDeepscanSensor)
  return registry
}
