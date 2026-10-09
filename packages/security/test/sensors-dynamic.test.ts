import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CONFIDENCE_BY_SOURCE, observationFamily, ScopeManifest } from '@audivra/contracts'
import { describe, expect, it } from 'vitest'
import { DeterministicLocalOastProvider, nucleiSensorCapability, oastInteractionObservation, schemathesisSensorCapability } from '../src/index.ts'
import type { CapabilityHandles, ContainerRun, RecordObservationInput, SecurityExecutionContext } from '../src/capabilities/types.ts'

const PORT = 4733
const BASE = `http://127.0.0.1:${PORT}`
const manifest = ScopeManifest.parse({ hosts: [{ host: '127.0.0.1', ports: [PORT] }], protocols: ['http'] })
const context = { scope: { version: 1, hash: 'h', manifest } } as unknown as SecurityExecutionContext
const RUN: ContainerRun = { exitCode: 0, result: null, log: { bytes: 0, tail: '', path: null }, durationMs: 5 }

function stubHandles() {
  const dir = mkdtempSync(path.join(tmpdir(), 'audivra-dyn-'))
  const observations: RecordObservationInput[] = []
  const handles = {
    workspace: { outputs: dir, relative: (p: string) => `executions/sx/outputs/${path.basename(p)}` },
    evidence: { record: async () => ({ ref: 'EV-1' }) },
    observations: {
      record: async (input: RecordObservationInput) => {
        observations.push(input)
        return { id: `obs_${observations.length}` }
      },
    },
  } as unknown as CapabilityHandles
  return { handles, observations, write: (name: string, content: string) => writeFileSync(path.join(dir, name), content) }
}

// ── Schemathesis ─────────────────────────────────────────────────────────────────────────────────────

const SCH_REPORT = JSON.stringify({
  complete: true,
  exit_code: 1,
  valid_rates: { 'GET /ping': { fuzzing: {} }, 'GET /widgets/{id}': { fuzzing: {} } },
  failures: [{ type: 'JsonSchemaError', title: 'Response violates schema', severity: 'high', count: 1, operations: ['GET /widgets/{id}'] }],
  phases: { stateful: { status: 'skip' } },
  errors: [],
})

describe('schemathesis sensor', () => {
  const input = { schema: '{}', schemaFormat: 'json' as const, url: BASE, maxExamples: 10 }

  it('normalizes operations and contract divergences into API observations (exit 1 with failures = success)', async () => {
    const { handles, observations, write } = stubHandles()
    write('schemathesis.json', SCH_REPORT)
    const result = await schemathesisSensorCapability.implementation.collect!(context, input, { ...RUN, exitCode: 1 }, handles)

    expect(result.output.state).toBe('success')
    expect(result.output.tool).toBe('schemathesis')
    const operations = observations.filter((o) => o.type === 'api-operation')
    expect(operations.map((o) => o.subject).sort()).toEqual(['GET /ping', 'GET /widgets/{id}'])
    const validation = observations.find((o) => o.type === 'api-validation')!
    expect(validation.subject).toContain('JsonSchemaError')
    expect(validation.scopeClass).toBe('in-scope')
    // The tool's own severity is recorded but is NOT Audivra's severity; it stays a signal (api-validation).
    expect(validation.value).toMatchObject({ toolSeverity: 'high' })
    expect(validation.sourceType).toBe('tool-reported')
  })

  it('declares its planning metadata (required inputs, cost) and API families', () => {
    const sensor = schemathesisSensorCapability.metadata.sensor!
    expect(sensor.requiredInputs).toEqual(['schema', 'url'])
    expect(sensor.observationTypes.every((t) => observationFamily(t) === 'api')).toBe(true)
    expect(schemathesisSensorCapability.metadata.supportedEnvironments).not.toContain('production')
  })

  it('reports partial when no report was produced', async () => {
    const { handles } = stubHandles()
    const result = await schemathesisSensorCapability.implementation.collect!(context, input, RUN, handles)
    expect(result.output.state).toBe('partial')
  })
})

