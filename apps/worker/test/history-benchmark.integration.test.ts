import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@audivra/config'
import { resetKeyringCache } from '@audivra/security'
import { runHistoryBenchmark } from '../src/history-benchmark.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The historical / retest benchmark as a regression gate: a fix is proven (never asserted from absence),
 * cannot-reproduce is distinct, regression is detected, a vanished attack path is reported not fixed, a
 * coverage reduction is surfaced, and — the single most important property — the false-FIXED rate is zero.
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

describe('history benchmark', () => {
  it('passes every scenario and metric, with a zero false-FIXED rate', async () => {
    const result = await runHistoryBenchmark({ db: handle.db })
    const failures = result.scenarios.flatMap((s) => Object.entries(s.metrics).filter(([, m]) => !m.pass).map(([k, m]) => `${s.name}.${k}: ${m.value} (want ${m.target}) — ${m.detail}`))
    expect(failures).toEqual([])
    expect(result.summary.falseFixedRate?.pass).toBe(true)
    expect(result.scenarios.map((s) => s.name)).toEqual(['fix-and-still-present', 'regression', 'cannot-reproduce', 'path-history', 'coverage-awareness', 'absence-not-fixed'])
    expect(result.pass).toBe(true)
  }, 240_000)
})
