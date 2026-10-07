import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRunRequest, AgentRunResult } from '@audivra/ai-runtime'
import { auditWorkspaceDir, getLogger } from '@audivra/config'
import {
  createAuditRecord,
  createBoss,
  ensureQueues,
  getAuditDetail,
  listAgentRuns,
  listArtifacts,
  listEvidence,
  listFindings,
  listToolRuns,
  QUEUES,
  startAgentRun,
  type PgBoss,
} from '@audivra/database'
import { Pipeline } from '../src/pipeline.ts'
import { resetDb, startFixture, testDb } from '../../../test/helpers.ts'

const handle = testDb()
const { db } = handle
let boss: PgBoss
let fixture: { server: Server; url: string }

beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  fixture = await startFixture()
})

afterAll(async () => {
  fixture.server.close()
  await boss.stop({ graceful: false })
  await handle.close()
})

beforeEach(async () => {
  await resetDb(handle)
  await boss.deleteAllJobs()
})

/** Deterministic provider used only in tests (the product path uses the real Claude CLI). */
class FakeProvider implements AgentProvider {
  readonly id = 'fake'
  calls: AgentRunRequest[] = []
  constructor(
    private readonly respond: (request: AgentRunRequest) => Partial<AgentRunResult>,
    private readonly available = true,
  ) {}
  async isAvailable() {
    return {
      available: this.available,
      version: 'test',
      reason: this.available ? null : 'provider offline (test)',
    }
  }
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(request)
    return {
      status: 'completed',
      output: null,
      sessionId: 'session-test',
      model: 'fake-model',
      numTurns: 1,
      costUsd: 0,
      durationMs: 5,
      error: null,
      permissionDenials: [],
      usage: null,
      terminationReason: 'completed',
      toolCalls: {},
      ...this.respond(request),
    }
  }
}

async function newAudit(url: string, aiEnabled: boolean) {
  return createAuditRecord(db, {
    url,
    normalizedUrl: url.endsWith('/') ? url : `${url}/`,
    domain: new URL(url).host,
    aiEnabled,
  })
}

async function jobQueued(queue: string, auditId: string): Promise<boolean> {
  const jobs = await boss.fetch(queue, { batchSize: 20 })
  return jobs.some((j) => (j.data as { auditId: string }).auditId === auditId)
}

const draftFinding = (id: string, evidenceIds: string[], severity = 'high') => ({
  id,
  title: `Finding ${id} about the site`,
  category: 'Mobile',
  severity,
  type: 'verified',
  description: 'Problem',
  observed: 'Observed',
  affectedUrls: [`${fixture.url}/`],
  confidence: 0.9,
  evidenceIds,
  whyItMatters: 'Why',
  businessImpact: 'Impact',
  businessImpactLevel: 'medium',
  recommendation: 'Fix it',
  effort: 'low',
  opportunity: null,
})

const businessUnderstanding = {
  summary: 'Dental clinic',
  businessType: 'Lead generation',
  businessModel: 'Paid treatments',
  acquisitionSignals: [],
  likelyCustomers: 'Patients',
  primaryConversion: 'WhatsApp',
  secondaryConversions: [],
  confidence: 0.8,
  assumptions: [],
  evidenceIds: ['EV-1'],
}

