/**
 * The Phase 4 reasoning benchmark: deterministic scenarios that measure reasoning quality — graph
 * construction, merge and provenance, hypothesis precision, unsupported and duplicate hypothesis rates,
 * useful next-action selection, unnecessary/redundant actions, AI-unavailable and refusal behaviour.
 * No real AI calls (a deterministic provider, including adversarial behaviours, runs through the real
 * router); no Docker (in-process fixture sensors against a local fixture site).
 *
 * Runs against its own database (`audivra_bench`) and data directory, never the development data.
 * Usage: pnpm benchmark:reasoning      → prints the scorecard, writes .local-data/benchmarks/reasoning-*.json
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getConfig, getLogger, REPO_ROOT } from '@audivra/config'
import { createDb, ensureDatabase, runMigrations } from '@audivra/database'
import { runReasoningBenchmark } from '../apps/worker/src/reasoning-benchmark.ts'

process.env.AUDIVRA_DATA_DIR ??= '.local-data/bench'
const url = new URL(getConfig().DATABASE_URL)
url.pathname = '/audivra_bench'
await ensureDatabase(url.toString())
await runMigrations(url.toString())
const handle = createDb(url.toString(), 4)
await handle.pool.query('truncate security_engagements cascade')

const result = await runReasoningBenchmark({ db: handle.db, log: getLogger().child({ component: 'reasoning-benchmark' }) })
await handle.close()

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
for (const scenario of result.scenarios) {
  console.log(`\n${scenario.pass ? 'PASS' : 'FAIL'}  ${scenario.name}  (${scenario.durationMs} ms)${scenario.run ? `  — ${scenario.run.status}: ${scenario.run.stopReason}` : ''}`)
  console.log(`      ${scenario.description}`)
  for (const [key, m] of Object.entries(scenario.metrics)) console.log(`      ${m.pass ? '✓' : '✗'} ${pad(key, 30)} ${pad(String(m.value), 8)} ${pad(m.target, 8)} ${m.detail}`)
}
console.log('\nSummary')
for (const [key, m] of Object.entries(result.summary)) console.log(`  ${m.pass ? '✓' : '✗'} ${pad(key, 22)} ${pad(String(m.value), 8)} ${pad(m.target, 14)} ${m.detail}`)

const dir = path.join(REPO_ROOT, '.local-data', 'benchmarks')
await mkdir(dir, { recursive: true })
const file = path.join(dir, `reasoning-${result.startedAt.replace(/[:.]/g, '-')}.json`)
await writeFile(file, JSON.stringify(result, null, 2), 'utf8')
console.log(`\n${result.pass ? 'REASONING BENCHMARK: PASS' : 'REASONING BENCHMARK: FAIL'} in ${(result.durationMs / 1000).toFixed(1)} s — ${path.relative(REPO_ROOT, file)}`)
process.exit(result.pass ? 0 : 1)
