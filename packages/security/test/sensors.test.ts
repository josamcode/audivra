import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ScopeManifest, type SecurityExecutionSnapshot } from '@audivra/contracts'
import { describe, expect, it } from 'vitest'
import {
  classifyDiscovered,
  createExecutionHandles,
  ExecutionWorkspace,
  httpxSensorCapability,
  katanaSensorCapability,
  normalizeAsset,
  normalizeSubject,
  observationDedupeKey,
  parseJsonl,
  semgrepSensorCapability,
} from '../src/index.ts'
import type { CapabilityHandles, ContainerRun, RecordObservationInput, SecurityExecutionContext } from '../src/capabilities/types.ts'
import { MemoryStore, snapshot as engagementSnapshot, verifiedLocal } from './memory-store.ts'

const PORT = 4711
const BASE = `http://127.0.0.1:${PORT}`
const manifest = ScopeManifest.parse({ hosts: [{ host: '127.0.0.1', ports: [PORT] }], protocols: ['http'] })
const context = { scope: { version: 1, hash: 'h', manifest } } as unknown as SecurityExecutionContext
const RUN: ContainerRun = { exitCode: 0, result: null, log: { bytes: 0, tail: '', path: null }, durationMs: 5 }

/** A handles stub that captures what a sensor's collect records, driven by a real output file on disk. */
function stubHandles() {
  const dir = mkdtempSync(path.join(tmpdir(), 'audivra-sensor-'))
  const observations: RecordObservationInput[] = []
  const evidence: { title: string }[] = []
  const handles = {
    workspace: {
      outputs: dir,
      relative: (p: string) => `executions/sx/outputs/${path.basename(p)}`,
    },
    evidence: {
      record: async (input: { title: string }) => {
        evidence.push(input)
        return { ref: `EV-${evidence.length}` }
      },
    },
    observations: {
      record: async (input: RecordObservationInput) => {
        observations.push(input)
        return { id: `obs_${observations.length}` }
      },
    },
  } as unknown as CapabilityHandles
  const write = (name: string, content: string) => writeFileSync(path.join(dir, name), content)
  return { handles, observations, evidence, write }
}

// ── Pure normalization helpers ─────────────────────────────────────────────────────────────────────────

describe('observation normalization', () => {
  it('normalizes assets for a stable key: lower-cased host, no fragment, no trailing root slash', () => {
    expect(normalizeAsset('HTTP://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000')
    expect(normalizeAsset('http://EXAMPLE.com/A/b#frag')).toBe('http://example.com/A/b')
    expect(normalizeAsset('  Nginx/1.25  ')).toBe('nginx/1.25')
  })

  it('normalizes subjects: collapsed whitespace, lower-cased, bounded', () => {
    expect(normalizeSubject('  React   Router ')).toBe('react router')
    expect(normalizeSubject('X'.repeat(2000)).length).toBe(1024)
  })

  it('builds a dedup key of type:asset:subject on normalized values', () => {
    expect(observationDedupeKey('technology', 'http://A/', 'React')).toBe('technology:http://a:react')
  })

  it('classifies a discovered destination against scope, never authorizing it', () => {
    expect(classifyDiscovered(manifest, `${BASE}/page`)).toBe('in-scope')
    expect(classifyDiscovered(manifest, 'http://evil.example.com/')).not.toBe('in-scope')
    expect(classifyDiscovered(manifest, 'not a url')).toBe('unknown')
  })
})

describe('parseJsonl', () => {
  it('keeps valid objects, skips malformed and blank lines, and honours the cap', () => {
    const text = '{"a":1}\n\nnot-json\n{"b":2}\n"string"\n3'
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseJsonl(null)).toEqual([])
    expect(parseJsonl('{"a":1}\n{"a":2}\n{"a":3}', 2)).toHaveLength(2)
  })
})

// ── httpx ────────────────────────────────────────────────────────────────────────────────────────────

