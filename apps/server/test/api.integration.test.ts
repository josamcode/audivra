import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditWorkspaceDir, getLogger } from '@audivra/config'
import {
  createAuditRecord,
  createBoss,
  createEvidence,
  ensureQueues,
  QUEUES,
  replaceFindings,
  replaceJourneys,
  updateAudit,
  type NewFinding,
  type PgBoss,
} from '@audivra/database'
import { buildApp } from '../src/app.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

const handle = testDb()
let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  await boss.deleteAllJobs()
  app = await buildApp({ db: handle.db, boss, hub: null, log: getLogger() })
})

afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})

beforeEach(() => resetDb(handle))

describe('audits API', () => {
  it('rejects invalid URLs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/audits',
      payload: { url: 'javascript:alert(1)' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/valid/i)
  })

  it('creates an audit, persists it and enqueues the baseline job', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/audits',
      payload: { url: 'example.com', clientName: 'Acme' },
    })
    expect(response.statusCode).toBe(201)
    const audit = response.json()
    expect(audit).toMatchObject({
      url: 'https://example.com/',
      domain: 'example.com',
      clientName: 'Acme',
      status: 'queued',
    })

    const list = (await app.inject({ method: 'GET', url: '/api/audits' })).json()
    expect(list.map((a: { id: string }) => a.id)).toContain(audit.id)

    const jobs = await boss.fetch(QUEUES.baseline, { batchSize: 10 })
    expect(jobs.map((j) => (j.data as { auditId: string }).auditId)).toContain(audit.id)

    const events = (await app.inject({ method: 'GET', url: `/api/audits/${audit.id}/events` })).json()
    expect(events[0]).toMatchObject({ type: 'audit.created' })
  })

  it('returns 404 for unknown audits', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/audits/doesnotexist' })).statusCode).toBe(404)
  })

  it('cancels a queued audit immediately', async () => {
    const audit = (
      await app.inject({ method: 'POST', url: '/api/audits', payload: { url: 'example.org' } })
    ).json()
    const cancelled = (await app.inject({ method: 'POST', url: `/api/audits/${audit.id}/cancel` })).json()
    expect(cancelled.status).toBe('cancelled')
    expect((await app.inject({ method: 'POST', url: `/api/audits/${audit.id}/cancel` })).statusCode).toBe(409)
  })

  it('serves workspace artifacts and blocks path traversal', async () => {
    const audit = (
      await app.inject({ method: 'POST', url: '/api/audits', payload: { url: 'example.net' } })
    ).json()
    const root = auditWorkspaceDir(audit.id)
    await mkdir(path.join(root, 'screenshots'), { recursive: true })
    await writeFile(path.join(root, 'screenshots', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const ok = await app.inject({
      method: 'GET',
      url: `/api/audits/${audit.id}/artifacts/screenshots/shot.png`,
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toMatch(/image\/png/)

    for (const attempt of ['..%2F..%2Fpackage.json', '%2E%2E/%2E%2E/.env', 'screenshots/../../../../.env']) {
      const res = await app.inject({ method: 'GET', url: `/api/audits/${audit.id}/artifacts/${attempt}` })
      expect(res.statusCode).not.toBe(200)
    }
    expect(
      (await app.inject({ method: 'GET', url: '/api/audits/..%2F..%2Fetc/artifacts/x' })).statusCode,
    ).toBe(400)
  })
})

describe('home screen API', () => {
  const finding = (ref: string, overrides: Partial<NewFinding> = {}): NewFinding => ({
    ref,
    rank: Number(ref.slice(1)),
    title: `Finding ${ref}`,
    category: 'Conversion',
    severity: 'medium',
    type: 'verified',
    description: 'd',
    observed: 'o',
    affectedUrls: [],
    confidence: 0.9,
    verificationStatus: 'reviewer-approved',
    whyItMatters: 'w',
    businessImpact: 'b',
    businessImpactLevel: 'medium',
    recommendation: 'r',
    effort: 'low',
    opportunity: null,
    createdBy: 'ai-finalizer',
    sourceRefs: ['D1'],
    evidenceIds: [],
    ...overrides,
  })

  async function finishedAudit(url: string, minutes: number, findings: NewFinding[], options: { benchmark?: boolean; issueKeys?: boolean } = {}) {
    const target = new URL(url)
    const audit = await createAuditRecord(handle.db, {
      url,
      normalizedUrl: target.toString(),
      domain: target.host,
      aiEnabled: true,
      benchmark: options.benchmark ?? false,
    })
    const startedAt = new Date(Date.now() - minutes * 60_000)
    await updateAudit(handle.db, audit.id, { status: 'completed', stage: 'done', startedAt, finishedAt: new Date() })
    await replaceFindings(handle.db, audit.id, findings)
    return audit.id
  }

  it('summarizes real audits, ranks follow-ups and keeps benchmark and local targets out of business counts', async () => {
    await finishedAudit('https://shop.example.com/', 10, [finding('F1', { issueKey: 'checkout-error', severity: 'high' }), finding('F2', { severity: 'low', businessImpactLevel: 'low' })])
    const latest = await finishedAudit('https://shop.example.com/', 20, [finding('F1', { issueKey: 'checkout-error', severity: 'high' })])
    await finishedAudit('http://127.0.0.1:4321/', 5, [finding('F1', { severity: 'critical' })])
    await finishedAudit('http://127.0.0.1:5999/', 8, [finding('F1')], { benchmark: true })
    const queued = (await app.inject({ method: 'POST', url: '/api/audits', payload: { url: 'example.org' } })).json()

    const normal = (await app.inject({ method: 'GET', url: '/api/dashboard' })).json()
    expect(normal.includesBenchmarks).toBe(false)
    expect(normal.summary).toMatchObject({ totalAudits: 4, queued: 1, running: 0, websites: 2, localTargets: 1, benchmarkAudits: 1, timedAudits: 2 })
    // Mean of the two shop audits (10 and 20 minutes); the local fixture run is not averaged.
    expect(normal.summary.averageDurationMs).toBeGreaterThan(14.9 * 60_000)
    expect(normal.summary.averageDurationMs).toBeLessThan(15.1 * 60_000)
    expect(normal.summary.latestFindings).toMatchObject({ websites: 1, total: 1 })
    expect(normal.audits.map((a: { benchmark: boolean }) => a.benchmark)).not.toContain(true)
    expect(normal.audits.find((a: { siteKey: string }) => a.siteKey === '127.0.0.1:4321').local).toBe(true)
    expect(normal.active.map((a: { id: string }) => a.id)).toEqual([queued.id])
    expect(normal.active[0].steps.length).toBeGreaterThan(0)
    // The recurring high issue of the latest shop audit is the follow-up; the local critical one is not.
    expect(normal.followUps).toHaveLength(1)
    expect(normal.followUps[0]).toMatchObject({ auditId: latest, ref: 'F1', change: 'unchanged', seenIn: 2 })
    expect(normal.repeatSites).toMatchObject([{ siteKey: 'shop.example.com', latestAuditId: latest, audits: 2 }])
    expect(normal.audits.find((a: { id: string }) => a.id === latest).trend).toMatchObject({ direction: 'stable' })

    const all = (await app.inject({ method: 'GET', url: '/api/dashboard?benchmark=1' })).json()
    expect(all.includesBenchmarks).toBe(true)
    expect(all.summary).toMatchObject({ totalAudits: 5, websites: 2, localTargets: 2 })
    expect(all.audits.filter((a: { benchmark: boolean }) => a.benchmark)).toHaveLength(1)
    expect(all.followUps).toHaveLength(1)
  })

  it('returns an empty home screen when there are no audits', async () => {
    const empty = (await app.inject({ method: 'GET', url: '/api/dashboard' })).json()
    expect(empty.summary).toMatchObject({ totalAudits: 0, websites: 0, averageDurationMs: null })
    expect([empty.audits, empty.active, empty.followUps, empty.repeatSites, empty.activity]).toEqual([[], [], [], [], []])
  })

  it('reports database latency and whether a worker consumes the audit queues', async () => {
    const health = (await app.inject({ method: 'GET', url: '/api/system/health' })).json()
    expect(health.database).toMatchObject({ ok: true, error: null })
    expect(health.database.latencyMs).toBeGreaterThanOrEqual(0)
    // No worker runs in this test process, so the engine must not be reported as running.
    expect(health.engine).toMatchObject({ state: 'stopped', workers: 0, activeJobs: 0 })
  })
})

describe('intelligence API', () => {
  const finding = (ref: string, overrides: Partial<NewFinding> = {}): NewFinding => ({
    ref,
    rank: Number(ref.slice(1)),
    title: `Finding ${ref}`,
    category: 'Conversion',
    severity: 'medium',
    type: 'verified',
    description: 'd',
    observed: 'Observed with `npx lighthouse https://intel.example.com` and saved to tools/lighthouse.json',
    affectedUrls: ['https://intel.example.com/'],
    confidence: 0.9,
    verificationStatus: 'reviewer-approved',
    whyItMatters: 'w',
    businessImpact: 'b',
    businessImpactLevel: 'medium',
    recommendation: 'r',
    effort: 'low',
    opportunity: null,
    createdBy: 'ai-finalizer',
    sourceRefs: ['D1'],
    evidenceIds: [],
    ...overrides,
  })

  async function finishedAudit(url: string, options: { aiEnabled?: boolean; minutesAgo?: number } = {}) {
    const target = new URL(url)
    const audit = await createAuditRecord(handle.db, {
      url,
      normalizedUrl: target.toString(),
      domain: target.host,
      aiEnabled: options.aiEnabled ?? true,
      template: { key: 'portfolio', version: 1 },
    })
    const startedAt = new Date(Date.now() - (options.minutesAgo ?? 10) * 60_000)
    await updateAudit(handle.db, audit.id, { status: 'completed', stage: 'done', startedAt, finishedAt: new Date(startedAt.getTime() + 60_000) })
    return audit.id
  }

  async function withEvidence(auditId: string) {
    const shot = await createEvidence(handle.db, { auditId, source: 'auditor', type: 'screenshot', title: 'Mobile homepage', summary: '', url: 'https://intel.example.com/' })
    const click = await createEvidence(handle.db, { auditId, source: 'auditor', type: 'browser-observation', title: 'Email link click', summary: '', url: 'https://intel.example.com/contact' })
    await replaceFindings(handle.db, auditId, [finding('F1', { evidenceIds: [shot.id, click.id], journeyRefs: ['J1'] }), finding('F2', { evidenceIds: [shot.id] })])
    return { shot, click }
  }

  it('stores the audit focus with its version and rejects unknown templates', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/audits', payload: { url: 'intel.example.com', template: 'portfolio' } })
    expect(created.statusCode).toBe(201)
    const detail = (await app.inject({ method: 'GET', url: `/api/audits/${created.json().id}` })).json()
    expect(detail.template).toEqual({ key: 'portfolio', version: 1, name: 'Portfolio / personal brand' })
    const fallback = (await app.inject({ method: 'POST', url: '/api/audits', payload: { url: 'intel2.example.com' } })).json()
    expect(fallback.template).toMatchObject({ key: 'general' })
    expect((await app.inject({ method: 'POST', url: '/api/audits', payload: { url: 'intel3.example.com', template: 'crm' } })).statusCode).toBe(400)
  })

  it('offers journey analysis for audits without journeys and queues it once', async () => {
    const id = await finishedAudit('https://intel.example.com/')
    await withEvidence(id)
    const before = (await app.inject({ method: 'GET', url: `/api/audits/${id}/journeys` })).json()
    expect(before.journeys).toEqual([])
    expect(before.status).toMatchObject({ available: true, running: false, lastError: null, lastCompletedAt: null })

    const queued = await app.inject({ method: 'POST', url: `/api/audits/${id}/journeys` })
    expect(queued.statusCode).toBe(202)
    expect(queued.json()).toMatchObject({ queued: true })
    const again = await app.inject({ method: 'POST', url: `/api/audits/${id}/journeys` })
    expect(again.json()).toMatchObject({ queued: false, running: true })
    expect((await app.inject({ method: 'GET', url: `/api/audits/${id}/journeys` })).json().status.running).toBe(true)
    const jobs = await boss.fetch(QUEUES.enrich, { batchSize: 10 })
    expect(jobs.map((j) => j.data)).toEqual([{ auditId: id, kind: 'journeys' }])
  })

  it('builds the evidence graph only from stored relationships', async () => {
    const id = await finishedAudit('https://intel.example.com/')
    const { shot, click } = await withEvidence(id)
    await replaceJourneys(
      handle.db,
      id,
      [
        {
          ref: 'J1',
          journeyKey: 'portfolio-email-enquiry',
          type: 'portfolio-contact',
          name: 'Email enquiry',
          goal: 'Contact the owner',
          description: '',
          isPrimary: true,
          confidence: 0.8,
          steps: [
            { label: 'Homepage', url: 'https://intel.example.com/', kind: 'page', action: '', conversionType: null, status: 'ok', note: '', evidenceIds: [shot.ref] },
            { label: 'Email link', url: null, kind: 'outcome', action: '', conversionType: 'email', status: 'unverified', note: '', evidenceIds: [click.ref] },
          ],
          health: [],
        },
      ],
      'audit',
    )
    const graph = (await app.inject({ method: 'GET', url: `/api/audits/${id}/graph?focus=finding:F1&depth=1` })).json()
    expect(graph.focus).toBe('finding:F1')
    expect(graph.nodes.map((n: { id: string }) => n.id)).toEqual(
      expect.arrayContaining([`evidence:${shot.ref}`, `evidence:${click.ref}`, 'journey:J1', 'page:https://intel.example.com']),
    )
    expect((await app.inject({ method: 'GET', url: `/api/audits/${id}/graph` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/audits/${id}/graph?focus=finding:F9` })).statusCode).toBe(404)

    const journeys = (await app.inject({ method: 'GET', url: `/api/audits/${id}/journeys` })).json()
    expect(journeys.journeys[0]).toMatchObject({ ref: 'J1', isPrimary: true, findingRefs: ['F1'], source: 'audit' })
  })

  it('explains changes only when there is an earlier audit, and keeps the comparison as the source of truth', async () => {
    const first = await finishedAudit('https://intel.example.com/', { minutesAgo: 60 })
    await replaceFindings(handle.db, first, [finding('F1', { issueKey: 'contact-form-labels' }), finding('F2', { issueKey: 'slow-lcp' })])
    const lonely = (await app.inject({ method: 'GET', url: `/api/audits/${first}/changes` })).json()
    expect(lonely.comparison).toBeNull()
    expect(lonely.status).toMatchObject({ available: false })
    expect(lonely.status.reason).toMatch(/no earlier finished audit/i)
    expect((await app.inject({ method: 'POST', url: `/api/audits/${first}/changes` })).statusCode).toBe(409)

    const second = await finishedAudit('https://intel.example.com/', { minutesAgo: 5 })
    await replaceFindings(handle.db, second, [finding('F1', { issueKey: 'slow-lcp' }), finding('F2', { issueKey: 'broken-email-link', title: 'Email link broken' })])
    const changes = (await app.inject({ method: 'GET', url: `/api/audits/${second}/changes` })).json()
    expect(changes.comparison.summary).toMatchObject({ new: 1, resolved: 1, unchanged: 1 })
    expect(changes.intelligence).toBeNull()
    expect(changes.status).toMatchObject({ available: true, running: false })
    const labels = changes.timelines.find((t: { key: string }) => t.key === 'contact-form-labels')
    expect(labels.entries.map((e: { status: string }) => e.status)).toEqual(['detected', 'not-found'])
  })

  it('refuses briefs for baseline-only audits and queues them for AI audits', async () => {
    const baseline = await finishedAudit('https://intel.example.com/', { aiEnabled: false })
    const refused = await app.inject({ method: 'POST', url: `/api/audits/${baseline}/brief` })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/without AI/)

    const ai = await finishedAudit('https://intel2.example.com/')
    await withEvidence(ai)
    expect((await app.inject({ method: 'GET', url: `/api/audits/${ai}/brief` })).json()).toMatchObject({ brief: null, status: { available: true } })
    expect((await app.inject({ method: 'POST', url: `/api/audits/${ai}/brief` })).statusCode).toBe(202)
  })

  it('serves a client report without internals: no run data, local paths or shell commands', async () => {
    const id = await finishedAudit('https://intel.example.com/')
    await withEvidence(id)
    const report = await app.inject({ method: 'GET', url: `/api/audits/${id}/report` })
    expect(report.statusCode).toBe(200)
    const body = report.json()
    expect(body.schema).toBe('audivra.report.v2')
    expect(body.focus).toBe('Portfolio / personal brand')
    expect(Array.isArray(body.journeys)).toBe(true)
    const text = JSON.stringify(body)
    for (const forbidden of ['promptVersion', 'agentRunId', 'sessionId', 'numTurns', 'tools/lighthouse.json', 'npx lighthouse']) {
      expect(text).not.toContain(forbidden)
    }
  })
})
