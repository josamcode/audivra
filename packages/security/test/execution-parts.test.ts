import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExecutionResult, SecurityEvidenceItem, SecurityExecutionSnapshot } from '@audivra/contracts'
import {
  ArtifactRegistrar,
  BudgetExceededError,
  classifyFailure,
  contextFromSnapshot,
  ExecutionError,
  ExecutionWorkspace,
  finalStatus,
  revalidateSnapshot,
  runtimeCheckCapability,
  runtimeLimitsFor,
  ScopeViolationError,
  snapshotHash,
  verifyStoredSnapshot,
} from '../src/index.ts'
import { snapshot as engagementSnapshot, verifiedLocal } from './memory-store.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'audivra-exec-parts-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
const ID = 'sx_0123456789abcd'

const rejects = async (work: () => Promise<unknown> | unknown, rule: string) => {
  let error: unknown = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  expect(error, rule).toBeInstanceOf(ExecutionError)
  expect((error as ExecutionError).rule).toBe(rule)
}

describe('execution workspace', () => {
  it('creates the controlled areas inside the engagement workspace', async () => {
    const ws = new ExecutionWorkspace(root, ID)
    await ws.init()
    expect(ws.dir).toBe(path.join(root, 'executions', ID))
    for (const area of ['inputs', 'outputs', 'artifacts', 'tmp'] as const) expect(existsSync(ws.area(area))).toBe(true)
    expect(ws.relative(path.join(ws.area('outputs'), 'a.txt'))).toBe(`executions/${ID}/outputs/a.txt`)
    expect(ws.relative(path.join(root, 'elsewhere.txt'))).toBeNull()
    expect(() => new ExecutionWorkspace(root, '../../escape')).toThrow(ExecutionError)
    expect(() => new ExecutionWorkspace(root, 'sx_UPPERCASE00000')).toThrow(ExecutionError)
  })

  it('refuses traversal, absolute paths, drive letters and NUL bytes', async () => {
    const ws = new ExecutionWorkspace(root, ID)
    await ws.init()
    for (const bad of ['../inputs/x', '../../../x', '/etc/passwd', 'C:/Windows/x', 'C:\\Windows\\x', 'a\0b', '', '.']) {
      await rejects(() => ws.write('outputs', bad, 'x'), 'workspace.path-escape')
    }
    // A path that only looks like it leaves the area but resolves inside it is simply that path.
    expect(ws.resolve('outputs', '../outputs/x')).toBe(path.join(ws.area('outputs'), 'x'))
    const file = await ws.write('outputs', 'nested/ok.txt', 'fine')
    expect(file).toBe(path.join(ws.area('outputs'), 'nested', 'ok.txt'))
  })

  it('accepts only regular files of this execution (outside inputs/ and tmp/) as artifacts', async () => {
    const ws = new ExecutionWorkspace(root, ID)
    await ws.init()
    await ws.write('artifacts', 'report.txt', 'hello')
    await ws.write('inputs', 'input.json', '{}')
    await ws.write('tmp', 'scratch.txt', 'tmp')
    mkdirSync(path.join(ws.area('outputs'), 'folder'), { recursive: true })
    expect(await ws.artifactFile(`executions/${ID}/artifacts/report.txt`)).toMatchObject({ relative: `executions/${ID}/artifacts/report.txt`, bytes: 5 })
    await rejects(() => ws.artifactFile(`executions/${ID}/inputs/input.json`), 'artifact.area-not-allowed')
    await rejects(() => ws.artifactFile(`executions/${ID}/tmp/scratch.txt`), 'artifact.area-not-allowed')
    await rejects(() => ws.artifactFile(`executions/${ID}/artifacts/missing.txt`), 'artifact.missing')
    await rejects(() => ws.artifactFile(`executions/${ID}/outputs/folder`), 'artifact.not-a-file')
    await rejects(() => ws.artifactFile(`executions/sx_otherexecution1/artifacts/report.txt`), 'artifact.outside-execution')
    await rejects(() => ws.artifactFile('../../outside.txt'), 'artifact.outside-execution')
  })

  it('refuses links and junctions that lead out of the execution', async () => {
    const ws = new ExecutionWorkspace(root, ID)
    await ws.init()
    const outside = path.join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'secret.txt'), 'not yours')
    // A directory junction needs no privileges on Windows; elsewhere a directory symlink is used.
    symlinkSync(outside, path.join(ws.area('outputs'), 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await rejects(() => ws.write('outputs', 'link/planted.txt', 'x'), 'workspace.link-escape')
    expect(existsSync(path.join(outside, 'planted.txt'))).toBe(false)
    await rejects(() => ws.artifactFile(`executions/${ID}/outputs/link/secret.txt`), 'workspace.link-escape')
  })

  it('cleans up scratch space idempotently and counts only the execution\'s own files', async () => {
    const ws = new ExecutionWorkspace(root, 'sx_cleanup000000a')
    expect(await ws.cleanup()).toEqual({ removedBytes: 0 })
    await ws.init()
    await ws.write('tmp', 'big.bin', Buffer.alloc(4096))
    await ws.write('inputs', 'input.json', '{}')
    await ws.write('outputs', 'out.txt', '12345')
    expect(await ws.artifactBytes()).toBe(5)
    expect(await ws.cleanup()).toEqual({ removedBytes: 4096 })
    expect(existsSync(ws.area('tmp'))).toBe(false)
    expect(await ws.cleanup()).toEqual({ removedBytes: 0 })
    expect(existsSync(path.join(ws.area('outputs'), 'out.txt'))).toBe(true)
  })
})

