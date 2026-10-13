import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@audivra/config'
import { resetKeyringCache } from '@audivra/security'
import { runAuthorizationBenchmark } from '../src/authorization-benchmark.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The authorization benchmark as a regression gate: every deterministic scenario must pass — object/tenant
 * boundary precision and recall, no false positives on enforced boundaries, control usage, correct
 * business-rule (invariant) evaluation, inconclusive-without-controls correctness, state-transition cleanup,
 * and bounded, duplicate-free planner selection.
 */

const handle = testDb()
const KEY = randomBytes(32)

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  resetKeyringCache()
  await resetDb(handle)
  await handle.pool.query('truncate security_engagements cascade')
})
afterAll(async () => {
  await handle.close()
  delete process.env.AUDIVRA_SECRET_KEY
  resetConfig()
  resetKeyringCache()
})

describe('authorization benchmark', () => {
  it('passes every scenario and metric', async () => {
    const result = await runAuthorizationBenchmark({ db: handle.db })
    const failures = result.scenarios.flatMap((s) => Object.entries(s.metrics).filter(([, m]) => !m.pass).map(([k, m]) => `${s.name}.${k}: ${m.value} (want ${m.target}) — ${m.detail}`))
    expect(failures).toEqual([])
    expect(result.scenarios.map((s) => s.name)).toEqual(['object-boundary', 'tenant-boundary', 'inconclusive-correctness', 'state-transition-cleanup', 'planner-selection', 'graph-derivation', 'ai-proposal-and-fallback'])
    expect(result.pass).toBe(true)
  }, 120_000)
})
