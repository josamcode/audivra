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
  /** Durable security executions (one job per execution; the job carries nothing but its id). */
  securityExecution: 'security-execution',
  /** Bounded reasoning runs (Phase 4): one job drives a run until it waits for executions or stops. */
  securityReasoning: 'security-reasoning',
  /** Differential comparisons (Phase 5 Step 4): one job runs one planned comparison to completion. */
  securityComparison: 'security-comparison',
  /** Verification pass (Phase 6A): one job drives candidate generation, verification and finding synthesis. */
  securityVerification: 'security-verification',
  /** Attack-path analysis (Phase 6B): one job discovers, validates and synthesizes evidence-backed paths. */
  securityAttackPath: 'security-attack-path',
  /** Retest execution (Phase 6C): one job replays a retest case through the broker and records the result. */
  securityRetest: 'security-retest',
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

/**
 * A security execution job names the execution and nothing else: the worker loads the trusted snapshot
 * from the database, so a job payload can never carry configuration.
 */
export interface SecurityExecutionJob {
  executionId: string
}

/** A reasoning job names the run and nothing else; its state, budget and stage are loaded from the database. */
export interface SecurityReasoningJob {
  runId: string
}

/** A comparison job names the comparison and nothing else; its plan is loaded from the database. */
export interface SecurityComparisonJob {
  comparisonId: string
}

/** A verification job names the engagement; the pass loads all stored knowledge and is idempotent. */
export interface SecurityVerificationJob {
  engagementId: string
}

/** An attack-path job names the engagement; the analysis loads findings + graph and is idempotent. */
export interface SecurityAttackPathJob {
  engagementId: string
}

/**
 * A retest job names the retest case, the target (current) assessment it runs in, and whether a bounded AI
 * adaptation is allowed. The case (its frozen reproduction, checks and controls) is loaded from the database;
 * the job carries no plan, capability or command.
 */
export interface SecurityRetestJob {
  retestCaseId: string
  targetEngagementId: string
  allowAdaptation: boolean
}

const HOUR = 3600

interface QueueSettings {
  expireInSeconds: number
  retryLimit: number
  retryDelay: number
  /** pg-boss queue policy; fixed when the queue is created (default `standard`). */
  policy?: 'standard' | 'exclusive' | 'stately'
}

/** Queue policies: AI stages are long-running and rely on heartbeats rather than short expirations. */
const QUEUE_OPTIONS: Record<QueueName, QueueSettings> =
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
    // One job per execution (`exclusive` + singletonKey = execution id: a duplicate send is a no-op).
    // A job lost with a crashed worker is retried; the handler only ever starts a *queued* execution,
    // so a retry can resume a never-started execution but never re-runs one that started.
    [QUEUES.securityExecution]: { expireInSeconds: 5 * HOUR, retryLimit: 2, retryDelay: 5, policy: 'exclusive' },
    // One queued + one active job per run (`stately` + singletonKey = run id): a wake-up that arrives while
    // the run's job is still finishing is kept, never lost. A second driver is fenced off by the run lease.
    [QUEUES.securityReasoning]: { expireInSeconds: 2 * HOUR, retryLimit: 1, retryDelay: 10, policy: 'stately' },
    // One job per comparison (`stately` + singletonKey = comparison id). A retry re-runs the engine, which
    // resumes from persisted arm state (completed arms are not re-executed), so a crash is recoverable.
    [QUEUES.securityComparison]: { expireInSeconds: 1 * HOUR, retryLimit: 1, retryDelay: 10, policy: 'stately' },
    // One job per engagement (`stately` + singletonKey = engagement id). The pass is deterministic and
    // idempotent: a retry re-generates candidates and advances them by issueKey, never duplicating.
    [QUEUES.securityVerification]: { expireInSeconds: 2 * HOUR, retryLimit: 1, retryDelay: 10, policy: 'stately' },
    // One job per engagement (`stately` + singletonKey = engagement id). Deterministic + idempotent: a retry
    // re-discovers and advances paths by pathKey, never duplicating.
    [QUEUES.securityAttackPath]: { expireInSeconds: 2 * HOUR, retryLimit: 1, retryDelay: 10, policy: 'stately' },
    // One job per retest case + target (`stately` + singletonKey = `${targetEngagementId}:${retestCaseId}`). A
    // retest reuses the durable comparison runtime (its own executions survive a crash); a retry re-runs the
    // replay, which re-validates policy and cleans up, and never reports a fix without a fresh passing control.
    [QUEUES.securityRetest]: { expireInSeconds: 2 * HOUR, retryLimit: 1, retryDelay: 10, policy: 'stately' },
  }

export const HEARTBEAT_SECONDS = 60

/** Name of the worker's pg-boss instance, so its registry row identifies the audit engine from start-up. */
export const WORKER_INSTANCE = 'audivra-worker'

export function createBoss(url: string, instanceName?: string): PgBoss {
  return new PgBoss({ connectionString: url, schema: 'pgboss', instanceName })
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const [name, { policy, ...options }] of Object.entries(QUEUE_OPTIONS)) {
    const existing = await boss.getQueue(name)
    const desired = { ...options, heartbeatSeconds: HEARTBEAT_SECONDS }
    if (existing) await boss.updateQueue(name, desired)
    else await boss.createQueue(name, { ...desired, ...(policy ? { policy } : {}) })
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

/** Queues one security execution. A second send for the same execution while its job exists is a no-op (null). */
export async function enqueueSecurityExecution(boss: PgBoss, executionId: string, jobId?: string): Promise<string | null> {
  return boss.send(QUEUES.securityExecution, { executionId } satisfies SecurityExecutionJob, { singletonKey: executionId, ...(jobId ? { id: jobId } : {}) })
}

/** Queues a reasoning run to be driven (no-op while one is already queued for it). */
export async function enqueueSecurityReasoning(boss: PgBoss, runId: string): Promise<string | null> {
  return boss.send(QUEUES.securityReasoning, { runId } satisfies SecurityReasoningJob, { singletonKey: runId })
}

/** Queues a planned comparison to be executed (no-op while one is already queued for it). */
export async function enqueueSecurityComparison(boss: PgBoss, comparisonId: string): Promise<string | null> {
  return boss.send(QUEUES.securityComparison, { comparisonId } satisfies SecurityComparisonJob, { singletonKey: comparisonId })
}

/** Queues a verification pass for an engagement (no-op while one is already queued for it). */
export async function enqueueSecurityVerification(boss: PgBoss, engagementId: string): Promise<string | null> {
  return boss.send(QUEUES.securityVerification, { engagementId } satisfies SecurityVerificationJob, { singletonKey: engagementId })
}

/** Queues an attack-path analysis for an engagement (no-op while one is already queued for it). */
export async function enqueueSecurityAttackPath(boss: PgBoss, engagementId: string): Promise<string | null> {
  return boss.send(QUEUES.securityAttackPath, { engagementId } satisfies SecurityAttackPathJob, { singletonKey: engagementId })
}

/** Queues a retest replay (no-op while one for the same case + target is already queued). */
export async function enqueueSecurityRetest(boss: PgBoss, job: SecurityRetestJob): Promise<string | null> {
  return boss.send(QUEUES.securityRetest, job, { singletonKey: `${job.targetEngagementId}:${job.retestCaseId}` })
}