describe('audit pipeline', () => {
  it('runs a real baseline against the fixture site and finishes a baseline-only audit', async () => {
    const audit = await newAudit(fixture.url, false)
    const provider = new FakeProvider(() => ({}))
    const pipeline = new Pipeline(db, boss, getLogger(), provider)
    await pipeline.handleBaseline(audit.id)
    expect(await jobQueued(QUEUES.present, audit.id)).toBe(true)
    await pipeline.handlePresent(audit.id)

    const detail = (await getAuditDetail(db, audit.id))!
    expect(detail.status).toBe('completed')
    expect(detail.steps.find((s) => s.stage === 'investigation')?.status).toBe('skipped')
    // Without AI the presenting stage still produces deterministic, evidence-backed visuals.
    expect(detail.steps.find((s) => s.stage === 'presenting')?.status).toBe('completed')
    expect(provider.calls).toHaveLength(0)
    const artifacts = await listArtifacts(db, audit.id)
    expect(artifacts.length).toBeGreaterThan(0)
    expect(artifacts.every((a) => a.createdBy === 'system')).toBe(true)
    expect(detail.coverage.find((c) => c.capability === 'crawl')?.status).toBe('ran')
    expect(detail.coverage.find((c) => c.capability === 'ai-investigation')?.status).not.toBe('ran')
    expect(detail.baseline?.pagesCrawled).toBeGreaterThanOrEqual(6)
    expect(detail.baseline?.brokenLinks).toBeGreaterThanOrEqual(2)
    expect(detail.baseline?.consoleErrors).toBeGreaterThanOrEqual(1)
    expect(detail.baseline?.trackingDetected).toEqual([])
    expect(detail.baseline?.languages).toEqual(expect.arrayContaining(['en', 'ar']))

    const evidence = await listEvidence(db, audit.id)
    const titles = evidence.map((e) => e.title).join('\n')
    expect(titles).toMatch(/Horizontal overflow on mobile/)
    expect(titles).toMatch(/console\/JS error/)
    expect(titles).toMatch(/axe-core/)
    expect(titles).toMatch(/No analytics or ad tracking detected/)
    const screenshot = evidence.find((e) => e.type === 'screenshot')
    expect(screenshot?.artifactPath).toBeTruthy()
    expect(existsSync(`${auditWorkspaceDir(audit.id)}/${screenshot!.artifactPath}`)).toBe(true)

    const runs = await listToolRuns(db, audit.id)
    expect(runs.some((r) => r.tool === 'playwright' && r.status === 'completed')).toBe(true)
    expect(runs.some((r) => r.tool === 'crawler' && r.status === 'completed')).toBe(true)
  })

  it('preserves baseline evidence and marks the audit partial when the AI auditor fails', async () => {
    const audit = await newAudit(fixture.url, true)
    const provider = new FakeProvider(() => ({ status: 'failed', error: 'simulated provider outage' }))
    const pipeline = new Pipeline(db, boss, getLogger(), provider)
    await pipeline.handleBaseline(audit.id)
    expect(await jobQueued(QUEUES.investigation, audit.id)).toBe(true)
    await pipeline.handleInvestigation(audit.id)

    const detail = (await getAuditDetail(db, audit.id))!
    expect(detail.status).toBe('partial')
    expect(detail.error).toMatchObject({ kind: 'ai', stage: 'investigation' })
    expect(detail.steps.find((s) => s.stage === 'investigation')?.status).toBe('failed')
    expect(detail.evidenceCount).toBeGreaterThan(10)
    const runs = await listAgentRuns(db, audit.id)
    expect(runs[0]).toMatchObject({
      role: 'auditor',
      status: 'failed',
      error: 'simulated provider outage',
      promptVersion: 'auditor:v4',
    })
    // A failed AI stage still leaves the audit presentable: deterministic visuals and coverage.
    expect(detail.steps.find((s) => s.stage === 'presenting')?.status).toBe('completed')
    expect((await listArtifacts(db, audit.id)).length).toBeGreaterThan(0)
    expect(detail.coverage.find((c) => c.capability === 'ai-investigation')?.status).toBe('failed')
  })

  it('reports an unavailable AI runtime honestly instead of completing silently', async () => {
    const audit = await newAudit(fixture.url, true)
    const pipeline = new Pipeline(db, boss, getLogger(), new FakeProvider(() => ({}), false))
    await pipeline.handleBaseline(audit.id)
    await pipeline.handlePresent(audit.id)
    const detail = (await getAuditDetail(db, audit.id))!
    expect(detail.status).toBe('partial')
    expect(detail.steps.find((s) => s.stage === 'investigation')).toMatchObject({ status: 'failed' })
    expect(detail.error?.message).toMatch(/provider offline/)
  })

  it('runs auditor → reviewer → finalizer, validating evidence references end to end', async () => {
    const audit = await newAudit(fixture.url, true)
    const provider = new FakeProvider((request) => {
      if (request.role === 'planner') {
        return {
          output: {
            artifacts: [
              {
                type: 'metric_group',
                title: 'Crawl and link health',
                question: 'How many pages were checked and how many links are broken?',
                description: 'Measured by the baseline crawler and link checker.',
                evidenceIds: [],
                findingIds: ['F1'],
                category: 'SEO',
                priority: 1,
                placement: 'overview',
                data: { items: [{ label: 'Pages crawled', metricKey: 'crawl:pages' }, { label: 'Broken targets', metricKey: 'links:broken' }] },
              },
              {
                type: 'metric',
                title: 'An invented number',
                question: 'Does the resolver reject numbers that appear in no evidence?',
                description: 'Must be rejected.',
                evidenceIds: ['EV-1'],
                findingIds: [],
                category: null,
                priority: 2,
                placement: 'report',
                data: { item: { label: 'Revenue lost', value: 987654.321, unit: 'count', evidenceId: 'EV-1' } },
              },
            ],
            keptAsText: [{ insight: 'Business type', reason: 'A fact, not a measurement' }],
          },
        }
      }
      if (request.role === 'composer') {
        return {
          output: {
            executiveSnapshot: ['A dental clinic converting through WhatsApp.', 'The mobile layout overflows.', 'Fix the banner first.'],
            topRiskFindingIds: ['F1', 'F99'],
            topOpportunityTitles: ['mobile FIX', 'Nonexistent work'],
            featuredArtifactRefs: ['A1', 'A42'],
            majorFindingIds: ['F1', 'F2'],
            findingProof: [{ findingId: 'F1', artifactRef: 'A1', evidenceId: null }],
            categoryHighlights: [],
            actionPlan: { doFirst: [{ title: 'Fix the promo banner width', why: 'It overflows on mobile.', findingIds: ['F1'] }], then: [], later: [] },
          },
        }
      }
      if (request.role === 'auditor') {
        return {
          output: {
            businessUnderstanding,
            importantPageTypes: [{ type: 'Homepage', exampleUrls: [`${fixture.url}/`], notes: '' }],
            investigationSummary: 'Checked mobile layout',
            pagesInspected: [`${fixture.url}/`, `${fixture.url}/ar/`],
            technologies: [],
            findings: [
              draftFinding('D1', ['EV-1', 'EV-9999']),
              draftFinding('D2', ['EV-2'], 'medium'),
              draftFinding('D3', ['EV-3'], 'low'),
            ],
            limitations: [],
            suggestedFurtherVerification: [],
          },
        }
      }
      if (request.role === 'reviewer') {
        return {
          output: {
            overallAssessment: 'Mostly fine',
            approvedFindings: [
              { findingId: 'D1', note: 'ok' },
              { findingId: 'D2', note: 'ok' },
            ],
            rejectedFindings: [{ findingId: 'D3', reason: 'unsupported' }],
            findingsNeedingVerification: [],
            severityAdjustments: [],
            duplicates: [],
            missingAreas: [],
            priorityProblems: [],
            materialGaps: false,
          },
        }
      }
      return {
        output: {
          executiveSummary: 'Summary for the owner.',
          businessUnderstanding,
          importantPageTypes: [],
          technologies: [],
          findings: [
            {
              ...draftFinding('F1', ['EV-1']),
              severity: 'critical',
              sourceFindingIds: ['D1'],
              verificationStatus: 'reviewer-approved',
            },
            {
              ...draftFinding('F2', ['EV-2'], 'medium'),
              sourceFindingIds: ['D2'],
              verificationStatus: 'reviewer-approved',
            },
            { ...draftFinding('F3', ['EV-5']), sourceFindingIds: ['D404'], verificationStatus: 'unreviewed' },
          ],
          opportunities: [
            {
              title: 'Mobile fix',
              why: 'Mobile visitors hit the overflow first.',
              scope: 'Fix the banner width and recheck all templates.',
              relatedFindingIds: ['F1'],
              impact: 'high',
              effort: 'low',
            },
          ],
          limitations: [{ kind: 'could-not-verify', text: 'None' }],
          pagesInspected: [`${fixture.url}/`],
        },
      }
    })
    const pipeline = new Pipeline(db, boss, getLogger(), provider)
    await pipeline.handleBaseline(audit.id)
    await pipeline.handleInvestigation(audit.id)
    expect(await jobQueued(QUEUES.review, audit.id)).toBe(true)
    await pipeline.handleReview(audit.id)
    expect(await jobQueued(QUEUES.finalize, audit.id)).toBe(true)
    await pipeline.handleFinalize(audit.id)
    expect(await jobQueued(QUEUES.present, audit.id)).toBe(true)
    await pipeline.handlePresent(audit.id)

    const detail = (await getAuditDetail(db, audit.id))!
    expect(detail.status).toBe('completed')
    expect(detail.steps.find((s) => s.stage === 'revision')?.status).toBe('skipped')
    expect(detail.steps.find((s) => s.stage === 'presenting')?.status).toBe('completed')
    expect(detail.summary?.executiveSummary).toBe('Summary for the owner.')

    const findings = await listFindings(db, audit.id)
    // F3 had no valid source draft finding and was rejected; F1's severity escalation was clamped.
    expect(findings.map((f) => f.ref)).toEqual(['F1', 'F2'])
    expect(findings[0]!.severity).toBe('high')
    expect(findings[0]!.evidenceRefs).toEqual(['EV-1'])
    // Missing issue keys are derived deterministically; keys are unique within the audit.
    expect(findings.every((f) => f.issueKey && /^[a-z0-9-]+$/.test(f.issueKey))).toBe(true)
    expect(new Set(findings.map((f) => f.issueKey)).size).toBe(2)

    // The planner's grounded visual is kept (values filled from the catalog); the invented number is rejected.
    const artifacts = await listArtifacts(db, audit.id)
    const planned = artifacts.filter((a) => a.createdBy === 'planner')
    expect(planned.map((a) => a.title)).toEqual(['Crawl and link health'])
    expect(planned[0]!.ref).toBe('A1')
    expect(planned[0]!.evidenceIds.length).toBeGreaterThan(0)
    expect(artifacts.some((a) => a.title === 'An invented number')).toBe(false)

    // The composer's plan is stored with unknown references removed.
    expect(detail.reportPlan?.topRiskFindingIds).toEqual(['F1'])
    expect(detail.reportPlan?.featuredArtifactRefs).toEqual(['A1'])
    expect(detail.reportPlan?.topOpportunityTitles).toEqual(['Mobile fix'])

    const runs = await listAgentRuns(db, audit.id)
    expect(runs.map((r) => r.role)).toEqual(['auditor', 'reviewer', 'finalizer', 'planner', 'composer'])
    expect(runs.map((r) => r.promptVersion)).toEqual(['auditor:v4', 'reviewer:v3', 'finalizer:v4', 'planner:v1', 'composer:v1'])
    expect(JSON.stringify(runs[0]!.validation)).toMatch(/EV-9999/)
    expect(provider.calls[0]!.allowedTools).toContain('mcp__browser')
    expect(provider.calls[0]!.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(curl * -X POST*)', 'mcp__browser__browser_run_code_unsafe']),
    )
    expect(provider.calls[0]!.toolCallLimits).toMatchObject({ browser: expect.any(Number), terminal: expect.any(Number), total: expect.any(Number) })
    expect(provider.calls[0]!.wrapUp?.prompt).toMatch(/structured audit draft/)
    expect(provider.calls[0]!.auditId).toBe(audit.id)
    expect(provider.calls[1]!.tools).not.toContain('Bash')
    expect(provider.calls[2]!.tools).toEqual([])
    expect(provider.calls[2]!.prompt).toMatch(/Issue keys from the previous audit/)
    const planner = provider.calls.find((c) => c.role === 'planner')!
    expect(planner.tools).not.toContain('Bash')
    expect(planner.prompt).toMatch(/links:broken/)
    expect(provider.calls.find((c) => c.role === 'composer')!.tools).toEqual([])
  })

  it('runs one verification pass in the auditor session when the reviewer asks for checks', async () => {
    const audit = await newAudit(fixture.url, true)
    const draftOutput = (findings: unknown[]) => ({
      businessUnderstanding,
      importantPageTypes: [],
      investigationSummary: 's',
      pagesInspected: [],
      technologies: [],
      findings,
      limitations: [],
      suggestedFurtherVerification: [],
    })
    const provider = new FakeProvider((request) => {
      if (request.role === 'auditor')
        return {
          output: draftOutput([draftFinding('D1', ['EV-1']), draftFinding('D2', ['EV-2'])]),
          sessionId: 'auditor-session-42',
        }
      if (request.role === 'reviewer') {
        return {
          output: {
            overallAssessment: 'D2 is doubtful',
            approvedFindings: [{ findingId: 'D1', note: 'ok' }],
            rejectedFindings: [],
            findingsNeedingVerification: [
              { findingId: 'D2', concern: 'single observation', suggestedCheck: 'reload on mobile' },
            ],
            severityAdjustments: [],
            duplicates: [],
            missingAreas: [],
            priorityProblems: [],
            materialGaps: false,
          },
        }
      }
      if (request.role === 'revision')
        return {
          output: draftOutput([
            draftFinding('D1', ['EV-1']),
            { ...draftFinding('D2', ['EV-2', 'EV-3']), severity: 'medium' },
          ]),
        }
      return {
        output: {
          executiveSummary: 'Final',
          businessUnderstanding,
          importantPageTypes: [],
          technologies: [],
          findings: [
            {
              ...draftFinding('F1', ['EV-1']),
              sourceFindingIds: ['D1'],
              verificationStatus: 'reviewer-approved',
            },
            {
              ...draftFinding('F2', ['EV-2', 'EV-3'], 'medium'),
              sourceFindingIds: ['D2'],
              verificationStatus: 'rechecked',
            },
          ],
          opportunities: [],
          limitations: [],
          pagesInspected: [],
        },
      }
    })
    const pipeline = new Pipeline(db, boss, getLogger(), provider)
    await pipeline.handleBaseline(audit.id)
    await pipeline.handleInvestigation(audit.id)
    await pipeline.handleReview(audit.id)
    expect(await jobQueued(QUEUES.revision, audit.id)).toBe(true)
    await pipeline.handleRevision(audit.id)
    await pipeline.handleFinalize(audit.id)
    await pipeline.handlePresent(audit.id)

    const revision = provider.calls.find((c) => c.role === 'revision')!
    expect(revision.resumeSessionId).toBe('auditor-session-42')
    expect(revision.prompt).toMatch(/single observation/)
    const finalizer = provider.calls.find((c) => c.role === 'finalizer')!
    expect(finalizer.prompt).toMatch(/Revision pass happened: YES/)
    const detail = (await getAuditDetail(db, audit.id))!
    expect(detail.status).toBe('completed')
    expect(detail.steps.find((s) => s.stage === 'revision')?.status).toBe('completed')
    const findings = await listFindings(db, audit.id)
    expect(findings.find((f) => f.ref === 'F2')).toMatchObject({
      verificationStatus: 'rechecked',
      evidenceRefs: ['EV-2', 'EV-3'],
    })
  })

  it('falls back to the reviewed draft when the finalizer fails', async () => {
    const audit = await newAudit(fixture.url, true)
    const provider = new FakeProvider((request) => {
      if (request.role === 'auditor') {
        return {
          output: {
            businessUnderstanding,
            importantPageTypes: [],
            investigationSummary: 's',
            pagesInspected: [],
            technologies: [],
            findings: [draftFinding('D1', ['EV-1'])],
            limitations: [],
            suggestedFurtherVerification: [],
          },
        }
      }
      if (request.role === 'reviewer') return { status: 'failed', error: 'reviewer crashed' }
      return { status: 'failed', error: 'finalizer crashed' }
    })
    const pipeline = new Pipeline(db, boss, getLogger(), provider)
    await pipeline.handleBaseline(audit.id)
    await pipeline.handleInvestigation(audit.id)
    await pipeline.handleReview(audit.id)
    await pipeline.handleFinalize(audit.id)
    await pipeline.handlePresent(audit.id)
    const detail = (await getAuditDetail(db, audit.id))!
    expect(detail.status).toBe('partial')
    expect(detail.steps.find((s) => s.stage === 'review')?.status).toBe('failed')
    const findings = await listFindings(db, audit.id)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.verificationStatus).toBe('unreviewed')
    expect(detail.summary?.executiveSummary).toMatch(/did not complete/)
  })

  it('fails the audit clearly when the target is unreachable', async () => {
    const audit = await newAudit('http://127.0.0.1:9', false)
    const pipeline = new Pipeline(db, boss, getLogger(), new FakeProvider(() => ({})))
    await pipeline.handleBaseline(audit.id)
    const detail = (await getAuditDetail(db, audit.id))!
    expect(detail.status).toBe('failed')
    expect(detail.error).toMatchObject({ kind: 'required-capability', stage: 'baseline' })
    expect(detail.error?.message).toMatch(/could not be reached/)
  })

  it('closes runs interrupted by a worker crash when the stage is retried', async () => {
    const audit = await newAudit(fixture.url, true)
    const provider = new FakeProvider(() => ({ status: 'failed', error: 'second attempt also failed' }))
    const pipeline = new Pipeline(db, boss, getLogger(), provider)
    await pipeline.handleBaseline(audit.id)
    // Simulate a crashed first attempt that left an agent run marked as running.
    const stale = await startAgentRun(db, {
      auditId: audit.id,
      role: 'auditor',
      provider: 'fake',
      model: null,
      promptVersion: 'auditor:v2',
    })
    await pipeline.handleInvestigation(audit.id)
    const runs = await listAgentRuns(db, audit.id)
    expect(runs.find((r) => r.id === stale)).toMatchObject({
      status: 'failed',
      error: 'Interrupted (worker restarted)',
    })
    expect(runs.filter((r) => r.status === 'running')).toHaveLength(0)
  })

  it('does not redo completed stages when a job is delivered twice (restart safety)', async () => {
    const audit = await newAudit(fixture.url, false)
    const pipeline = new Pipeline(db, boss, getLogger(), new FakeProvider(() => ({})))
    await pipeline.handleBaseline(audit.id)
    const before = (await listEvidence(db, audit.id)).length
    await pipeline.handleBaseline(audit.id)
    expect((await listEvidence(db, audit.id)).length).toBe(before)
    await pipeline.handlePresent(audit.id)
    const artifacts = await listArtifacts(db, audit.id)
    // A duplicate delivery of the presenting job does not regenerate anything.
    await pipeline.handlePresent(audit.id)
    expect((await listArtifacts(db, audit.id)).map((a) => a.id)).toEqual(artifacts.map((a) => a.id))
    expect((await getAuditDetail(db, audit.id))!.status).toBe('completed')
  })
})