describe('httpx sensor', () => {
  it('normalizes response, header, technology and (unfollowed) redirect observations with provenance', async () => {
    const { handles, observations, evidence, write } = stubHandles()
    write(
      'httpx.jsonl',
      [
        JSON.stringify({ url: BASE, input: BASE, status_code: 200, title: 'Home', webserver: 'nginx', content_type: 'text/html', content_length: 120, method: 'GET', scheme: 'http', tech: ['Nginx', 'React'] }),
        JSON.stringify({ url: `${BASE}/old`, status_code: 301, location: 'http://evil.example.com/', method: 'GET', scheme: 'http' }),
      ].join('\n'),
    )
    const result = await httpxSensorCapability.implementation.collect!(context, { url: BASE, techDetect: true, timeoutSeconds: 15 }, RUN, handles)

    expect(result.output.state).toBe('success')
    expect(result.output.tool).toBe('httpx')
    expect(result.output.toolVersion).toContain('@sha256:')
    expect(result.output.observations).toBe(6)
    expect(evidence[0]!.title).toBe('httpx output')

    const kinds = observations.map((o) => o.type)
    expect(kinds.filter((k) => k === 'http-response')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'technology')).toHaveLength(2)
    const react = observations.find((o) => o.type === 'technology' && o.subject === 'React')!
    expect(react).toMatchObject({ sourceType: 'tool-inferred', confidence: 0.9, evidenceRef: 'EV-1' })

    const redirect = observations.find((o) => o.type === 'redirect')!
    expect(redirect.value).toMatchObject({ followed: false, destination: 'http://evil.example.com/' })
    expect(redirect.scopeClass).not.toBe('in-scope')
  })

  it('reports partial when the tool produced no result rows', async () => {
    const { handles, write } = stubHandles()
    write('httpx.jsonl', '')
    const result = await httpxSensorCapability.implementation.collect!(context, { url: BASE, techDetect: true, timeoutSeconds: 15 }, RUN, handles)
    expect(result.output.state).toBe('partial')
    expect(result.output.observations).toBe(0)
  })

  it('reports partial and records nothing when the output file is missing', async () => {
    const { handles, observations } = stubHandles()
    const result = await httpxSensorCapability.implementation.collect!(context, { url: BASE, techDetect: true, timeoutSeconds: 15 }, RUN, handles)
    expect(result.output.state).toBe('partial')
    expect(observations).toHaveLength(0)
  })

  it('validates its input strictly and builds argv that routes only through the gateway', () => {
    expect(httpxSensorCapability.implementation.input.safeParse({}).success).toBe(false)
    expect(httpxSensorCapability.implementation.input.safeParse({ url: BASE, bogus: 1 }).success).toBe(false)
    const args = httpxSensorCapability.implementation.toolArgs!(context, { url: BASE, techDetect: true, timeoutSeconds: 15 }, { inputs: '/audivra/inputs', outputs: '/audivra/outputs', artifacts: '/audivra/artifacts', tmp: '/tmp', egressProxy: 'http://egress:3128' })
    expect(args).toContain('-json')
    expect(args).toContain('-td')
    expect(args.join(' ')).toContain('-proxy http://egress:3128')
    expect(args).not.toContain('-follow-redirects')
    expect(args).not.toContain('-fr')
  })
})

// ── katana ───────────────────────────────────────────────────────────────────────────────────────────

