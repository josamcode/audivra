import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promptVersions, type AgentProvider } from '@audivra/ai-runtime'
import { getConfig, REPO_ROOT, type Logger } from '@audivra/config'
import { getTemplate, type BenchmarkFixtureResult } from '@audivra/contracts'
import {
  createAuditRecord,
  getAuditRow,
  listAgentRuns,
  listBenchmarkRuns,
  listEvidence,
  listFindings,
  listJourneys,
  startBenchmarkRun,
  updateBenchmarkRun,
  type Db,
  type PgBoss,
} from '@audivra/database'
import {
  benchmarkTotals,
  BenchmarkSuite,
  buildComparison,
  scoreChanges,
  scoreFixture,
  scoreJourneys,
  type FixtureExpectations,
} from '@audivra/insights'
import { Pipeline } from './pipeline.ts'

const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'site')

interface FixtureModule {
  startFixtureServer(port: number, options: { variant: string }): Promise<{ server: Server; url: string }>
}

export function loadBenchmarkSuite(): BenchmarkSuite {
  return BenchmarkSuite.parse(JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'expectations.json'), 'utf8')))
}

async function fixtureModule(): Promise<FixtureModule> {
  return (await import(pathToFileURL(path.join(FIXTURE_DIR, 'server.mjs')).href)) as FixtureModule
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

export interface BenchmarkOptions {
  db: Db
  boss: PgBoss | null
  log: Logger
  /** Existing run row (queued from the API); a new one is created otherwise. */
  runId?: string
  provider?: AgentProvider
  /** Restrict to these fixture IDs (default: all). */
  fixtures?: string[]
}

/**
 * Runs the quality benchmark: a full audit (baseline + AI pipeline, inline) of each fixture variant,
 * scored against its ground truth. v1 and v2 run on the same port so the v2 audit is compared with
 * v1 as a "previous audit of the same site" (benchmark audits never mix with real site history).
 */
export async function runBenchmark(options: BenchmarkOptions): Promise<string> {
  const { db, log } = options
  const config = getConfig()
  const suite = loadBenchmarkSuite()
  const fixtures = suite.fixtures.filter((f) => !options.fixtures || options.fixtures.includes(f.id))
  const runId = options.runId ?? (await startBenchmarkRun(db, { model: config.AUDITOR_MODEL ?? null, promptVersions: promptVersions() }))
  // A queued run may have been closed by a worker restart between queueing and pickup.
  if (options.runId) await updateBenchmarkRun(db, runId, { status: 'running', error: null, finishedAt: null })
  const { startFixtureServer } = await fixtureModule()
  const results: BenchmarkFixtureResult[] = []
  const ports = new Map<string, number>()

  try {
    for (const fixture of fixtures) {
      // v1/v2 are two states of the same site: same port, hence the same site identity.
      const siteGroup = fixture.variant === 'healthy' ? 'healthy' : 'dental'
      const { server, url } = await startFixtureServer(ports.get(siteGroup) ?? 0, { variant: fixture.variant })
      ports.set(siteGroup, Number(new URL(url).port))
      try {
        const result = await runFixture(options, fixture, url)
        // A later variant of the same site is checked against the deterministic comparison with the earlier one.
        const earlier = fixture.changes ? results.find((r) => r.fixture === fixture.changes!.comparedWith) : undefined
        if (fixture.changes && earlier?.auditId && result.auditId) {
          const comparison = await buildComparison(db, result.auditId, earlier.auditId)
          result.changes = scoreChanges(fixture.changes, earlier, result, comparison)
        }
        results.push(result)
      } catch (error) {
        log.error({ err: error, fixture: fixture.id }, 'benchmark fixture failed')
        results.push(failedResult(fixture, error))
      } finally {
        await close(server)
      }
      await updateBenchmarkRun(db, runId, { fixtures: results, model: config.AUDITOR_MODEL ?? null })
    }
    await updateBenchmarkRun(db, runId, { status: 'completed', fixtures: results, totals: benchmarkTotals(results), finishedAt: new Date() })
  } catch (error) {
    await updateBenchmarkRun(db, runId, {
      status: 'failed',
      fixtures: results,
      totals: results.length ? benchmarkTotals(results) : null,
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date(),
    })
    throw error
  }
  return runId
}

async function runFixture(options: BenchmarkOptions, fixture: FixtureExpectations, url: string): Promise<BenchmarkFixtureResult> {
  const { db, log } = options
  const normalizedUrl = `${url}/`
  // The fixture names its audit focus explicitly, so a benchmark never depends on the default template.
  const template = getTemplate(fixture.template)
  const audit = await createAuditRecord(db, {
    url: normalizedUrl,
    normalizedUrl,
    domain: new URL(url).host,
    clientName: `Benchmark · ${fixture.name}`,
    aiEnabled: getConfig().AUDIVRA_AI !== 'off',
    benchmark: true,
    template: { key: template.key, version: template.version },
  })
  log.info({ fixture: fixture.id, auditId: audit.id, url }, 'benchmark audit started')
  const pipeline = new Pipeline(db, options.boss, log, options.provider, { inline: true })
  await pipeline.handleBaseline(audit.id)

  const row = await getAuditRow(db, audit.id)
  const [findings, evidence, runs, journeys] = await Promise.all([
    listFindings(db, audit.id),
    listEvidence(db, audit.id),
    listAgentRuns(db, audit.id),
    listJourneys(db, audit.id),
  ])
  const auditor = runs.filter((r) => r.role === 'auditor').at(-1)
  const durationMs = row?.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null
  return {
    ...scoreFixture(fixture, {
      auditId: audit.id,
      status: row?.status ?? 'unknown',
      durationMs,
      auditorTurns: auditor?.numTurns ?? null,
      findings,
      evidence,
      error: row?.error?.message ?? null,
    }),
    template: template.key,
    journeys: fixture.journeys ? scoreJourneys(fixture.journeys, journeys) : null,
  }
}

/**
 * Re-scores a stored benchmark run against the current expectations from its persisted audits —
 * no audits are re-run and no AI is called. Used after the ground truth or the scorer changes.
 */
export async function rescoreBenchmark(db: Db, runId: string): Promise<BenchmarkFixtureResult[]> {
  const [run] = (await listBenchmarkRuns(db, 200)).filter((r) => r.id === runId)
  if (!run) throw new Error(`Benchmark run ${runId} not found`)
  const suite = loadBenchmarkSuite()
  const results: BenchmarkFixtureResult[] = []
  for (const previous of run.fixtures) {
    const fixture = suite.fixtures.find((f) => f.id === previous.fixture)
    if (!fixture || !previous.auditId) {
      results.push(previous)
      continue
    }
    const row = await getAuditRow(db, previous.auditId)
    const [findings, evidence, journeys] = await Promise.all([
      listFindings(db, previous.auditId),
      listEvidence(db, previous.auditId),
      listJourneys(db, previous.auditId),
    ])
    const result: BenchmarkFixtureResult = {
      ...scoreFixture(fixture, {
        auditId: previous.auditId,
        status: row?.status ?? previous.status,
        durationMs: previous.durationMs,
        auditorTurns: previous.auditorTurns,
        findings,
        evidence,
        error: previous.error,
      }),
      template: previous.template ?? null,
      journeys: fixture.journeys ? scoreJourneys(fixture.journeys, journeys) : null,
    }
    const earlier = fixture.changes ? results.find((r) => r.fixture === fixture.changes!.comparedWith) : undefined
    if (fixture.changes && earlier?.auditId) {
      result.changes = scoreChanges(fixture.changes, earlier, result, await buildComparison(db, previous.auditId, earlier.auditId))
    }
    results.push(result)
  }
  await updateBenchmarkRun(db, runId, { fixtures: results, totals: benchmarkTotals(results) })
  return results
}

function failedResult(fixture: FixtureExpectations, error: unknown): BenchmarkFixtureResult {
  const known = fixture.issues.filter((i) => i.deterministic).length
  return {
    fixture: fixture.id,
    healthy: fixture.healthy,
    auditId: null,
    status: 'failed',
    durationMs: null,
    auditorTurns: null,
    findings: 0,
    known,
    found: 0,
    missed: known,
    falsePositives: 0,
    unsupported: 0,
    severityCorrect: 0,
    evidenceLinked: 0,
    issues: [],
    falsePositiveDetails: [],
    unsupportedDetails: [],
    error: error instanceof Error ? error.message : String(error),
  }
}
