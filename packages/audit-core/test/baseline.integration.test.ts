import { readFileSync } from 'node:fs'
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
        t.id === 'lighthouse' || t.id === 'axe-core' ? { ...t, state: 'unavailable', version: null } : t,
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

describe('baseline with optional scanners', () => {
  it('runs httpx, Katana and Pa11y, records their evidence and coverage, and skips disabled ones with a reason', async () => {
    const tools = await getSystemStatus()
    const ready = (id: string) => tools.tools.some((t) => t.id === id && t.state === 'ready')
    expect(ready('pa11y')).toBe(true)
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
      browserPages: 2,
      tools,
      scanners: ['httpx', 'katana', 'pa11y'],
    })

    const evidence = await listEvidence(handle.db, audit.id)
    const kinds = new Set(evidence.map((e) => e.metadata.kind))
    expect(kinds.has('pa11y')).toBe(true)
    const pa11y = evidence.find((e) => e.metadata.kind === 'pa11y')!
    // The fixture's hero image has no alt attribute: HTML_CodeSniffer must report it.
    expect(JSON.stringify(pa11y.metadata.byCode)).toMatch(/H37/)
    if (ready('httpx')) expect(kinds.has('httpx')).toBe(true)
    if (ready('katana')) expect(kinds.has('katana')).toBe(true)

    const runs = await listToolRuns(handle.db, audit.id)
    // Disabled scanners are recorded as skipped with the reason, never silently omitted.
    expect(runs.find((r) => r.tool === 'zap')).toMatchObject({ status: 'skipped', error: expect.stringMatching(/Disabled by configuration/) })
    expect(ws.abs('baseline/link-graph.json')).toBeTruthy()
    const graph = JSON.parse(readFileSync(ws.abs('baseline/link-graph.json'), 'utf8')) as { pages: unknown[]; edges: unknown[] }
    expect(graph.pages.length).toBeGreaterThanOrEqual(6)
    expect(graph.edges.length).toBeGreaterThan(5)
    expect(result.summaryMarkdown).toMatch(/Pa11y \/ HTML_CodeSniffer/)
    expect(result.summaryMarkdown).toMatch(/conversion events \(clicks, form submits\) were NOT tested/)
  })
})
