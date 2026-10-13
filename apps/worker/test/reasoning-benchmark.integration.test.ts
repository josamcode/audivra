import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runReasoningBenchmark } from '../src/reasoning-benchmark.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The reasoning benchmark as a regression gate: every deterministic scenario must pass — unsupported and
 * duplicate hypothesis rates of zero, invented evidence and invalid/redundant/needlessly expensive actions
 * rejected, honest "unknown" outcomes, and correct AI-unavailable and refusal behaviour.
 */

const handle = testDb()

beforeAll(async () => {
  await resetDb(handle)
  await handle.pool.query('truncate security_engagements cascade')
})
afterAll(async () => handle.close())

describe('reasoning benchmark', () => {
  it('passes every scenario and metric', async () => {
    const result = await runReasoningBenchmark({ db: handle.db })
    const failures = result.scenarios.flatMap((s) => Object.entries(s.metrics).filter(([, m]) => !m.pass).map(([k, m]) => `${s.name}.${k}: ${m.value} (want ${m.target}) — ${m.detail}`))
    expect(failures).toEqual([])
    expect(result.scenarios.map((s) => s.name)).toEqual(['graph-construction', 'grounded-loop', 'adversarial-pressure', 'unnecessary-cost', 'redundant-action', 'prefers-unknown', 'contradiction', 'ai-unavailable', 'provider-refusal'])
    expect(result.pass).toBe(true)
  }, 240_000)
})
