import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ScopeManifest, type ScopeManifestInput, type SecurityCapabilityMetadata } from '@audivra/contracts'
import {
  CapabilityBroker,
  CapabilityRegistry,
  createRuntimeRegistry,
  egressCheckCapability,
  egressNetworkName,
  gatewayCreateArgs,
  gatewayNameFor,
  internalNetworkName,
  IsolatedContainerBackend,
  isolationFor,
  networkCreateArgs,
  parseOwnedNetworks,
  runtimeImageRef,
  APPROVED_RUNTIMES,
  type BackendSpec,
  type DockerCli,
  type SecurityCapability,
} from '../src/index.ts'
import { contextFromSnapshot } from '../src/execution/snapshot.ts'
import { ExecutionWorkspace } from '../src/execution/workspace.ts'
import { MemoryStore, snapshot, verifiedLocal } from './memory-store.ts'
import { MemoryExecutionStore, MemoryQueue } from './memory-executions.ts'

/*
 * Phase 2C without Docker: the network profile recorded in the trusted snapshot, the gateway container
 * security profile, execution-scoped network naming/ownership, and the isolated backend's network
 * lifecycle against a scripted docker CLI. The real gateway and containment are proven by
 * apps/worker/test/security-egress.integration.test.ts.
 */

const PORT = 4995
const TARGET = `http://127.0.0.1:${PORT}/`
const root = mkdtempSync(path.join(os.tmpdir(), 'audivra-egress-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const okResources = async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} })
const RUNTIME = APPROVED_RUNTIMES[0]!

const BASE: SecurityCapabilityMetadata = {
  ...egressCheckCapability.metadata,
  id: 'test.egress',
  implementation: 'test/egress@1',
}
function networked(patch: Partial<SecurityCapabilityMetadata> = {}): SecurityCapability<{ target: string }> {
  return {
    metadata: { ...BASE, ...patch },
    implementation: {
      id: patch.implementation ?? BASE.implementation,
      input: z.strictObject({ target: z.string() }),
      targets: (i) => [i.target],
      program: 'egress-check.mjs',
      programInput: () => ({ hold: 0 }),
      collect: async () => ({ output: { ok: true }, summary: 'collected' }),
    },
  }
}

describe('network profile', () => {
  it('records scoped-egress in the trusted snapshot only for capabilities that declare it', () => {
    expect(isolationFor(egressCheckCapability.metadata)).toMatchObject({ mode: 'isolated-container', network: 'scoped-egress', runtime: { id: 'node-sandbox', image: runtimeImageRef(RUNTIME) } })
    // The same approved runtime; scoped-egress only changes the network.
    expect(isolationFor({ ...egressCheckCapability.metadata, execution: { mode: 'isolated-container', runtime: 'node-sandbox', network: 'none' }, requiresNetwork: false })).toMatchObject({ network: 'none' })
    expect(egressCheckCapability.metadata.requiresNetwork).toBe(true)
    // An agent is never told about runtimes, networks, images or gateways.
    expect(JSON.stringify(createRuntimeRegistry().describeForAgents())).not.toMatch(/node-sandbox|sha256|host\.docker|--network|docker\.sock|audivra-/i)
  })

  it('a request or its input cannot choose scoped egress or a network', async () => {
    const store = new MemoryStore(snapshot(PORT, { scopeInput: { hosts: [{ host: '127.0.0.1', ports: [PORT] }], protocols: ['http'] } }), [verifiedLocal(PORT)])
    const executions = new MemoryExecutionStore()
    const broker = new CapabilityBroker({ registry: new CapabilityRegistry().register(networked()), store, checkResources: okResources, workspaceRoot: () => root, executions: { store: executions, queue: new MemoryQueue(executions) } })
    const base = { engagementId: store.engagement.id, capabilityId: 'test.egress', actor: user }
    expect((await broker.submit({ ...base, input: { target: TARGET }, networkProfile: 'scoped-egress' })).decision.rule).toBe('request.invalid')
    expect((await broker.submit({ ...base, input: { target: TARGET, network: 'scoped-egress', allowedHosts: ['evil.test'] } })).decision.rule).toBe('input.invalid')
    const ok = await broker.submit({ ...base, input: { target: TARGET } })
    expect(ok.status).toBe('queued')
    expect(executions.rows.get(ok.executionId)!.snapshot.isolation).toMatchObject({ network: 'scoped-egress' })
  })
})

describe('gateway container security profile', () => {
  const spec = {
    name: gatewayNameFor('sx_0123456789abcd'),
    labels: { 'audivra.owner': 'security-execution', 'audivra.execution': 'sx_0123456789abcd', 'audivra.role': 'gateway' },
    image: runtimeImageRef(RUNTIME),
    command: ['node', '/audivra/gateway/main.mjs'],
    limits: RUNTIME.limits,
    user: '1000:1000',
    network: internalNetworkName('sx_0123456789abcd'),
    gatewayDir: 'D:\\w\\executions\\sx_0123456789abcd\\.gateway',
    hostGateway: 'host.docker.internal',
  }

  it('is non-root, read-only, capability-free, joins only the internal network as egress, and mounts only its own .gateway dir', () => {
    const args = gatewayCreateArgs(spec)
    const pairs = (flag: string) => args.flatMap((v, i) => (v === flag ? [args[i + 1]] : []))
    expect(pairs('--name')).toEqual([gatewayNameFor('sx_0123456789abcd')])
    expect(pairs('--network')).toEqual([internalNetworkName('sx_0123456789abcd')])
    expect(pairs('--network-alias')).toEqual(['egress'])
    expect(pairs('--cap-drop')).toEqual(['ALL'])
    expect(pairs('--security-opt')).toEqual(['no-new-privileges'])
    expect(pairs('--memory')).toEqual(['256m'])
    expect(pairs('--pids-limit')).toEqual(['64'])
    expect(args).toContain('--read-only')
    expect(args).toContain('--init')
    // Only the .gateway dir is mounted — never inputs/outputs/artifacts, the repo, host paths or the socket.
    expect(pairs('--mount')).toEqual([`type=bind,source=${spec.gatewayDir},target=/audivra/gateway`])
    expect(JSON.stringify(args)).not.toMatch(/docker\.sock|inputs|outputs|artifacts/i)
    // The gateway is given only its policy and log paths — never an Audivra credential.
    expect(pairs('--env').sort()).toEqual(['AUDIVRA_GATEWAY_LOG=/audivra/gateway/gateway.jsonl', 'AUDIVRA_GATEWAY_PORT=3128', 'AUDIVRA_GATEWAY_POLICY=/audivra/gateway/policy.json', 'AUDIVRA_HOST_GATEWAY=host.docker.internal'].sort())
    for (const forbidden of ['--privileged', '--cap-add', '-v', '--volume', '--pid', '--userns', '-p', '--publish']) expect(args, forbidden).not.toContain(forbidden)
    expect(() => gatewayCreateArgs({ ...spec, user: 'root' })).toThrow(/never run as root/)
  })

  it('creates an internal network with no external route and a private egress network', () => {
    const internal = networkCreateArgs(internalNetworkName('sx_x'.padEnd(17, '0')), true, { 'audivra.owner': 'security-execution' })
    expect(internal).toContain('--internal')
    expect(internal).toContain('bridge')
    const egress = networkCreateArgs(egressNetworkName('sx_x'.padEnd(17, '0')), false, {})
    expect(egress).not.toContain('--internal')
  })

  it('accepts only networks named exactly as derived from their execution label', () => {
    const listing = [
      `${internalNetworkName('sx_abcdefghijk123')}\tsx_abcdefghijk123\teng0000001\tnet-internal`,
      `${egressNetworkName('sx_abcdefghijk123')}\tsx_abcdefghijk123\teng0000001\tnet-egress`,
      `audivra-net-impostor\tsx_abcdefghijk124\teng0000001\tnet-internal`,
      'bridge\t\t\t',
    ].join('\n')
    expect(parseOwnedNetworks(listing)).toEqual([
      { executionId: 'sx_abcdefghijk123', engagementId: 'eng0000001', name: internalNetworkName('sx_abcdefghijk123'), kind: 'network', role: 'net-internal', state: 'present' },
      { executionId: 'sx_abcdefghijk123', engagementId: 'eng0000001', name: egressNetworkName('sx_abcdefghijk123'), kind: 'network', role: 'net-egress', state: 'present' },
    ])
  })
})

describe('isolated backend network lifecycle (scripted docker CLI)', () => {
  const executionId = 'sx_egressunit001a'
  const engagementId = 'eng0000001'
  const scope: ScopeManifestInput = { hosts: [{ host: '127.0.0.1', ports: [PORT] }], networks: { addresses: ['127.0.0.1'], cidrs: [] }, protocols: ['http'] }

  function scripted(responses: Partial<Record<string, (args: string[]) => { ok: boolean; stdout?: string; stderr?: string }>> = {}) {
    const calls: string[][] = []
    const docker: DockerCli = async (args) => {
      calls.push(args)
      const key = args[0] === 'network' ? `network ${args[1]}` : args[0]!
      const respond = responses[key] ?? ((): { ok: boolean; stdout?: string; stderr?: string } => ({ ok: true }))
      const r = respond(args)
      return { ok: r.ok, code: r.ok ? 0 : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }
    return { docker, calls, verbs: () => calls.map((c) => (c[0] === 'network' ? `network ${c[1]}` : c[0])) }
  }
  const ownLabels = JSON.stringify({ 'audivra.owner': 'security-execution', 'audivra.execution': executionId, 'audivra.engagement': engagementId })
  const absent = () => ({ ok: false, stderr: 'No such container' })

  async function makeSpec(): Promise<BackendSpec> {
    const manifest = ScopeManifest.parse(scope)
    const snap = {
      schemaVersion: 1 as const,
      executionId,
      correlationId: executionId,
      engagement: { id: engagementId, configVersion: 1, status: 'ready' as const },
      environment: 'staging' as const,
      authorization: { required: true, state: 'valid' as const, authorizationIds: [] },
      scope: { version: 1, hash: 'h', manifest },
      policy: { profileKey: 'standard', profileVersion: 1, risk: 'allowed' as const, mutation: 'allowed' as const },
      capability: { id: 'test.egress', version: 1, implementation: 'test/egress@1', name: 'Test egress', riskClass: 'passive' as const, sideEffect: 'read-only' as const, supportsCancellation: true, evidenceTypes: ['tool-result' as const] },
      limits: { maxRequests: 1000, requestsPerSecond: 50, concurrency: 4, executionTimeoutSeconds: 900, maxResponseBytes: 5_000_000, maxArtifactMb: 250 },
      runtime: { timeoutSeconds: 900, maxArtifactBytes: 250 * 1_048_576, maxProcesses: 0, cancelGraceSeconds: 5 },
      isolation: isolationFor(networked().metadata),
      input: { target: TARGET },
      allowedTargets: [TARGET],
      actor: user,
      decision: { eventId: 1, rule: 'broker.allowed', evaluatedAt: new Date().toISOString() },
    }
    const workspace = new ExecutionWorkspace(root, executionId)
    return {
      executionId,
      snapshot: snap,
      capability: new CapabilityRegistry().register(networked()).get('test.egress')!,
      context: contextFromSnapshot(snap),
      input: { target: TARGET },
      handles: {} as BackendSpec['handles'],
      workspace,
      stop: new AbortController(),
      events: async () => undefined,
    }
  }

  const backend = (docker: DockerCli) => new IsolatedContainerBackend({ docker, gatewayBundle: async () => path.join(root, 'bundle.mjs') })

  it('brings up the private networks and a ready gateway, stages the policy from the snapshot, then the executor', async () => {
    const spec = await makeSpec()
    await import('node:fs/promises').then((fs) => fs.writeFile(path.join(root, 'bundle.mjs'), '// gateway bundle'))
    const s = scripted({
      image: () => ({ ok: true, stdout: 'sha256:x' }),
      inspect: absent,
      'network inspect': () => ({ ok: false, stderr: 'No such network' }),
      logs: () => ({ ok: true, stdout: 'AUDIVRA_GATEWAY_READY 3128' }),
    })
    await backend(s.docker).prepare(spec)
    // Networks and gateway are created before the executor.
    const verbs = s.verbs()
    expect(verbs.filter((v) => v === 'network create')).toHaveLength(2)
    const gatewayCreate = s.calls.find((c) => c[0] === 'create' && c.includes('audivra-gateway'))
    expect(gatewayCreate, 'gateway container created').toBeTruthy()
    expect(verbs.indexOf('start')).toBeLessThan(verbs.lastIndexOf('create'))
    expect(s.calls.some((c) => c[0] === 'network' && c[1] === 'connect')).toBe(true)
    // The policy the gateway enforces comes from the trusted snapshot — and the executor never sees it.
    const policy = JSON.parse(readFileSync(path.join(root, 'executions', executionId, '.gateway', 'policy.json'), 'utf8'))
    expect(policy.manifest.hosts).toEqual(spec.snapshot.scope.manifest.hosts)
    expect(policy.limits).toEqual(spec.snapshot.limits)
    // The executor is created on the internal network (never a direct bridge, never host).
    const executorCreate = s.calls.find((c) => c[0] === 'create' && c.includes(internalNetworkName(executionId)))
    expect(executorCreate).toBeTruthy()
    expect(JSON.stringify(executorCreate)).not.toContain('--network none')
  })

  it('fails with gateway-unavailable when the gateway never signals ready, and never starts the executor', async () => {
    const spec = await makeSpec()
    const gw = gatewayNameFor(executionId)
    const s = scripted({
      image: () => ({ ok: true, stdout: 'x' }),
      inspect: (a) => (a.at(-1) === gw ? { ok: true, stdout: JSON.stringify({ State: { Status: 'exited', ExitCode: 1 }, Config: { Labels: JSON.parse(ownLabels) } }) } : absent()),
      'network inspect': () => ({ ok: false, stderr: 'No such network' }),
      logs: () => ({ ok: true, stdout: 'crashed, no ready line' }),
    })
    const slow = new IsolatedContainerBackend({ docker: s.docker, gatewayBundle: async () => path.join(root, 'bundle.mjs') })
    await expect(slow.prepare(spec)).rejects.toMatchObject({ kind: 'gateway-unavailable' })
    // The executor container (by its own name) is never created.
    expect(s.calls.some((c) => c[0] === 'create' && c.includes(containerName(spec)))).toBe(false)
  }, 40_000)

  it('fails with network-setup-failed when a private network cannot be created', async () => {
    const spec = await makeSpec()
    const s = scripted({ image: () => ({ ok: true, stdout: 'x' }), inspect: absent, 'network inspect': () => ({ ok: false, stderr: 'No such network' }), 'network create': () => ({ ok: false, stderr: 'pool overlap' }) })
    await expect(backend(s.docker).prepare(spec)).rejects.toMatchObject({ kind: 'network-setup-failed', rule: 'network.create-failed' })
  })

  it('cleans up executor, gateway and both networks in order, idempotently, and never touches foreign resources', async () => {
    const spec = await makeSpec()
    const present = new Set([internalNetworkName(executionId), egressNetworkName(executionId), containerName(spec), gatewayNameFor(executionId)])
    const removed: string[] = []
    const s = scripted({
      inspect: (a) => (present.has(a.at(-1)!) ? { ok: true, stdout: ownLabels.replace('.jsonl', '') && JSON.stringify({ State: { Status: 'exited', ExitCode: 0 }, Config: { Labels: JSON.parse(ownLabels) } }) } : absent()),
      'network inspect': (a) => (present.has(a.at(-1)!) ? { ok: true, stdout: ownLabels } : { ok: false, stderr: 'No such network' }),
      rm: (a) => (present.delete(a.at(-1)!), removed.push(a.at(-1)!), { ok: true }),
      'network rm': (a) => (present.delete(a.at(-1)!), removed.push(a.at(-1)!), { ok: true }),
      logs: () => ({ ok: true }),
    })
    const b = backend(s.docker)
    const prepared = (await b.resume(spec)).prepared
    const result = await b.cleanup(prepared)
    expect(result.network).toMatchObject({ profile: 'scoped-egress', gateway: { removed: true }, networks: [{ role: 'net-internal', removed: true }, { role: 'net-egress', removed: true }] })
    // Containers removed before networks.
    expect(removed.indexOf(containerName(spec))).toBeLessThan(removed.indexOf(internalNetworkName(executionId)))
    expect(removed.indexOf(gatewayNameFor(executionId))).toBeLessThan(removed.indexOf(internalNetworkName(executionId)))
    // Idempotent: a second cleanup removes nothing more.
    const before = removed.length
    await b.cleanup(prepared)
    expect(removed.length).toBe(before)
  })

  function containerName(spec: BackendSpec): string {
    return `audivra-${spec.executionId.replace('_', '-')}`
  }
})
