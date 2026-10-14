import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@audivra/config'
import { resetKeyringCache } from '@audivra/security'
import { runFindingsBenchmark } from '../src/findings-benchmark.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The findings benchmark as a regression gate: finding precision/recall against known broken boundaries, no
 * false positives on enforced ones, no duplicate findings on a repeated pass, sane severities, correct
 * verification accuracy (confirm → verified, provider failure → blocked), and adversarial rejection (an
 * always-confirm AI cannot manufacture a finding where there is no evidence).
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

describe('findings benchmark', () => {
  it('passes every scenario and metric', async () => {
    const result = await runFindingsBenchmark({ db: handle.db })
    const failures = result.scenarios.flatMap((s) => Object.entries(s.metrics).filter(([, m]) => !m.pass).map(([k, m]) => `${s.name}.${k}: ${m.value} (want ${m.target}) — ${m.detail}`))
    expect(failures).toEqual([])
    expect(result.scenarios.map((s) => s.name)).toEqual(['precision-recall', 'healthy-zero-findings', 'verification-accuracy'])
    expect(result.pass).toBe(true)
  }, 120_000)
})
