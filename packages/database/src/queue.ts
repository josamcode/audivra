import { sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import type { Db } from './client.ts'

/** Each audit stage is its own durable job; a stage enqueues the next one when it finishes. */
export const QUEUES = {
  baseline: 'audit-baseline',
  investigation: 'audit-investigation',
  review: 'audit-review',
  revision: 'audit-revision',
  finalize: 'audit-finalize',
  present: 'audit-present',
  /** On-demand AI work for a finished audit: journey analysis, change intelligence, client brief. */
  enrich: 'audit-enrich',
  benchmark: 'benchmark-run',
} as const
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

export interface StageJob {
  auditId: string
}

export const ENRICH_KINDS = ['journeys', 'changes', 'brief'] as const
export type EnrichKind = (typeof ENRICH_KINDS)[number]

export interface EnrichJob {
  auditId: string
  kind: EnrichKind
}

const HOUR = 3600

/** Queue policies: AI stages are long-running and rely on heartbeats rather than short expirations. */
const QUEUE_OPTIONS: Record<QueueName, { expireInSeconds: number; retryLimit: number; retryDelay: number }> =
  {
    [QUEUES.baseline]: { expireInSeconds: 1 * HOUR, retryLimit: 1, retryDelay: 10 },
    [QUEUES.investigation]: { expireInSeconds: 4 * HOUR, retryLimit: 1, retryDelay: 30 },
    [QUEUES.review]: { expireInSeconds: 2 * HOUR, retryLimit: 1, retryDelay: 30 },
    [QUEUES.revision]: { expireInSeconds: 3 * HOUR, retryLimit: 1, retryDelay: 30 },
    [QUEUES.finalize]: { expireInSeconds: 2 * HOUR, retryLimit: 1, retryDelay: 30 },
    [QUEUES.present]: { expireInSeconds: 2 * HOUR, retryLimit: 1, retryDelay: 30 },
    // Explicit user requests: a failure is shown to the user, never retried behind their back.
    [QUEUES.enrich]: { expireInSeconds: 1 * HOUR, retryLimit: 0, retryDelay: 0 },
    // A benchmark runs several full AI audits sequentially; never retried automatically.
    [QUEUES.benchmark]: { expireInSeconds: 8 * HOUR, retryLimit: 0, retryDelay: 0 },
  }

export const HEARTBEAT_SECONDS = 60

/** Name of the worker's pg-boss instance, so its registry row identifies the audit engine from start-up. */
export const WORKER_INSTANCE = 'audivra-worker'

export function createBoss(url: string, instanceName?: string): PgBoss {
  return new PgBoss({ connectionString: url, schema: 'pgboss', instanceName })
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const [name, options] of Object.entries(QUEUE_OPTIONS)) {
    const existing = await boss.getQueue(name)
    const desired = { ...options, heartbeatSeconds: HEARTBEAT_SECONDS }
    if (existing) await boss.updateQueue(name, desired)
    else await boss.createQueue(name, desired)
  }
}

export async function enqueueStage(boss: PgBoss, queue: QueueName, auditId: string): Promise<string | null> {
  // singletonKey prevents duplicate concurrent jobs for the same audit stage.
  return boss.send(queue, { auditId } satisfies StageJob, { singletonKey: auditId })
}

export type { PgBoss }

/** Queues an on-demand AI job; a second request for the same audit and kind while one is queued is a no-op. */
export async function enqueueEnrich(boss: PgBoss, job: EnrichJob): Promise<string | null> {
  return boss.send(QUEUES.enrich, job, { singletonKey: `${job.auditId}:${job.kind}` })
}

/** Whether an intelligence job for this audit is queued or running (read from pg-boss's job table). */
export async function hasPendingEnrichJob(db: Db, auditId: string, kind: EnrichKind): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 from pgboss.job where name = ${QUEUES.enrich} and singleton_key = ${`${auditId}:${kind}`} and state in ('created', 'retry', 'active') limit 1`,
  )
  return result.rows.length > 0
}
