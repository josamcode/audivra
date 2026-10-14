import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { SpecialistRunContext } from '@audivra/security'
import { budgetFor, enabledModesFor, FakeSpecialistEngine, fakeVuln, strixVersionPin, SPECIALIST_ADAPTER_VERSION } from '@audivra/security'

/*
 * Phase 6D unit tests for the engine-contract pieces that need no database: the deterministic fake engine,
 * the Audivra-derived budget, and the mode gating (source-only is always the safe default; live modes are
 * enabled only when containment is proven). A provider-unavailable run is honest — it yields no results and
 * is never treated as "clean".
 */

const ctx = (over: Partial<SpecialistRunContext['config']> = {}): SpecialistRunContext => ({
  engagementId: 'eng123',
  executionId: 'sx_fake0000000001',
  workspaceDir: tmpdir(),
  signal: AbortSignal.timeout(5000),
  config: { engine: 'strix', mode: 'source-only', targets: [], budget: budgetFor('source-only', 'isolated-lab'), providerProfileId: 'strix-default', executionNetwork: null, stagedSourceRef: '/staged', ...over },
})

describe('FakeSpecialistEngine — deterministic, no Docker/provider', () => {
  it('produces the scripted vulnerabilities on a completed run', async () => {
    const engine = new FakeSpecialistEngine({ vulnerabilities: [fakeVuln({ nativeId: 'v1', title: 'IDOR', affected: { url: 'http://x/a', sourcePath: null, apiOperation: null, assetHint: null } })] })
    const artifact = await engine.run(ctx())
    expect(artifact.schemaVersion).toBe('audivra.specialist.v1')
    expect(artifact.completion).toBe('completed')
    expect(artifact.vulnerabilities).toHaveLength(1)
    expect(artifact.vulnerabilities[0]!.nativeSeverity).toBe('high') // native severity retained as source metadata
  })

  it('a provider-unavailable run is honest: no results, never "clean"', async () => {
    const engine = new FakeSpecialistEngine({ providerUnavailable: true, vulnerabilities: [fakeVuln({ nativeId: 'v1', title: 'x' })] })
    const artifact = await engine.run(ctx())
    expect(artifact.completion).toBe('provider-unavailable')
    expect(artifact.vulnerabilities).toHaveLength(0)
  })

  it('a partial/budget-stopped run is distinct from a complete one', async () => {
    const artifact = await new FakeSpecialistEngine({ completion: 'budget-stopped' }).run(ctx())
    expect(artifact.completion).toBe('budget-stopped')
  })

  it('honors cancellation via the abort signal', async () => {
    const controller = new AbortController()
    const engine = new FakeSpecialistEngine({ delayMs: 5000 })
    const p = engine.run({ ...ctx(), signal: controller.signal })
    controller.abort(new Error('cancelled'))
    await expect(p).rejects.toThrow()
  })

  it('owns no processes or containers (clean cleanup)', async () => {
    const result = await new FakeSpecialistEngine().cleanup()
    expect(result.removed).toEqual([])
    expect(result.unownedFound).toEqual([])
  })
})

describe('mode gating — source-only is safe; live needs proven containment', () => {
  it('enables no modes without docker or provider', () => {
    expect(enabledModesFor({ dockerAvailable: false, providerConfigured: true, liveContainmentProven: true })).toEqual([])
    expect(enabledModesFor({ dockerAvailable: true, providerConfigured: false, liveContainmentProven: true })).toEqual([])
  })
  it('enables only source-only until containment is proven', () => {
    expect(enabledModesFor({ dockerAvailable: true, providerConfigured: true, liveContainmentProven: false })).toEqual(['source-only'])
  })
  it('enables live modes only when containment is proven', () => {
    expect(enabledModesFor({ dockerAvailable: true, providerConfigured: true, liveContainmentProven: true })).toEqual(['source-only', 'local-controlled-web', 'authorized-staging'])
  })
})

describe('budget + version pin', () => {
  it('derives a deterministic budget (never a raw model/user flag)', () => {
    const b = budgetFor('source-only', 'isolated-lab')
    expect(b.scanMode).toBe('standard')
    expect(b.wallClockMs).toBeGreaterThan(0)
    expect(b.maxArtifactBytes).toBeGreaterThan(0)
  })
  it('pins the adapter version', () => {
    expect(strixVersionPin().adapterVersion).toBe(SPECIALIST_ADAPTER_VERSION)
    expect(strixVersionPin().engine).toBe('strix')
  })
})
