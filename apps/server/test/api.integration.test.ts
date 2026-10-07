import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditWorkspaceDir, getLogger } from '@audivra/config'
import { createBoss, ensureQueues, QUEUES, type PgBoss } from '@audivra/database'
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
