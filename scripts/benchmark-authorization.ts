/**
 * The Phase 5 Step 4 authorization/business-logic benchmark: a multi-tenant fixture with known ground truth
 * (enforced vs intentionally-broken object/tenant boundaries) over which Audivra plans and runs differential
 * comparisons, measuring precision and recall of the authorization signal, control usage, tenant/business-rule
 * accuracy, false positives, inconclusive correctness, cleanup correctness and bounded planner selection.
 * No real AI and no Docker: the comparison engine is deterministic and runs the reviewed identity-aware
 * capabilities in-process through the Capability Broker.
 *
 * Runs against its own database (`audivra_bench`) and a dev vault key, never the development data.
 * Usage: pnpm benchmark:authorization  → prints the scorecard, writes .local-data/benchmarks/authorization-*.json
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getConfig, getLogger, REPO_ROOT } from '@audivra/config'
import { createDb, ensureDatabase, runMigrations } from '@audivra/database'
import { runAuthorizationBenchmark } from '../apps/worker/src/authorization-benchmark.ts'

process.env.AUDIVRA_DATA_DIR ??= '.local-data/bench'
const url = new URL(getConfig().DATABASE_URL)
url.pathname = '/audivra_bench'
await ensureDatabase(url.toString())
await runMigrations(url.toString())
const handle = createDb(url.toString(), 4)
await handle.pool.query('truncate security_engagements cascade')

const result = await runAuthorizationBenchmark({ db: handle.db, log: getLogger().child({ component: 'authorization-benchmark' }) })
await handle.close()

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
for (const scenario of result.scenarios) {
  console.log(`\n${scenario.pass ? 'PASS' : 'FAIL'}  ${scenario.name}  (${scenario.durationMs} ms)`)
  console.log(`      ${scenario.description}`)
  for (const [key, m] of Object.entries(scenario.metrics)) console.log(`      ${m.pass ? '✓' : '✗'} ${pad(key, 24)} ${pad(String(m.value), 8)} ${pad(m.target, 8)} ${m.detail}`)
}
console.log('\nSummary')
for (const [key, m] of Object.entries(result.summary)) console.log(`  ${m.pass ? '✓' : '✗'} ${pad(key, 18)} ${pad(String(m.value), 8)} ${pad(m.target, 10)} ${m.detail}`)

const dir = path.join(REPO_ROOT, '.local-data', 'benchmarks')
await mkdir(dir, { recursive: true })
const file = path.join(dir, `authorization-${result.startedAt.replace(/[:.]/g, '-')}.json`)
await writeFile(file, JSON.stringify(result, null, 2), 'utf8')
console.log(`\n${result.pass ? 'AUTHORIZATION BENCHMARK: PASS' : 'AUTHORIZATION BENCHMARK: FAIL'} in ${(result.durationMs / 1000).toFixed(1)} s — ${path.relative(REPO_ROOT, file)}`)
process.exit(result.pass ? 0 : 1)
