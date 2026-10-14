import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, ensureDatabase, runMigrations } from '../src/index.ts'

/*
 * Phase 6F (§44, gate 13) — the full migration set must apply cleanly to a brand-new, empty database and
 * produce the exact schema the application expects. This creates a throwaway database, runs every migration
 * from scratch, asserts all 42 tables are present (and no stray extras), confirms the migration bookkeeping,
 * and then drops the database. It is the upgrade/fresh-install safety net: a migration that drops a table,
 * fails to apply, or diverges from the schema breaks this test.
 */

// The 42 application tables, as declared in packages/database/src/schema.ts. Kept explicit so a migration that
// accidentally drops or renames a table is caught here rather than in production.
const EXPECTED_TABLES = [
  'agent_runs',
  'artifacts',
  'audit_events',
  'audit_steps',
  'audits',
  'benchmark_runs',
  'change_reports',
  'client_briefs',
  'evidence',
  'finding_evidence',
  'findings',
  'journeys',
  'owned_processes',
  'pages',
  'security_analyst_decisions',
  'security_assessment_comparisons',
  'security_attack_paths',
  'security_authorizations',
  'security_comparisons',
  'security_credentials',
  'security_domain_declarations',
  'security_engagements',
  'security_events',
  'security_executions',
  'security_findings',
  'security_graph_edges',
  'security_graph_gaps',
  'security_graph_nodes',
  'security_graph_provenance',
  'security_hypotheses',
  'security_hypothesis_links',
  'security_observations',
  'security_reasoning_actions',
  'security_reasoning_runs',
  'security_research_actions',
  'security_research_runs',
  'security_retest_cases',
  'security_retest_results',
  'security_sessions',
  'security_specialist_runs',
  'security_verification_candidates',
  'tool_runs',
].sort()

const base = new URL(process.env.DATABASE_URL ?? 'postgres://audivra:audivra@127.0.0.1:5440/audivra_test')
const freshDbName = `audivra_migtest_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const freshUrl = new URL(base.toString())
freshUrl.pathname = `/${freshDbName}`

async function dropFreshDb(): Promise<void> {
  const maintenance = new URL(base.toString())
  maintenance.pathname = '/postgres'
  const client = new pg.Client({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    await client.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [freshDbName])
    await client.query(`drop database if exists "${freshDbName.replace(/"/g, '""')}"`)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  // Make sure a leftover from a previously aborted run does not make the "created" assertion flaky.
  await dropFreshDb()
})

afterAll(async () => {
  await dropFreshDb()
})

describe('Phase 6F — migrations apply to a fresh database', () => {
  it('creates every table exactly once with no extras and records the migration run', async () => {
    const created = await ensureDatabase(freshUrl.toString())
    expect(created, 'a brand-new database should be created').toBe(true)

    await runMigrations(freshUrl.toString())
    expect((await canConnect(freshUrl.toString())).ok).toBe(true)

    const client = new pg.Client({ connectionString: freshUrl.toString() })
    await client.connect()
    try {
      const tables = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      )
      const names = tables.rows.map((r) => r.table_name).sort()
      expect(names).toEqual(EXPECTED_TABLES)
      expect(names).toHaveLength(42)

      // Drizzle records each applied migration; the bookkeeping table lives in its own schema.
      const applied = await client.query<{ count: string }>(`select count(*)::text as count from drizzle.__drizzle_migrations`)
      expect(Number(applied.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(16)

      // Re-running migrations on an already-migrated database must be a safe no-op (idempotent upgrade path).
      await runMigrations(freshUrl.toString())
      const after = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )
      expect(after.rows).toHaveLength(42)
    } finally {
      await client.end()
    }
  })
})
