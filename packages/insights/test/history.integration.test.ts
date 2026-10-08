import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { BaselineStats } from '@audivra/contracts'
import { createAuditRecord, updateAudit } from '@audivra/database'
import { buildComparison, buildSiteHistory } from '../src/audit-data.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

const handle = testDb()
const { db } = handle

afterAll(() => handle.close())
beforeEach(() => resetDb(handle))

const baseline = (lcpMs: number): BaselineStats => ({
  pagesDiscovered: 10,
  pagesCrawled: 10,
  pagesInspectedInBrowser: 4,
  brokenLinks: 0,
  consoleErrors: 0,
  networkFailures: 0,
  accessibilityViolations: 0,
  trackingDetected: [],
  technologyHints: [],
  languages: ['en'],
  lighthouse: { url: 'https://history.example.com/', formFactor: 'mobile', performance: 90, accessibility: 100, seo: 100, bestPractices: 100, lcpMs, cls: 0, tbtMs: 0, totalBytes: 100_000 },
  skippedCapabilities: [],
})

async function audit(lcpMs: number, minutesAgo: number, status: 'completed' | 'running') {
  const row = await createAuditRecord(db, {
    url: 'https://history.example.com/',
    normalizedUrl: 'https://history.example.com/',
    domain: 'history.example.com',
    aiEnabled: true,
  })
  const startedAt = new Date(Date.now() - minutesAgo * 60_000)
  await updateAudit(db, row.id, {
    status,
    stage: status === 'running' ? 'presenting' : 'done',
    startedAt,
    finishedAt: status === 'running' ? null : new Date(startedAt.getTime() + 60_000),
    baseline: baseline(lcpMs),
  })
  // createdAt orders the history; make it follow the scenario.
  await handle.pool.query('update audits set created_at = $1 where id = $2', [startedAt, row.id])
  return row.id
}

describe('history while an audit is still making its visuals', () => {
  it('includes the running audit in its own trend so charts never stop one audit short', async () => {
    await audit(1800, 300, 'completed')
    await audit(2500, 200, 'completed')
    const current = await audit(1900, 5, 'running')

    const finishedOnly = await buildSiteHistory(db, 'history.example.com')
    expect(finishedOnly.series.find((s) => s.key === 'lighthouse.lcp')!.points.map((p) => p.value)).toEqual([1800, 2500])

    const forVisuals = await buildSiteHistory(db, 'history.example.com', { includeAuditId: current })
    expect(forVisuals.series.find((s) => s.key === 'lighthouse.lcp')!.points.map((p) => p.value)).toEqual([1800, 2500, 1900])
  })

  it('compares the running audit on its final facts, not the snapshot taken after the baseline', async () => {
    await audit(2500, 200, 'completed')
    const current = await audit(1900, 5, 'running')
    // The coverage stored right after the baseline still says the AI stages did not run.
    await updateAudit(db, current, {
      coverage: [{ capability: 'ai-investigation', label: 'AI investigation', status: 'skipped', tools: [], reason: 'Not run in this audit', detail: null }],
    })
    await handle.pool.query(`update audit_steps set status = 'completed' where audit_id = $1 and stage <> 'presenting'`, [current])
    await handle.pool.query(`update audit_steps set status = 'running' where audit_id = $1 and stage = 'presenting'`, [current])
    const comparison = (await buildComparison(db, current))!
    expect(comparison.coverage.find((c) => c.capability === 'ai-investigation')?.after).toBe('ran')
    // The presenting stage itself is in progress, which is not a coverage change.
    expect(comparison.coverage.some((c) => c.capability === 'visuals')).toBe(false)
    expect(comparison.metrics.find((m) => m.key === 'lighthouse.lcp')).toMatchObject({ before: 2500, after: 1900, direction: 'improved' })
  })
})