describe('artifact registration', () => {
  function registrar(maxBytes = 1000) {
    const ws = new ExecutionWorkspace(root, 'sx_registrar00000')
    const persisted: unknown[] = []
    const r = new ArtifactRegistrar({
      workspace: ws,
      maxBytes,
      allowedTypes: ['tool-result'],
      persist: async (content) => {
        persisted.push(content)
        return { ref: `EV-${persisted.length}`, ...content } as unknown as SecurityEvidenceItem
      },
    })
    return { ws, r, persisted }
  }

  it('validates type, metadata, confinement and the cumulative budget, and records a hash', async () => {
    const { ws, r, persisted } = registrar(1000)
    await ws.init()
    const a = await ws.write('artifacts', 'a.txt', 'x'.repeat(600))
    const b = await ws.write('artifacts', 'b.txt', 'y'.repeat(600))
    await rejects(() => r.register({ type: 'http-header', title: 't', summary: 's' }), 'artifact.type-not-declared')
    await rejects(() => r.register({ type: 'tool-result', title: 't', summary: 's', metadata: { blob: 'z'.repeat(70_000) } }), 'artifact.metadata-too-large')
    await r.register({ type: 'tool-result', title: 'A', summary: 'first', artifactPath: ws.relative(a)! })
    await rejects(() => r.register({ type: 'tool-result', title: 'B', summary: 'second', artifactPath: ws.relative(b)! }), 'artifact.budget-exceeded')
    expect(r.bytes).toBe(600)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ artifactPath: `executions/sx_registrar00000/artifacts/a.txt`, metadata: { artifact: { bytes: 600, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } } })
  })

  it('accepts nothing after the execution stopped', async () => {
    const { r } = registrar()
    r.close()
    await rejects(() => r.register({ type: 'tool-result', title: 't', summary: 's' }), 'evidence.closed')
  })
})

