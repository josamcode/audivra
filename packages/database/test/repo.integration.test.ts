import pg from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createAuditRecord,
  createEvidence,
  EVENTS_CHANNEL,
  failInterruptedOnDemandRuns,
  findingCounts,
  getAuditDetail,
  getChangeReport,
  getClientBrief,
  latestAgentRun,
  listAudits,
  listFindings,
  listJourneys,
  recordEvent,
  replaceFindings,
  replaceJourneys,
  saveChangeReport,
  saveClientBrief,
  setFindingJourneyRefs,
  startAgentRun,
  type NewFinding,
} from '../src/index.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

const handle = testDb()
const { db } = handle

afterAll(() => handle.close())
beforeEach(() => resetDb(handle))

const newAudit = () =>
  createAuditRecord(db, {
    url: 'example.com',
    normalizedUrl: 'https://example.com/',
    domain: 'example.com',
    aiEnabled: true,
  })

function finding(overrides: Partial<NewFinding>): NewFinding {
  return {
    ref: 'F1',
    rank: 1,
    title: 'Title',
    category: 'SEO',
    severity: 'high',
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
    createdBy: 'ai-auditor',
    sourceRefs: ['D1'],
    evidenceIds: [],
    ...overrides,
  }
}

describe('audit persistence', () => {
  it('creates audits with all pipeline steps pending', async () => {
    const audit = await newAudit()
    const detail = await getAuditDetail(db, audit.id)
    expect(detail?.status).toBe('queued')
    expect(detail?.steps.map((s) => s.stage)).toEqual([
      'preparing',
      'baseline',
      'investigation',
      'review',
      'revision',
      'finalizing',
      'presenting',
    ])
    expect(detail?.steps.every((s) => s.status === 'pending')).toBe(true)
  })

  it('assigns sequential, per-audit evidence references even under concurrency', async () => {
    const a = await newAudit()
    const b = await newAudit()
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createEvidence(db, {
          auditId: a.id,
          source: 'baseline',
          type: 'metric',
          title: `m${i}`,
          summary: 's',
        }),
      ),
    )
    const other = await createEvidence(db, {
      auditId: b.id,
      source: 'auditor',
      type: 'screenshot',
      title: 'x',
      summary: 's',
    })
    expect(created.map((e) => e.ref).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `EV-${i + 1}`).sort(),
    )
    expect(other.ref).toBe('EV-1')
  })

  it('links findings to evidence and aggregates severity counts', async () => {
    const audit = await newAudit()
    const ev1 = await createEvidence(db, {
      auditId: audit.id,
      source: 'baseline',
      type: 'metric',
      title: 'a',
      summary: 's',
    })
    const ev2 = await createEvidence(db, {
      auditId: audit.id,
      source: 'auditor',
      type: 'screenshot',
      title: 'b',
      summary: 's',
    })
    await replaceFindings(db, audit.id, [
      finding({ ref: 'F1', rank: 1, severity: 'critical', evidenceIds: [ev2.id, ev1.id, ev1.id] }),
      finding({ ref: 'F2', rank: 2, severity: 'low', category: 'Performance' }),
    ])
    const findings = await listFindings(db, audit.id)
    expect(findings.map((f) => f.ref)).toEqual(['F1', 'F2'])
    expect(findings[0]!.evidenceRefs).toEqual(['EV-1', 'EV-2'])

    const counts = (await findingCounts(db, [audit.id])).get(audit.id)!
    expect(counts.total).toBe(2)
    expect(counts.severity.critical).toBe(1)
    expect(counts.categories).toEqual({ SEO: 1, Performance: 1 })

    // Finalization can be retried: findings are replaced, not duplicated.
    await replaceFindings(db, audit.id, [finding({ ref: 'F1', rank: 1 })])
    expect(await listFindings(db, audit.id)).toHaveLength(1)
    const listed = (await listAudits(db)).find((x) => x.id === audit.id)!
    expect(listed.findingCount).toBe(1)
  })

  it('notifies listeners when events are recorded', async () => {
    const audit = await newAudit()
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    await client.query(`LISTEN ${EVENTS_CHANNEL}`)
    const received = new Promise<{ auditId: string; id: number }>((resolve) => {
      client.on('notification', (msg) => resolve(JSON.parse(msg.payload!) as { auditId: string; id: number }))
    })
    const event = await recordEvent(db, { auditId: audit.id, type: 'audit.started', message: 'go' })
    const payload = await received
    await client.end()
    expect(payload).toEqual({ auditId: audit.id, id: event.id })
  })
})

