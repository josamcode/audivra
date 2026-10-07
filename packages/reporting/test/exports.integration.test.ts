import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRunRequest, AgentRunResult } from '../../ai-runtime/src/provider.ts'
import { getLogger } from '@audivra/config'
import { AUDIT_EXPORT_SCHEMA_VERSION, EXPORT_KINDS, type ExportKind } from '@audivra/contracts'
import { createAuditRecord, createBoss, ensureQueues, listAgentRuns, listEvidence, listToolRuns, type PgBoss } from '@audivra/database'
import { Pipeline } from '../../../apps/worker/src/pipeline.ts'
import { resetDb, startFixture, testDb } from '../../../test/helpers.ts'
import { closeRenderer, generateExport, listExports } from '../src/index.ts'

const handle = testDb()
const { db } = handle
let boss: PgBoss
let fixture: { server: Server; url: string }
let auditId: string

const business = {
  summary: 'A dental clinic in Cairo that books patients through WhatsApp.',
  businessType: 'Local service lead generation',
  businessModel: 'Paid treatments',
  likelyCustomers: 'Patients in Cairo',
  primaryConversion: 'WhatsApp enquiry',
  secondaryConversions: ['Phone call'],
  acquisitionSignals: [],
  confidence: 0.8,
  assumptions: [],
  evidenceIds: ['EV-1'],
}

const finding = (id: string, severity: string, evidenceIds: string[]) => ({
  id,
  title: id.endsWith('1') ? 'Promo banner overflows the mobile viewport' : 'Arabic page is missing dir="rtl"',
  category: id.endsWith('1') ? 'Mobile' : 'Localization',
  severity,
  type: 'verified',
  description: 'Problem, stated precisely.',
  observed: 'Measured in the browser.',
  affectedUrls: [`${fixture.url}/`],
  confidence: 0.9,
  evidenceIds,
  whyItMatters: 'Mobile visitors must scroll sideways.',
  businessImpact: 'Friction before the primary conversion.',
  businessImpactLevel: 'medium',
  recommendation: 'Constrain the banner to the viewport width.',
  effort: 'low',
  opportunity: null,
})

/** Stand-in for the Claude runtime: deterministic outputs for every role. */
class ScriptedProvider implements AgentProvider {
  readonly id = 'scripted'
  private shot = 'EV-1'
  async isAvailable() {
    return { available: true, version: 'test', reason: null }
  }
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (request.role === 'auditor') {
      // Cite a real baseline screenshot, as an auditor would for a visual problem.
      this.shot = (await listEvidence(db, request.auditId!)).find((e) => e.type === 'screenshot')?.ref ?? 'EV-1'
    }
    const outputs: Record<string, unknown> = {
      auditor: {
        businessUnderstanding: business,
        importantPageTypes: [{ type: 'Homepage', exampleUrls: [`${fixture.url}/`], notes: '' }],
        investigationSummary: 'Checked the mobile layout.',
        pagesInspected: [`${fixture.url}/`],
        technologies: [],
        findings: [finding('D1', 'high', ['EV-1', this.shot]), finding('D2', 'medium', ['EV-2'])],
        limitations: [],
        suggestedFurtherVerification: [],
      },
      reviewer: {
        overallAssessment: 'Sound.',
        approvedFindings: [
          { findingId: 'D1', note: 'ok' },
          { findingId: 'D2', note: 'ok' },
        ],
        rejectedFindings: [],
        findingsNeedingVerification: [],
        severityAdjustments: [],
        duplicates: [],
        missingAreas: [],
        priorityProblems: [],
        materialGaps: false,
      },
      finalizer: {
        executiveSummary: 'The clinic site works, but mobile visitors meet a layout overflow first.\n\nFix the banner.',
        businessUnderstanding: business,
        importantPageTypes: [],
        technologies: [{ name: 'FixtureServer', category: 'Web server', confidence: 0.6, evidenceIds: ['EV-1'] }],
        findings: [
          { ...finding('F1', 'high', ['EV-1', this.shot]), issueKey: 'mobile-banner-overflow', sourceFindingIds: ['D1'], verificationStatus: 'reviewer-approved' },
          { ...finding('F2', 'medium', ['EV-2']), issueKey: 'arabic-missing-rtl', sourceFindingIds: ['D2'], verificationStatus: 'reviewer-approved' },
        ],
        opportunities: [
          { title: 'Mobile layout fix', why: 'Removes sideways scrolling.', scope: 'Banner and template audit.', relatedFindingIds: ['F1'], impact: 'high', effort: 'low' },
          { title: 'Arabic RTL pass', why: 'Arabic visitors read right to left.', scope: 'dir attributes and mirrored layout.', relatedFindingIds: ['F2'], impact: 'medium', effort: 'medium' },
        ],
        limitations: [{ kind: 'out-of-scope', text: 'No active security testing.' }],
        pagesInspected: [`${fixture.url}/`],
      },
      planner: { artifacts: [], keptAsText: [] },
      composer: null,
    }
    return {
      status: request.role === 'composer' ? 'failed' : 'completed',
      output: outputs[request.role] ?? null,
      sessionId: 'session-secret-123',
      model: 'scripted-model',
      numTurns: 3,
      costUsd: 0,
      durationMs: 5,
      error: request.role === 'composer' ? 'composer offline (test)' : null,
      permissionDenials: [],
      usage: null,
      terminationReason: 'completed',
      toolCalls: {},
    }
  }
}

