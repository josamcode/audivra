import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@audivra/config'
import { resetKeyringCache } from '@audivra/security'
import { runSpecialistBenchmark } from '../src/specialist-benchmark.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The specialist (Strix) benchmark as a regression gate: ingestion accuracy, entity linking, dedupe,
 * specialist-signal → verification conversion, honest provider-unavailable / partial handling, containment
 * (out-of-scope dropped), and — the critical invariant — ZERO direct Strix → Audivra verified-finding bypass.
 */

const handle = testDb()
const KEY = randomBytes(32)

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  process.env.STRIX_ENABLED = 'true'
  resetConfig()
  resetKeyringCache()
  await resetDb(handle)
  await handle.pool.query('truncate security_engagements cascade')
})
afterAll(async () => {
  await handle.close()
  delete process.env.AUDIVRA_SECRET_KEY
  delete process.env.STRIX_ENABLED
  resetConfig()
  resetKeyringCache()
})

describe('specialist benchmark', () => {
  it('passes every scenario and metric, with zero direct Strix→verified bypass', async () => {
    const result = await runSpecialistBenchmark({ db: handle.db })
    const failures = result.scenarios.flatMap((s) => Object.entries(s.metrics).filter(([, m]) => !m.pass).map(([k, m]) => `${s.name}.${k}: ${m.value} (want ${m.target}) — ${m.detail}`))
    expect(failures).toEqual([])
    expect(result.summary.zeroDirectBypass?.pass).toBe(true)
    expect(result.scenarios.map((s) => s.name)).toEqual(['lifecycle-boundary-conversion', 'containment-and-partial', 'provider-unavailable', 'planner-cost'])
    expect(result.pass).toBe(true)
  }, 180_000)
})
