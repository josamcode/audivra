import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@audivra/config'
import { resetKeyringCache } from '@audivra/security'
import { runAttackPathBenchmark } from '../src/attack-path-benchmark.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * The attack-path benchmark as a regression gate: path precision/recall against known routes, verified
 * multi-finding and single-finding paths, no path on an enforced boundary, dedupe/dominance, bounded search,
 * a tempting false correlation kept speculative with an explicit missing edge (never verified), and a
 * contradicted bridge rejecting a path.
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

describe('attack-path benchmark', () => {
  it('passes every scenario and metric', async () => {
    const result = await runAttackPathBenchmark({ db: handle.db })
    const failures = result.scenarios.flatMap((s) => Object.entries(s.metrics).filter(([, m]) => !m.pass).map(([k, m]) => `${s.name}.${k}: ${m.value} (want ${m.target}) — ${m.detail}`))
    expect(failures).toEqual([])
    expect(result.scenarios.map((s) => s.name)).toEqual(['precision-recall-dedupe', 'false-and-missing-edge', 'contradiction-handling'])
    expect(result.pass).toBe(true)
  }, 120_000)
})