describe('katana sensor', () => {
  it('records in-scope and (uncontacted) out-of-scope endpoints, forms and technologies', async () => {
    const { handles, observations, write } = stubHandles()
    write(
      'katana.jsonl',
      [
        JSON.stringify({ request: { method: 'GET', endpoint: `${BASE}/`, tag: '', attribute: '', source: '' }, response: { status_code: 200, server: 'nginx', technologies: ['React'], forms: [{ method: 'POST', action: `${BASE}/login`, enctype: 'application/x-www-form-urlencoded', parameters: ['user', 'pass'] }] } }),
        JSON.stringify({ request: { method: 'GET', endpoint: `${BASE}/about`, tag: 'a', attribute: 'href', source: `${BASE}/` } }),
        JSON.stringify({ request: { method: 'GET', endpoint: 'http://evil.example.com/tracker.js', tag: 'script', attribute: 'src', source: `${BASE}/` } }),
      ].join('\n'),
    )
    const result = await katanaSensorCapability.implementation.collect!(context, { url: BASE, maxDepth: 2, durationSeconds: 20, concurrency: 2 }, RUN, handles)

    expect(result.output.state).toBe('success')
    expect(result.output.observations).toBe(5)

    const endpoints = observations.filter((o) => o.type === 'endpoint')
    expect(endpoints.filter((o) => o.scopeClass === 'in-scope')).toHaveLength(2)
    const external = endpoints.find((o) => o.asset === 'http://evil.example.com/tracker.js')!
    expect(external.scopeClass).not.toBe('in-scope')
    expect(external.value).toMatchObject({ contacted: false })

    const form = observations.find((o) => o.type === 'form')!
    expect(form.value).toMatchObject({ method: 'POST', parameters: ['user', 'pass'] })
  })
})

// ── semgrep ──────────────────────────────────────────────────────────────────────────────────────────

const SEMGREP_FIXTURE = JSON.stringify({
  results: [
    { check_id: 'audivra.js.eval-use', path: '/audivra/inputs/src/app.js', start: { line: 10 }, end: { line: 10 }, extra: { message: 'eval use', severity: 'WARNING' } },
    { check_id: 'audivra.secrets.hardcoded-credential', path: '/audivra/inputs/src/config.js', start: { line: 3 }, end: { line: 3 }, extra: { message: 'secret', severity: 'INFO' } },
    { check_id: 'audivra.js.child-process-exec', path: '/audivra/inputs/src/run.js', start: { line: 5 }, end: { line: 5 }, extra: { message: 'exec', severity: 'ERROR' } },
  ],
  errors: [],
})

describe('semgrep sensor', () => {
  const input = { files: [{ path: 'app.js', content: 'eval(x)' }], maxTargetBytes: 1_000_000 }

  it('treats exit 1 (findings present) as success and strips the staging prefix from asset paths', async () => {
    const { handles, observations, write } = stubHandles()
    write('semgrep.json', SEMGREP_FIXTURE)
    const result = await semgrepSensorCapability.implementation.collect!(context, input, { ...RUN, exitCode: 1 }, handles)

    expect(result.output.state).toBe('success')
    expect(result.output.observations).toBe(3)
    const evalFinding = observations.find((o) => o.subject === 'audivra.js.eval-use:10')!
    expect(evalFinding.asset).toBe('app.js')
    expect(evalFinding.type).toBe('source-finding')
    expect(evalFinding.confidence).toBe(0.5)
    expect(observations.find((o) => o.subject === 'audivra.js.child-process-exec:5')!.confidence).toBe(0.7)
  })

  it('treats exit 0 with no findings as success and exit >= 2 as a failed analysis', async () => {
    const empty = stubHandles()
    empty.write('semgrep.json', JSON.stringify({ results: [], errors: [] }))
    const ok = await semgrepSensorCapability.implementation.collect!(context, input, { ...RUN, exitCode: 0 }, empty.handles)
    expect(ok.output.state).toBe('success')
    expect(ok.output.observations).toBe(0)

    const errored = stubHandles()
    errored.write('semgrep.json', JSON.stringify({ results: [], errors: [{ message: 'boom' }] }))
    const failed = await semgrepSensorCapability.implementation.collect!(context, input, { ...RUN, exitCode: 2 }, errored.handles)
    expect(failed.output.state).toBe('failed')
    expect(failed.output.reason).toMatch(/analysis error/)
  })

  it('rejects unsafe staged paths and is a no-network capability', () => {
    expect(semgrepSensorCapability.implementation.input.safeParse({ files: [{ path: '../etc/passwd', content: 'x' }] }).success).toBe(false)
    expect(semgrepSensorCapability.implementation.input.safeParse({ files: [{ path: '/abs', content: 'x' }] }).success).toBe(false)
    expect(semgrepSensorCapability.implementation.input.safeParse({ files: [{ path: 'ok/app.js', content: 'x' }] }).success).toBe(true)
    expect(semgrepSensorCapability.metadata.requiresNetwork).toBe(false)
    expect(semgrepSensorCapability.metadata.execution?.network ?? 'none').toBe('none')
  })
})

