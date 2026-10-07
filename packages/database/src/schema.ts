import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type {
  AgentRole,
  AgentRunStatus,
  AuditError,
  AuditStage,
  AuditStatus,
  AuditSummary,
  BaselineStats,
  Category,
  EffortLevel,
  EvidenceSource,
  EvidenceType,
  FindingType,
  ImpactLevel,
  Opportunity,
  Severity,
  StepStatus,
  ToolRunStatus,
  VerificationStatus,
} from '@audivra/contracts'

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const audits = pgTable(
  'audits',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    domain: text('domain').notNull(),
    clientName: text('client_name'),
    status: text('status').$type<AuditStatus>().notNull().default('queued'),
    stage: text('stage').$type<AuditStage>().notNull().default('preparing'),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    summary: jsonb('summary').$type<AuditSummary>(),
    baseline: jsonb('baseline').$type<BaselineStats>(),
    error: jsonb('error').$type<AuditError>(),
    evidenceSeq: integer('evidence_seq').notNull().default(0),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('audits_created_idx').on(t.createdAt)],
)

export const auditSteps = pgTable(
  'audit_steps',
  {
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    stage: text('stage').$type<AuditStage>().notNull(),
    status: text('status').$type<StepStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    message: text('message'),
    error: jsonb('error').$type<AuditError>(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [primaryKey({ columns: [t.auditId, t.stage] })],
)

export const pages = pgTable(
  'pages',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    status: integer('status'),
    title: text('title'),
    depth: integer('depth').notNull().default(0),
    source: text('source').notNull(),
    inspectedInBrowser: boolean('inspected_in_browser').notNull().default(false),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex('pages_audit_url_idx').on(t.auditId, t.url)],
)

export const toolRuns = pgTable(
  'tool_runs',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    tool: text('tool').notNull(),
    purpose: text('purpose').notNull(),
    status: text('status').$type<ToolRunStatus>().notNull(),
    url: text('url'),
    command: text('command'),
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    artifactPaths: jsonb('artifact_paths').$type<string[]>().notNull().default([]),
    result: jsonb('result').$type<Record<string, unknown>>(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('tool_runs_audit_idx').on(t.auditId)],
)

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    role: text('role').$type<AgentRole>().notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    promptVersion: text('prompt_version').notNull(),
    sessionId: text('session_id'),
    status: text('status').$type<AgentRunStatus>().notNull(),
    numTurns: integer('num_turns'),
    costUsd: real('cost_usd'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    output: jsonb('output'),
    validation: jsonb('validation').$type<Record<string, unknown>>(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('agent_runs_audit_idx').on(t.auditId)],
)

export const evidence = pgTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    /** Human/AI-facing reference, unique per audit, e.g. "EV-12". */
    ref: text('ref').notNull(),
    source: text('source').$type<EvidenceSource>().notNull(),
    type: text('type').$type<EvidenceType>().notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    url: text('url'),
    artifactPath: text('artifact_path'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    toolRunId: text('tool_run_id').references(() => toolRuns.id, { onDelete: 'set null' }),
    agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('evidence_audit_ref_idx').on(t.auditId, t.ref),
    index('evidence_audit_idx').on(t.auditId),
  ],
)

export const findings = pgTable(
  'findings',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    rank: integer('rank').notNull(),
    title: text('title').notNull(),
    category: text('category').$type<Category>().notNull(),
    severity: text('severity').$type<Severity>().notNull(),
    type: text('type').$type<FindingType>().notNull(),
    description: text('description').notNull(),
    observed: text('observed').notNull(),
    affectedUrls: jsonb('affected_urls').$type<string[]>().notNull().default([]),
    confidence: real('confidence').notNull(),
    verificationStatus: text('verification_status').$type<VerificationStatus>().notNull(),
    whyItMatters: text('why_it_matters').notNull(),
    businessImpact: text('business_impact').notNull(),
    businessImpactLevel: text('business_impact_level').$type<ImpactLevel>().notNull(),
    recommendation: text('recommendation').notNull(),
    effort: text('effort').$type<EffortLevel>().notNull(),
    opportunity: jsonb('opportunity').$type<Opportunity | null>(),
    createdBy: text('created_by').notNull(),
    sourceRefs: jsonb('source_refs').$type<string[]>().notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('findings_audit_ref_idx').on(t.auditId, t.ref)],
)

export const findingEvidence = pgTable(
  'finding_evidence',
  {
    findingId: text('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    evidenceId: text('evidence_id')
      .notNull()
      .references(() => evidence.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.findingId, t.evidenceId] })],
)

/** Activity log + live event source. Concise summaries only: never model reasoning. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    level: text('level').$type<'info' | 'warn' | 'error'>().notNull().default('info'),
    message: text('message').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    agentRunId: text('agent_run_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_events_audit_idx').on(t.auditId, t.id)],
)
