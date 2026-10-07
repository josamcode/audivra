import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getLogger } from '@audivra/config'
import type { SystemStatus } from '@audivra/contracts'
import { createAuditRecord, listEvidence, listToolRuns } from '@audivra/database'
import { getSystemStatus } from '@audivra/tool-runtime'
import { AuditContext, runBaseline, Workspace } from '../src/index.ts'
import { resetDb, startFixture, testDb } from '../../../test/helpers.ts'

const handle = testDb()
let fixture: { server: Server; url: string }

beforeAll(async () => {
  fixture = await startFixture()
})
afterAll(async () => {
  fixture.server.close()
  await handle.close()
})
beforeEach(() => resetDb(handle))

describe('baseline with missing optional tools', () => {
  it('records unavailable tools as skipped and still completes with evidence', async () => {
    const real = await getSystemStatus()
    // Simulate a machine where Lighthouse and axe-core are not installed.
    const tools: SystemStatus = {
      ...real,
      tools: real.tools.map((t) =>
        t.id === 'lighthouse' || t.id === 'axe-core' ? { ...t, state: 'missing', version: null } : t,
      ),
    }
    const audit = await createAuditRecord(handle.db, {
      url: fixture.url,
      normalizedUrl: `${fixture.url}/`,
      domain: new URL(fixture.url).host,
      aiEnabled: false,
    })
    const ws = new Workspace(audit.id)
    await ws.init()
    const ctx = new AuditContext(audit.id, handle.db, getLogger(), ws, new AbortController().signal)
    const result = await runBaseline(ctx, {
      url: `${fixture.url}/`,
      maxPages: 8,
      maxLinkChecks: 40,
      browserPages: 1,
      tools,
    })

    expect(result.stats.lighthouse).toBeNull()
    expect(result.stats.skippedCapabilities).toEqual([
      { capability: 'Lighthouse performance', reason: 'Lighthouse unavailable' },
      { capability: 'Automated accessibility checks (axe-core)', reason: 'axe-core unavailable' },
    ])
    const runs = await listToolRuns(handle.db, audit.id)
    expect(runs.find((r) => r.tool === 'lighthouse')).toMatchObject({
      status: 'skipped',
      error: 'tool unavailable',
    })
    const evidence = await listEvidence(handle.db, audit.id)
    expect(evidence.some((e) => e.title.startsWith('axe-core'))).toBe(false)
    expect(evidence.some((e) => e.type === 'screenshot')).toBe(true)
    expect(result.summaryMarkdown).toMatch(/Skipped capabilities/)
  })
})