describe('trusted snapshot', () => {
  const engagement = engagementSnapshot(4997)
  const snapshot: SecurityExecutionSnapshot = {
    schemaVersion: 1,
    executionId: ID,
    correlationId: ID,
    engagement: { id: engagement.id, configVersion: engagement.configVersion, status: 'ready' },
    environment: 'staging',
    authorization: { required: true, state: 'valid', authorizationIds: [verifiedLocal(4997).id] },
    scope: { version: 1, hash: engagement.scopeHash, manifest: engagement.scope },
    policy: { profileKey: 'standard', profileVersion: 1, risk: 'allowed', mutation: 'allowed' },
    capability: { id: 'diagnostic.runtime-check', version: 1, implementation: 'builtin/runtime-check@1', name: 'Runtime check', riskClass: 'passive', sideEffect: 'read-only', supportsCancellation: true, evidenceTypes: ['tool-result'] },
    limits: { maxRequests: 10, requestsPerSecond: 1, concurrency: 1, executionTimeoutSeconds: 30, maxResponseBytes: 2048, maxArtifactMb: 1 },
    runtime: { timeoutSeconds: 30, maxArtifactBytes: 1_048_576, maxProcesses: 4, cancelGraceSeconds: 5 },
    input: { target: 'http://127.0.0.1:4997/', holdSeconds: 1 },
    allowedTargets: ['http://127.0.0.1:4997/'],
    actor: { kind: 'user', id: 'local-user', agentRunId: null },
    decision: { eventId: 7, rule: 'broker.allowed', evaluatedAt: new Date().toISOString() },
  }
  const row = (patch: Record<string, unknown> = {}) => ({
    id: ID,
    engagementId: engagement.id,
    capabilityId: 'diagnostic.runtime-check',
    capabilityVersion: 1,
    environment: 'staging',
    configVersion: engagement.configVersion,
    decisionEventId: 7,
    snapshot: JSON.parse(JSON.stringify(snapshot)) as unknown,
    snapshotHash: snapshotHash(snapshot),
    ...patch,
  })

  it('hashes canonically (key order and a JSON round trip do not matter)', () => {
    const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>).reverse())
    expect(snapshotHash(reordered)).toBe(snapshotHash(snapshot))
    expect(verifyStoredSnapshot(row())).toEqual(snapshot)
  })

  it('refuses a snapshot that was changed, is malformed or belongs to another execution', () => {
    const widened = { ...snapshot, limits: { ...snapshot.limits, executionTimeoutSeconds: 86_400 } }
    expect(() => verifyStoredSnapshot(row({ snapshot: widened }))).toThrow(/does not match its hash/)
    const extra = { ...snapshot, environment: 'isolated-lab' }
    expect(() => verifyStoredSnapshot(row({ snapshot: extra, snapshotHash: snapshotHash(extra) }))).toThrow(/environment differs/)
    const smuggled = { ...snapshot, authorized: true }
    expect(() => verifyStoredSnapshot(row({ snapshot: smuggled, snapshotHash: snapshotHash(smuggled) }))).toThrow(/cannot be trusted/)
    expect(() => verifyStoredSnapshot(row({ engagementId: 'othereng01' }))).toThrow(/engagement differs/)
    expect(() => verifyStoredSnapshot(row({ decisionEventId: 8 }))).toThrow(/decision differs/)
  })

  it('builds a deeply frozen executor context from the snapshot alone', () => {
    const context = contextFromSnapshot(snapshot)
    expect(context).toMatchObject({ executionId: ID, environment: 'staging', limits: snapshot.limits, allowedTargets: snapshot.allowedTargets })
    expect(Object.isFrozen(context.scope.manifest.hosts)).toBe(true)
    expect(() => ((context as { environment: string }).environment = 'isolated-lab')).toThrow(TypeError)
    expect(snapshot.environment).toBe('staging')
  })

  it('revalidates authority at start: it can only refuse, never widen', () => {
    const now = new Date()
    const current = { engagement, authorizations: [verifiedLocal(4997)] }
    expect(revalidateSnapshot(snapshot, current, now)).toBeNull()
    const rule = (patch: Partial<typeof current> & { engagement?: typeof engagement }, at = now) => revalidateSnapshot(snapshot, { ...current, ...patch }, at)?.rule
    expect(revalidateSnapshot(snapshot, null, now)?.rule).toBe('execution.engagement-missing')
    expect(rule({ engagement: { ...engagement, status: 'paused' } })).toBe('execution.engagement-not-runnable')
    expect(rule({ engagement: { ...engagement, configVersion: engagement.configVersion + 1 } })).toBe('execution.config-changed')
    expect(rule({ authorizations: [{ ...verifiedLocal(4997), effectiveStatus: 'revoked' }] })).toBe('execution.authorization-withdrawn')
    expect(rule({ authorizations: [] })).toBe('execution.authorization-withdrawn')
    const windowed = { ...snapshot, scope: { ...snapshot.scope, manifest: { ...snapshot.scope.manifest, testingWindow: { startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-02T00:00:00Z' } } } }
    expect(revalidateSnapshot(windowed, current, now)?.rule).toBe('execution.outside-window')
  })

  it('derives runtime limits from the effective limits and the declared resource profile only', () => {
    const limits = { ...snapshot.limits, executionTimeoutSeconds: 5000, maxArtifactMb: 3 }
    expect(runtimeLimitsFor(limits, runtimeCheckCapability.metadata)).toEqual({ timeoutSeconds: 900, maxArtifactBytes: 3 * 1_048_576, maxProcesses: 4, cancelGraceSeconds: 5 })
    const noProcesses = { ...runtimeCheckCapability.metadata, resourceProfile: { ...runtimeCheckCapability.metadata.resourceProfile, spawnsProcesses: false } }
    expect(runtimeLimitsFor({ ...limits, executionTimeoutSeconds: 10 }, noProcesses)).toMatchObject({ timeoutSeconds: 10, maxProcesses: 0 })
  })
})

describe('failure classification', () => {
  it('keeps platform classifications, names client refusals and redacts messages', () => {
    expect(classifyFailure(new ExecutionError('artifact-limit', 'artifact.budget-exceeded', 'too big'))).toEqual({ kind: 'artifact-limit', rule: 'artifact.budget-exceeded', message: 'too big' })
    expect(classifyFailure(new BudgetExceededError('Request budget exhausted'))).toMatchObject({ kind: 'executor-failed', rule: 'http.budget-exceeded' })
    expect(classifyFailure(new ScopeViolationError({ reason: 'nope' } as never))).toMatchObject({ kind: 'executor-failed', rule: 'http.scope-violation' })
    const generic = classifyFailure(new Error(`failed with Authorization: Bearer abcdef1234567890 ${'x'.repeat(3000)}`))
    expect(generic).toMatchObject({ kind: 'executor-failed', rule: 'executor.error' })
    expect(generic.message).not.toContain('abcdef1234567890')
    expect(generic.message.length).toBeLessThanOrEqual(1000)
  })

  it('maps a finished piece of work to exactly one final state', () => {
    const result = (outcome: ExecutionResult['outcome']): ExecutionResult => ({ outcome, summary: null, output: null, failure: null, evidenceRefs: [], artifactBytes: 0, processesStarted: 0, endedAt: '' })
    const fail = (kind: 'artifact-limit' | 'worker-interrupted' | 'preflight-failed') => ({ kind, rule: 'r', message: 'm' })
    expect(finalStatus('finalizing', result('succeeded'), null, null)).toBe('succeeded')
    expect(finalStatus('finalizing', result('succeeded'), fail('artifact-limit'), null)).toBe('failed')
    expect(finalStatus('finalizing', result('timeout'), null, null)).toBe('timed-out')
    expect(finalStatus('finalizing', result('succeeded'), null, 'locked')).toBe('failed')
    expect(finalStatus('cancelling', result('succeeded'), null, null)).toBe('cancelled')
    expect(finalStatus('cancelling', result('cancelled'), fail('worker-interrupted'), null)).toBe('interrupted')
    expect(finalStatus('running', result('cancelled'), fail('worker-interrupted'), null)).toBe('interrupted')
    expect(finalStatus('preparing', result('failed'), fail('preflight-failed'), null)).toBe('failed')
  })
})
