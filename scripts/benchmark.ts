/**
 * Runs the audit quality benchmark in this process: a full audit (baseline + AI pipeline) of each
 * fixture variant, scored against fixtures/site/expectations.json. Results are stored in
 * benchmark_runs (visible under System → Quality) together with the prompt versions used.
 * Usage: pnpm benchmark [--fixtures=v1,v2,healthy]
 *        pnpm benchmark --rescore=<runId>   (re-score a stored run from its audits; no AI calls)
 * The same run can be started from the UI (System → Quality), which queues it on the worker.
 */
import { getConfig, getLogger } from '@audivra/config'
import { closeDb, getDb, listBenchmarkRuns, processStore, runMigrations } from '@audivra/database'
import { flushProcessStore, killAllOwned, setProcessStore } from '@audivra/tool-runtime'
import { rescoreBenchmark, runBenchmark } from '../apps/worker/src/benchmark.ts'

const config = getConfig()
const log = getLogger()
const fixturesArg = process.argv.find((a) => a.startsWith('--fixtures='))?.split('=')[1]
const fixtures = fixturesArg ? fixturesArg.split(',').map((f) => f.trim()).filter(Boolean) : undefined

await runMigrations(config.DATABASE_URL)
const { db } = getDb()
setProcessStore({
  insert: (record) => processStore.insert(db, record),
  finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
  listStale: (ownerId) => processStore.listStale(db, ownerId),
})

let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) return
  interrupted = true
  log.warn('benchmark interrupted; stopping the processes it started')
  void killAllOwned().finally(() => process.exit(130))
})

const started = Date.now()
const rescore = process.argv.find((a) => a.startsWith('--rescore='))?.split('=')[1]
const runId = rescore ?? (await runBenchmark({ db, boss: null, log, fixtures }))
if (rescore) await rescoreBenchmark(db, rescore)
const [run] = (await listBenchmarkRuns(db, 20)).filter((r) => r.id === runId)
if (run) {
  console.log(`\nBenchmark ${run.id} — ${run.status} in ${Math.round((Date.now() - started) / 60000)} min`)
  console.log(`Prompts: ${Object.entries(run.promptVersions).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  for (const f of run.fixtures) {
    console.log(
      `  ${f.fixture.padEnd(8)} ${f.status.padEnd(9)} found ${f.found}/${f.known}, missed ${f.missed}, false positives ${f.falsePositives}, unsupported ${f.unsupported}, severity ok ${f.severityCorrect}/${f.found}, evidence linked ${f.evidenceLinked}/${f.found}${f.error ? ` — ${f.error}` : ''}`,
    )
  }
  if (run.totals) console.log(`  totals   found ${run.totals.found}/${run.totals.known}, false positives ${run.totals.falsePositives}, unsupported ${run.totals.unsupported}`)
}
await flushProcessStore()
await closeDb()