// ── Dedup + provenance through the real handles → store path ────────────────────────────────────────────

describe('observation recorder (dedup, provenance, sensor-only)', () => {
  const ID = 'sx_0a1b2c3d4e5f67'
  const engagement = engagementSnapshot(PORT)
  const execSnapshot: SecurityExecutionSnapshot = {
    schemaVersion: 1,
    executionId: ID,
    correlationId: ID,
    engagement: { id: engagement.id, configVersion: engagement.configVersion, status: 'ready' },
    environment: 'staging',
    authorization: { required: true, state: 'valid', authorizationIds: [verifiedLocal(PORT).id] },
    scope: { version: 1, hash: engagement.scopeHash, manifest: engagement.scope },
    policy: { profileKey: 'standard', profileVersion: 1, risk: 'allowed', mutation: 'allowed' },
    capability: { id: 'discovery.http-inspect', version: 1, implementation: 'sensor/discovery.http-inspect@1', name: 'HTTP inspection', riskClass: 'passive', sideEffect: 'read-only', supportsCancellation: true, evidenceTypes: ['tool-result'] },
    limits: { maxRequests: 10, requestsPerSecond: 1, concurrency: 1, executionTimeoutSeconds: 30, maxResponseBytes: 2048, maxArtifactMb: 1 },
    runtime: { timeoutSeconds: 30, maxArtifactBytes: 1_048_576, maxProcesses: 4, cancelGraceSeconds: 5 },
    input: { url: BASE },
    allowedTargets: [BASE],
    actor: { kind: 'user', id: 'local-user', agentRunId: null },
    decision: { eventId: 7, rule: 'broker.allowed', evaluatedAt: new Date().toISOString() },
  }
  const build = (sensor: { tool: string; toolVersion: string } | null) => {
    const store = new MemoryStore(engagement, [verifiedLocal(PORT)])
    const workspace = new ExecutionWorkspace(mkdtempSync(path.join(tmpdir(), 'audivra-ws-')), ID)
    const { handles } = createExecutionHandles(execSnapshot, { workspace, signal: new AbortController().signal, resolver: async () => ['127.0.0.1'], store, sensor })
    return { store, handles }
  }

  it('merges the same fact from two contributions, keeping every provenance record and the highest confidence', async () => {
    const { store, handles } = build({ tool: 'httpx', toolVersion: 'projectdiscovery/httpx@sha256:abc' })
    await handles.observations.record({ type: 'technology', asset: `${BASE}/`, subject: 'React', title: 'Technology: React', evidenceRef: 'EV-1', confidence: 0.9 })
    await handles.observations.record({ type: 'technology', asset: BASE, subject: 'react', title: 'Technology: React', evidenceRef: 'EV-2', confidence: 1 })

    expect(store.observations).toHaveLength(1)
    const obs = store.observations[0]!
    expect(obs.dedupeKey).toBe(observationDedupeKey('technology', BASE, 'React'))
    expect(obs.contributions).toHaveLength(2)
    expect([...obs.evidenceRefs].sort()).toEqual(['EV-1', 'EV-2'])
    expect(obs.confidence).toBe(1)
    expect(obs.contributions[0]).toMatchObject({ executionId: ID, capabilityId: 'discovery.http-inspect', tool: 'httpx', toolVersion: 'projectdiscovery/httpx@sha256:abc', evidenceRef: 'EV-1' })
  })

  it('refuses to record an observation for a non-sensor capability', async () => {
    const { handles } = build(null)
    await expect(handles.observations.record({ type: 'technology', asset: BASE, subject: 'React', title: 'x' })).rejects.toThrow(/only be recorded by a sensor/)
  })
})