describe('intelligence persistence', () => {
  const journey = (ref: string, isPrimary: boolean) => ({
    ref,
    journeyKey: `journey-${ref.toLowerCase()}`,
    type: 'lead' as const,
    name: `Journey ${ref}`,
    goal: 'Enquire',
    description: '',
    isPrimary,
    confidence: 0.7,
    steps: [
      { label: 'Home', url: 'https://example.com/', kind: 'page' as const, action: '', conversionType: null, status: 'ok' as const, note: '', evidenceIds: ['EV-1'] },
      { label: 'Form', url: 'https://example.com/contact', kind: 'outcome' as const, action: '', conversionType: 'form' as const, status: 'ok' as const, note: '', evidenceIds: ['EV-2'] },
    ],
    health: [],
  })

  it('stores the audit focus with its version; audits from before templates have none', async () => {
    const legacy = await newAudit()
    const focused = await createAuditRecord(db, {
      url: 'example.org',
      normalizedUrl: 'https://example.org/',
      domain: 'example.org',
      aiEnabled: true,
      template: { key: 'saas', version: 1 },
    })
    expect((await getAuditDetail(db, legacy.id))!.template).toBeNull()
    expect((await getAuditDetail(db, focused.id))!.template).toEqual({ key: 'saas', version: 1, name: 'SaaS' })
  })

  it('replaces journeys atomically, lists the primary first and derives finding links', async () => {
    const audit = await newAudit()
    await replaceFindings(db, audit.id, [finding({ ref: 'F1', rank: 1, journeyRefs: ['J2'] }), finding({ ref: 'F2', rank: 2, journeyRefs: ['J1', 'J2'] })])
    await replaceJourneys(db, audit.id, [journey('J2', false), journey('J1', true)], 'audit')
    let journeys = await listJourneys(db, audit.id)
    expect(journeys.map((j) => [j.ref, j.isPrimary, j.findingRefs])).toEqual([
      ['J1', true, ['F2']],
      ['J2', false, ['F1', 'F2']],
    ])
    expect(journeys[0]!.evidenceRefs).toEqual(['EV-1', 'EV-2'])

    // Journey analysis replaces them and relinks findings.
    await replaceJourneys(db, audit.id, [journey('J1', true)], 'analysis')
    await setFindingJourneyRefs(db, audit.id, new Map([['F1', ['J1']]]))
    journeys = await listJourneys(db, audit.id)
    expect(journeys.map((j) => [j.ref, j.source, j.findingRefs])).toEqual([['J1', 'analysis', ['F1']]])
    expect((await listFindings(db, audit.id)).map((f) => f.journeyRefs)).toEqual([['J1'], []])
  })

  it('keeps one change report per audit pair and one brief per audit (regenerating replaces)', async () => {
    const before = await newAudit()
    const audit = await newAudit()
    const analysis = { headline: 'First interpretation', summary: '', insights: [] }
    await saveChangeReport(db, { auditId: audit.id, previousAuditId: before.id, analysis, promptVersion: 'change-analyst:v1', agentRunId: null })
    await saveChangeReport(db, { auditId: audit.id, previousAuditId: before.id, analysis: { ...analysis, headline: 'Regenerated' }, promptVersion: 'change-analyst:v1', agentRunId: null })
    expect((await getChangeReport(db, audit.id, before.id))!.analysis.headline).toBe('Regenerated')
    expect(await getChangeReport(db, before.id, audit.id)).toBeNull()

    const content = {
      businessSummary: 's',
      primaryConversion: 'Form',
      primaryJourney: null,
      quick: { topIssues: [{ findingId: 'F1', headline: 'An issue headline', why: 'w' }], bestOpportunity: null, proofPoints: [], suggestedOpener: 'o' },
      meeting: { context: 'c', journeys: [], topIssues: [], sinceLastAudit: [], questions: [], uncertainties: [], opportunities: [], proofToShow: [] },
      talkingPoints: ['First point', 'Second point', 'Third point'],
      technical: { items: [] },
    }
    await saveClientBrief(db, { auditId: audit.id, content, promptVersion: 'client-brief:v1', agentRunId: null })
    await saveClientBrief(db, { auditId: audit.id, content: { ...content, businessSummary: 'regenerated' }, promptVersion: 'client-brief:v1', agentRunId: null })
    expect((await getClientBrief(db, audit.id))!.content.businessSummary).toBe('regenerated')
  })

  it('closes on-demand AI runs that a worker restart interrupted', async () => {
    const audit = await newAudit()
    const run = await startAgentRun(db, { auditId: audit.id, role: 'brief', provider: 'claude-cli', model: null, promptVersion: 'client-brief:v1' })
    expect((await latestAgentRun(db, audit.id, 'brief'))!.status).toBe('running')
    expect(await failInterruptedOnDemandRuns(db, ['journeys', 'changes', 'brief'])).toBe(1)
    const latest = (await latestAgentRun(db, audit.id, 'brief'))!
    expect(latest).toMatchObject({ id: run, status: 'failed', error: 'Interrupted (worker restarted)' })
  })
})
