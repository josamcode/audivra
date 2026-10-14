import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@audivra/config'
import { resetKeyringCache } from '@audivra/security'
import { runResearchBenchmark } from '../src/research-benchmark.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The autonomous research benchmark as a regression gate: a healthy app yields zero findings, a focused issue
 * is found by a cheap comparison without the expensive specialist, the specialist is used only as a last
 * resort, a provider outage degrades honestly, and adversarial proposals are rejected — with the headline
 * invariants: healthy-app verified findings = 0, and unnecessary specialist invocation rate = 0.
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

describe('research benchmark', () => {
  it('passes every scenario and the headline invariants', async () => {
    const result = await runResearchBenchmark({ db: handle.db })
    const failures = result.scenarios.flatMap((s) => Object.entries(s.metrics).filter(([, m]) => !m.pass).map(([k, m]) => `${s.name}.${k}: ${m.value} (want ${m.target}) — ${m.detail}`))
    expect(failures).toEqual([])
    expect(result.summary.healthyZeroFindings?.pass).toBe(true)
    expect(result.summary.zeroUnnecessarySpecialist?.pass).toBe(true)
    expect(result.scenarios.map((s) => s.name)).toEqual(['healthy-app', 'authorization-focused', 'specialist-useful', 'provider-unavailable', 'adversarial-ai'])
    expect(result.pass).toBe(true)
  }, 240_000)
})