// ── Nuclei ───────────────────────────────────────────────────────────────────────────────────────────

describe('nuclei sensor', () => {
  const input = { url: BASE }

  it('normalizes template matches into web-signal observations as heuristics, scope-classified', async () => {
    const { handles, observations, write } = stubHandles()
    write(
      'nuclei.jsonl',
      [
        JSON.stringify({ 'template-id': 'audivra-missing-hsts', 'matched-at': `${BASE}/`, host: `127.0.0.1:${PORT}`, type: 'http', info: { name: 'Missing HSTS', severity: 'info' } }),
        JSON.stringify({ 'template-id': 'audivra-server-banner', 'matched-at': `${BASE}/`, info: { name: 'Server banner', severity: 'info' }, 'extracted-results': ['audivra-fixture'] }),
      ].join('\n'),
    )
    const result = await nucleiSensorCapability.implementation.collect!(context, input, RUN, handles)

    expect(result.output.state).toBe('success')
    expect(result.output.observations).toBe(2)
    const signals = observations.filter((o) => o.type === 'web-signal')
    expect(signals.every((o) => o.sourceType === 'tool-heuristic')).toBe(true)
    expect(signals.every((o) => o.confidence === CONFIDENCE_BY_SOURCE['tool-heuristic'])).toBe(true)
    expect(signals.every((o) => o.scopeClass === 'in-scope')).toBe(true)
    expect(signals.find((o) => o.subject === 'audivra-server-banner')!.value).toMatchObject({ extracted: ['audivra-fixture'] })
  })

  it('treats no matches (no output) as a clean success, not a failure, and is not allowed in production', async () => {
    const { handles, observations } = stubHandles()
    const result = await nucleiSensorCapability.implementation.collect!(context, input, RUN, handles)
    expect(result.output.state).toBe('success')
    expect(observations).toHaveLength(0)
    expect(nucleiSensorCapability.metadata.supportedEnvironments).toEqual(['staging', 'isolated-lab'])
  })
})

// ── OAST provider ────────────────────────────────────────────────────────────────────────────────────

describe('deterministic local OAST provider', () => {
  it('mints per-execution correlation ids, enforces ownership and expiry, and maps interactions to observations', async () => {
    let now = 1_000_000
    const provider = new DeterministicLocalOastProvider({ now: () => now })
    const handle = await provider.register('sx_exec0000001a', 60)
    expect(handle.payloadDomain).toContain('.oast.local')
    expect(await provider.poll('sx_exec0000001a', handle.correlationId)).toEqual([])

    // Another execution cannot poll this correlation id.
    await expect(provider.poll('sx_other00000002', handle.correlationId)).rejects.toThrow(/does not belong/)

    provider.inject(handle.correlationId, { protocol: 'dns', remoteAddress: '203.0.113.5', detail: 'A lookup' })
    const seen = await provider.poll('sx_exec0000001a', handle.correlationId)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ protocol: 'dns', remoteAddress: '203.0.113.5' })

    // After expiry, interactions are no longer returned.
    now += 61_000
    expect(await provider.poll('sx_exec0000001a', handle.correlationId)).toEqual([])

    const obs = oastInteractionObservation(seen[0]!, 'out-of-scope', 'EV-3')
    expect(obs).toMatchObject({ type: 'oast-interaction', scopeClass: 'out-of-scope', sourceType: 'tool-reported', evidenceRef: 'EV-3' })
    expect(obs.asset).toContain('oast://')
  })

  it('releases every correlation id an execution owns', async () => {
    const provider = new DeterministicLocalOastProvider()
    const a = await provider.register('sx_exec0000001a')
    await provider.release('sx_exec0000001a')
    expect(await provider.poll('sx_exec0000001a', a.correlationId)).toEqual([])
  })
})