beforeAll(async () => {
  await resetDb(handle)
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  fixture = await startFixture()
  const audit = await createAuditRecord(db, {
    url: `${fixture.url}/`,
    normalizedUrl: `${fixture.url}/`,
    domain: new URL(fixture.url).host,
    aiEnabled: true,
  })
  auditId = audit.id
  // Inline mode runs every stage in this process, exactly as the benchmark does.
  await new Pipeline(db, null, getLogger(), new ScriptedProvider(), { inline: true }).handleBaseline(auditId)
}, 240_000)

afterAll(async () => {
  await closeRenderer()
  fixture.server.close()
  await boss.stop({ graceful: false })
  await handle.close()
})

/** Entry names from a ZIP's central directory (no extra dependency needed). */
function zipEntries(buffer: Buffer): string[] {
  const names: string[] = []
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue
    let offset = buffer.readUInt32LE(i + 16)
    const count = buffer.readUInt16LE(i + 10)
    for (let n = 0; n < count; n++) {
      const nameLength = buffer.readUInt16LE(offset + 28)
      const extra = buffer.readUInt16LE(offset + 30)
      const comment = buffer.readUInt16LE(offset + 32)
      names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength))
      offset += 46 + nameLength + extra + comment
    }
    break
  }
  return names
}

describe('exports', () => {
  it('lists every export kind with availability and stable file names', async () => {
    const items = (await listExports(db, auditId))!
    expect(items.map((i) => i.kind)).toEqual([...EXPORT_KINDS])
    expect(items.every((i) => i.filename.startsWith('127-0-0-1-'))).toBe(true)
    expect(items.find((i) => i.kind === 'csv-broken-links')?.available).toBe(true)
  })

  it('generates every export from persisted data without re-running the audit', async () => {
    const runsBefore = (await listAgentRuns(db, auditId)).length
    const toolRunsBefore = (await listToolRuns(db, auditId)).length
    const files = new Map<ExportKind, string>()
    for (const kind of EXPORT_KINDS) {
      const generated = await generateExport(db, auditId, kind)
      expect(generated, kind).not.toBeNull()
      files.set(kind, generated!.file)
    }
    expect((await listAgentRuns(db, auditId)).length).toBe(runsBefore)
    expect((await listToolRuns(db, auditId)).length).toBe(toolRunsBefore)

    const pdf = readFileSync(files.get('pdf')!)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(30_000)

    const html = readFileSync(files.get('html')!, 'utf8')
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain('Promo banner overflows the mobile viewport')
    expect(html).toContain('data:image/jpeg;base64,')
    // The client report never exposes internal run data.
    for (const secret of ['session-secret-123', 'scripted-model', 'promptVersion', auditId]) expect(html).not.toContain(secret)
    expect(html).not.toMatch(/(auditor|reviewer|finalizer|planner|composer):v\d/)

    const json = JSON.parse(readFileSync(files.get('json')!, 'utf8'))
    expect(json.schema).toBe(AUDIT_EXPORT_SCHEMA_VERSION)
    expect(json.findings.map((f: { ref: string; issueKey: string }) => [f.ref, f.issueKey])).toEqual([
      ['F1', 'mobile-banner-overflow'],
      ['F2', 'arabic-missing-rtl'],
    ])
    expect(json.evidence.length).toBeGreaterThan(5)
    expect(json.artifacts.length).toBeGreaterThan(0)
    expect(json.coverage.length).toBeGreaterThan(10)
    expect(json.aiRuns.map((r: { role: string }) => r.role)).toEqual(['auditor', 'reviewer', 'finalizer', 'planner', 'composer'])
    const raw = readFileSync(files.get('json')!, 'utf8')
    expect(raw).not.toContain('data:image')
    expect(raw).not.toContain('session-secret-123')

    const findingsCsv = readFileSync(files.get('csv-findings')!, 'utf8')
    expect(findingsCsv.charCodeAt(0)).toBe(0xfeff)
    expect(findingsCsv.trim().split(/\r?\n/)).toHaveLength(3)
    expect(readFileSync(files.get('csv-broken-links')!, 'utf8')).toMatch(/404/)
    expect(readFileSync(files.get('csv-pages')!, 'utf8').trim().split(/\r?\n/).length).toBeGreaterThan(5)

    const entries = zipEntries(readFileSync(files.get('bundle')!))
    const root = entries[0]!.split('/')[0]
    for (const expected of ['README.md', 'report.pdf', 'report.html', 'audit.json', 'csv/findings.csv', 'csv/pages.csv', 'csv/broken-links.csv']) {
      expect(entries, expected).toContain(`${root}/${expected}`)
    }
    expect(entries.some((e) => /\/screenshots\/.+\.png$/.test(e))).toBe(true)
    expect(entries.some((e) => /\/artifacts\/A\d+-[a-z_]+\.png$/.test(e))).toBe(true)
    expect(entries.some((e) => /\/technical\/baseline\//.test(e))).toBe(true)
  }, 240_000)
})
