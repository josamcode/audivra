import { desc, eq } from 'drizzle-orm'
import type { BenchmarkFixtureResult, BenchmarkRunItem } from '@audivra/contracts'
import type { Db } from '../client.ts'
import { newId } from '../ids.ts'
import { benchmarkRuns } from '../schema.ts'

type Row = typeof benchmarkRuns.$inferSelect

function toItem(row: Row): BenchmarkRunItem {
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    status: row.status,
    model: row.model,
    promptVersions: row.promptVersions,
    fixtures: row.fixtures,
    totals: row.totals ?? null,
    error: row.error,
  }
}

export async function startBenchmarkRun(
  db: Db,
  input: { model: string | null; promptVersions: Record<string, string> },
): Promise<string> {
  const id = newId('bench')
  await db.insert(benchmarkRuns).values({ id, status: 'running', model: input.model, promptVersions: input.promptVersions })
  return id
}

export async function updateBenchmarkRun(
  db: Db,
  id: string,
  patch: Partial<{
    status: BenchmarkRunItem['status']
    model: string | null
    fixtures: BenchmarkFixtureResult[]
    totals: BenchmarkRunItem['totals']
    error: string | null
    finishedAt: Date | null
  }>,
): Promise<void> {
  await db.update(benchmarkRuns).set(patch).where(eq(benchmarkRuns.id, id))
}

export async function listBenchmarkRuns(db: Db, limit = 20): Promise<BenchmarkRunItem[]> {
  const rows = await db.select().from(benchmarkRuns).orderBy(desc(benchmarkRuns.startedAt)).limit(limit)
  return rows.map(toItem)
}

/** Benchmark runs left "running" by a stopped worker are closed as failed (they never resume). */
export async function failInterruptedBenchmarkRuns(db: Db): Promise<number> {
  const rows = await db
    .update(benchmarkRuns)
    .set({ status: 'failed', error: 'Interrupted: the worker stopped before the benchmark finished', finishedAt: new Date() })
    .where(eq(benchmarkRuns.status, 'running'))
    .returning({ id: benchmarkRuns.id })
  return rows.length
}
