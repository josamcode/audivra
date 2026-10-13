import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
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
  AuthorizationMethod,
  AuthorizationStatus,
  AuthorizationSubject,
  ArtifactPlacement,
  ArtifactType,
  BaselineStats,
  BenchmarkFixtureResult,
  BenchmarkRunItem,
  Category,
  ChangeAnalysis,
  ClientBriefContent,
  CoverageItem,
  EffortLevel,
  EngagementStatus,
  EvidenceSource,
  ExecutionExit,
  ExecutionFailure,
  ExecutionResult,
  ExecutionRunner,
  ExecutionStatus,
  EvidenceType,
  FindingType,
  ImpactLevel,
  JourneyHealth,
  JourneyStep,
  JourneyType,
  Opportunity,
  PolicyDecision,
  ReportPlan,
  ScopeManifest,
  SecurityActor,
  ObservationContribution,
  ObservationScopeClass,
  ObservationSourceType,
  ObservationType,
  SecurityEnvironment,
  SecurityEventType,
  SecurityEvidenceProvenance,
  SecurityExecutionSnapshot,
  Severity,
  StepStatus,
  ToolRunStatus,
  VerificationStatus,
  ActionStatus,
  AiCoverageState,
  AiRunProvenance,
  CredentialStatus,
  CredentialType,
  SessionStatus,
  DomainDeclarationKind,
  DomainDeclarationStatus,
  DomainSource,
  CheckResult,
  EvidenceCheck,
  FactStatus,
  GapKind,
  GapStatus,
  GraphConflict,
  GraphEntityKind,
  GraphRelationType,
  HypothesisCategory,
  HypothesisImpact,
  HypothesisOrigin,
  HypothesisRanking,
  HypothesisReviewVerdict,
  HypothesisStatus,
  HypothesisTransition,
  KnowledgeBasis,
  ProvenanceSource,
  ReasoningBudget,
  ReasoningDecision,
  ReasoningMode,
  ReasoningRunStatus,
  ReasoningStage,
  ReasoningStopReason,
  ReasoningUsage,
  RiskClass,
  SourceTrust,
  ComparisonDimension,
  ComparisonStatus,
  ComparisonResult,
  ResourceRelationship,
  InvariantEvalStatus,
  ComparisonArm,
  ComparisonControls,
  SemanticDifference,
  BusinessStateChange,
  CleanupStatus,
  CleanupAction,
  ComparisonTransition,
} from '@audivra/contracts'

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const audits = pgTable(
  'audits',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    domain: text('domain').notNull(),
    /** Canonical site identity for history/comparison: host without "www." plus non-default port. */
    siteKey: text('site_key').notNull().default(''),
    clientName: text('client_name'),
    status: text('status').$type<AuditStatus>().notNull().default('queued'),
    stage: text('stage').$type<AuditStage>().notNull().default('preparing'),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    summary: jsonb('summary').$type<AuditSummary>(),
    baseline: jsonb('baseline').$type<BaselineStats>(),
    error: jsonb('error').$type<AuditError>(),
    coverage: jsonb('coverage').$type<CoverageItem[]>(),
    reportPlan: jsonb('report_plan').$type<ReportPlan>(),
    benchmark: boolean('benchmark').notNull().default(false),
    /** Audit focus (template key + version); null for audits created before templates existed. */
    templateKey: text('template_key'),
    templateVersion: integer('template_version'),
    evidenceSeq: integer('evidence_seq').notNull().default(0),
    artifactSeq: integer('artifact_seq').notNull().default(0),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('audits_created_idx').on(t.createdAt), index('audits_site_idx').on(t.siteKey, t.createdAt)],
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
    pageType: text('page_type'),
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
    via: text('via'),
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
    terminationReason: text('termination_reason'),
    toolCalls: jsonb('tool_calls').$type<Record<string, number>>(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('agent_runs_audit_idx').on(t.auditId)],
)

/**
 * Evidence belongs to exactly one owner: a Website Audit (`audit_id`) or a security engagement
 * (`engagement_id`, recorded only by an allowed capability execution, with its security provenance).
 */
export const evidence = pgTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id').references(() => audits.id, { onDelete: 'cascade' }),
    engagementId: text('engagement_id').references(() => securityEngagements.id, { onDelete: 'cascade' }),
    securityExecutionId: text('security_execution_id'),
    securityProvenance: jsonb('security_provenance').$type<SecurityEvidenceProvenance>(),
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
    uniqueIndex('evidence_engagement_ref_idx').on(t.engagementId, t.ref),
    index('evidence_security_execution_idx').on(t.securityExecutionId),
    check('evidence_single_owner', sql`(${t.auditId} is null) <> (${t.engagementId} is null)`),
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
    issueKey: text('issue_key'),
    /** Journeys (J*) of the same audit this finding affects. */
    journeyRefs: jsonb('journey_refs').$type<string[]>().notNull().default([]),
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

/** Validated, resolved visual artifacts (see contracts/artifacts.ts). */
export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    type: text('type').$type<ArtifactType>().notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    question: text('question').notNull(),
    description: text('description').notNull(),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default([]),
    findingRefs: jsonb('finding_refs').$type<string[]>().notNull().default([]),
    category: text('category').$type<Category>(),
    priority: integer('priority').notNull().default(3),
    placement: text('placement').$type<ArtifactPlacement>().notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdBy: text('created_by').$type<'planner' | 'system'>().notNull(),
    agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('artifacts_audit_ref_idx').on(t.auditId, t.ref), index('artifacts_audit_idx').on(t.auditId)],
)

/**
 * Every external process Audivra starts. Only processes recorded here (and verified to be the same
 * OS process by PID + creation time) are ever terminated by Audivra.
 */
export const ownedProcesses = pgTable(
  'owned_processes',
  {
    id: text('id').primaryKey(),
    pid: integer('pid').notNull(),
    /** OS-reported process creation time, used to defeat PID reuse. */
    processStartedAt: ts('process_started_at'),
    image: text('image'),
    tool: text('tool').notNull(),
    auditId: text('audit_id').references(() => audits.id, { onDelete: 'set null' }),
    ownerId: text('owner_id').notNull(),
    parentPid: integer('parent_pid').notNull(),
    command: text('command').notNull(),
    cwd: text('cwd'),
    containerName: text('container_name'),
    /** Security capability execution that started the process (owner scope for its cancellation). */
    securityExecutionId: text('security_execution_id'),
    status: text('status').$type<'running' | 'exited' | 'killed' | 'reaped' | 'gone'>().notNull(),
    exitCode: integer('exit_code'),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('owned_processes_status_idx').on(t.status), index('owned_processes_audit_idx').on(t.auditId)],
)

export const benchmarkRuns = pgTable('benchmark_runs', {
  id: text('id').primaryKey(),
  status: text('status').$type<BenchmarkRunItem['status']>().notNull(),
  model: text('model'),
  promptVersions: jsonb('prompt_versions').$type<Record<string, string>>().notNull().default({}),
  fixtures: jsonb('fixtures').$type<BenchmarkFixtureResult[]>().notNull().default([]),
  totals: jsonb('totals').$type<BenchmarkRunItem['totals']>(),
  error: text('error'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
})

/** Visitor journeys discovered during an audit (or added later from its evidence). Replaced atomically. */
export const journeys = pgTable(
  'journeys',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    rank: integer('rank').notNull(),
    /** Stable key used to recognise the same journey across audits of a site. */
    journeyKey: text('journey_key').notNull(),
    type: text('type').$type<JourneyType>().notNull(),
    name: text('name').notNull(),
    goal: text('goal').notNull(),
    description: text('description').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    confidence: real('confidence').notNull(),
    steps: jsonb('steps').$type<JourneyStep[]>().notNull(),
    health: jsonb('health').$type<JourneyHealth[]>().notNull().default([]),
    source: text('source').$type<'audit' | 'analysis'>().notNull(),
    agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('journeys_audit_ref_idx').on(t.auditId, t.ref)],
)

/** Change Intelligence: the AI interpretation of one audit compared with an earlier one of the same site. */
export const changeReports = pgTable(
  'change_reports',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    previousAuditId: text('previous_audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    analysis: jsonb('analysis').$type<ChangeAnalysis>().notNull(),
    promptVersion: text('prompt_version').notNull(),
    agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('change_reports_pair_idx').on(t.auditId, t.previousAuditId)],
)

/** Client Brief generated on request from a finished audit (latest one per audit is kept). */
export const clientBriefs = pgTable(
  'client_briefs',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    content: jsonb('content').$type<ClientBriefContent>().notNull(),
    promptVersion: text('prompt_version').notNull(),
    agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('client_briefs_audit_idx').on(t.auditId)],
)

/**
 * Security engagements: authorized security assessments. Authorization, scope, environment and the
 * pinned policy profile are the only inputs the security broker trusts; every change increments
 * `config_version` and is recorded in `security_events`.
 */
export const securityEngagements = pgTable(
  'security_engagements',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    targetUrl: text('target_url').notNull(),
    /** Same site identity as audits.site_key, linking an engagement to the site's Website Audits. */
    siteKey: text('site_key').notNull(),
    /** Null until chosen; policy is then evaluated as production (the most restrictive). */
    environment: text('environment').$type<SecurityEnvironment>(),
    status: text('status').$type<EngagementStatus>().notNull().default('draft'),
    policyProfileKey: text('policy_profile_key').notNull(),
    policyProfileVersion: integer('policy_profile_version').notNull(),
    scope: jsonb('scope').$type<ScopeManifest>().notNull(),
    scopeVersion: integer('scope_version').notNull().default(1),
    scopeHash: text('scope_hash').notNull(),
    configVersion: integer('config_version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    evidenceSeq: integer('evidence_seq').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('security_engagements_updated_idx').on(t.updatedAt), index('security_engagements_site_idx').on(t.siteKey)],
)

/** Authorization records of an engagement (history is kept: new attempts add rows, revocation updates one). */
export const securityAuthorizations = pgTable(
  'security_authorizations',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    method: text('method').$type<AuthorizationMethod>().notNull(),
    status: text('status').$type<AuthorizationStatus>().notNull(),
    subject: jsonb('subject').$type<AuthorizationSubject>().notNull(),
    reason: text('reason'),
    /** Challenge value for methods that publish one (DNS TXT, well-known file); not a secret. */
    challenge: text('challenge'),
    reference: text('reference'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    verifiedAt: ts('verified_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('security_authorizations_engagement_idx').on(t.engagementId, t.createdAt)],
)

/**
 * Append-only security audit trail: configuration changes and every capability request with its full
 * decision. UPDATE and DELETE are rejected by a database trigger (see migration 0003).
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    type: text('type').$type<SecurityEventType>().notNull(),
    level: text('level').$type<'info' | 'warn' | 'error'>().notNull().default('info'),
    message: text('message').notNull(),
    actor: jsonb('actor').$type<SecurityActor>().notNull(),
    executionId: text('execution_id'),
    capabilityId: text('capability_id'),
    configVersion: integer('config_version').notNull(),
    decision: jsonb('decision').$type<PolicyDecision>(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('security_events_engagement_idx').on(t.engagementId, t.id), index('security_events_execution_idx').on(t.executionId)],
)

/**
 * Durable security executions: one run of one allowed capability request. The trusted snapshot and the
 * identity columns are immutable and a terminal row is frozen — both enforced by a database trigger
 * (migration 0004). Evidence and owned processes reference executions by `security_execution_id`.
 */
export const securityExecutions = pgTable(
  'security_executions',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    capabilityId: text('capability_id').notNull(),
    capabilityVersion: integer('capability_version').notNull(),
    status: text('status').$type<ExecutionStatus>().notNull().default('queued'),
    environment: text('environment').$type<SecurityEnvironment>().notNull(),
    /** Engagement configuration version the execution was approved against. */
    configVersion: integer('config_version').notNull(),
    correlationId: text('correlation_id').notNull(),
    requestedBy: jsonb('requested_by').$type<SecurityActor>().notNull(),
    /** Id of the `capability.allowed` security event that authorized the execution. */
    decisionEventId: bigint('decision_event_id', { mode: 'number' }).notNull(),
    snapshot: jsonb('snapshot').$type<SecurityExecutionSnapshot>().notNull(),
    /** SHA-256 of the canonical snapshot; verified before the worker uses it. */
    snapshotHash: text('snapshot_hash').notNull(),
    jobId: text('job_id'),
    runner: jsonb('runner').$type<ExecutionRunner>(),
    heartbeatAt: ts('heartbeat_at'),
    cancelRequestedAt: ts('cancel_requested_at'),
    cancelRequestedBy: jsonb('cancel_requested_by').$type<SecurityActor>(),
    result: jsonb('result').$type<ExecutionResult>(),
    exit: jsonb('exit').$type<ExecutionExit>(),
    failure: jsonb('failure').$type<ExecutionFailure>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('security_executions_engagement_idx').on(t.engagementId, t.createdAt), index('security_executions_status_idx').on(t.status)],
)

/**
 * Normalized, deduplicated security observations: evidence-backed signals a sensor reported about an
 * engagement's assets. One row per (engagement, dedupe key); every contributing sensor run's provenance
 * is kept in `contributions`, and the raw tool output stays in `evidence`. An observation is not a finding.
 */
export const securityObservations = pgTable(
  'security_observations',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    /** Stable `type:asset:subject` key, unique per engagement. */
    dedupeKey: text('dedupe_key').notNull(),
    type: text('type').$type<ObservationType>().notNull(),
    asset: text('asset').notNull(),
    subject: text('subject').notNull(),
    title: text('title').notNull(),
    scopeClass: text('scope_class').$type<ObservationScopeClass>(),
    value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
    sourceType: text('source_type').$type<ObservationSourceType>().notNull(),
    confidence: real('confidence').notNull(),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default([]),
    contributions: jsonb('contributions').$type<ObservationContribution[]>().notNull().default([]),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_observations_dedupe_idx').on(t.engagementId, t.dedupeKey),
    index('security_observations_type_idx').on(t.engagementId, t.type),
  ],
)

// ── Phase 4: Security Graph + hypothesis reasoning ──────────────────────────────────────────────────

/**
 * Security Graph entities (typed nodes). One row per (engagement, deterministic identity key); facts are
 * never deleted — a later run that differs makes them stale/superseded/contradicted. Why a fact is believed
 * lives in `security_graph_provenance`.
 */
export const securityGraphNodes = pgTable(
  'security_graph_nodes',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<GraphEntityKind>().notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    scopeClass: text('scope_class').$type<ObservationScopeClass>(),
    basis: text('basis').$type<KnowledgeBasis>().notNull(),
    confidence: real('confidence').notNull(),
    corroboration: integer('corroboration').notNull().default(0),
    tools: jsonb('tools').$type<string[]>().notNull().default([]),
    status: text('status').$type<FactStatus>().notNull().default('active'),
    statusReason: text('status_reason'),
    conflicts: jsonb('conflicts').$type<GraphConflict[]>().notNull().default([]),
    firstObservedAt: ts('first_observed_at').notNull(),
    lastObservedAt: ts('last_observed_at').notNull(),
    firstExecutionId: text('first_execution_id'),
    lastExecutionId: text('last_execution_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_graph_nodes_key_idx').on(t.engagementId, t.key),
    index('security_graph_nodes_kind_idx').on(t.engagementId, t.kind),
    index('security_graph_nodes_status_idx').on(t.engagementId, t.status),
  ],
)

/** Typed relationships between graph entities, with the same basis/confidence/temporal model as nodes. */
export const securityGraphEdges = pgTable(
  'security_graph_edges',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    type: text('type').$type<GraphRelationType>().notNull(),
    /** `TYPE|fromKey|toKey`, unique per engagement. */
    key: text('key').notNull(),
    fromNodeId: text('from_node_id')
      .notNull()
      .references(() => securityGraphNodes.id, { onDelete: 'cascade' }),
    toNodeId: text('to_node_id')
      .notNull()
      .references(() => securityGraphNodes.id, { onDelete: 'cascade' }),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    basis: text('basis').$type<KnowledgeBasis>().notNull(),
    confidence: real('confidence').notNull(),
    corroboration: integer('corroboration').notNull().default(0),
    tools: jsonb('tools').$type<string[]>().notNull().default([]),
    status: text('status').$type<FactStatus>().notNull().default('active'),
    statusReason: text('status_reason'),
    conflicts: jsonb('conflicts').$type<GraphConflict[]>().notNull().default([]),
    firstObservedAt: ts('first_observed_at').notNull(),
    lastObservedAt: ts('last_observed_at').notNull(),
    firstExecutionId: text('first_execution_id'),
    lastExecutionId: text('last_execution_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_graph_edges_key_idx').on(t.engagementId, t.key),
    index('security_graph_edges_from_idx').on(t.fromNodeId),
    index('security_graph_edges_to_idx').on(t.toNodeId),
    index('security_graph_edges_type_idx').on(t.engagementId, t.type),
  ],
)

/**
 * Why Audivra believes a graph fact: one row per (fact, source). An observation-backed row is maintained by
 * the deterministic projector; AI-inference and user-declaration rows are never touched by it.
 */
export const securityGraphProvenance = pgTable(
  'security_graph_provenance',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').$type<'node' | 'edge'>().notNull(),
    subjectId: text('subject_id').notNull(),
    source: text('source').$type<ProvenanceSource>().notNull(),
    trust: text('trust').$type<SourceTrust>().notNull(),
    sourceRef: text('source_ref').notNull(),
    observationId: text('observation_id'),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default([]),
    executionIds: jsonb('execution_ids').$type<string[]>().notNull().default([]),
    capabilityIds: jsonb('capability_ids').$type<string[]>().notNull().default([]),
    tools: jsonb('tools').$type<string[]>().notNull().default([]),
    confidence: real('confidence').notNull(),
    rationale: text('rationale'),
    reasoningRunId: text('reasoning_run_id'),
    firstAt: ts('first_at').notNull(),
    lastAt: ts('last_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_graph_provenance_source_idx').on(t.subjectType, t.subjectId, t.source, t.sourceRef),
    index('security_graph_provenance_subject_idx').on(t.subjectId),
    index('security_graph_provenance_observation_idx').on(t.engagementId, t.observationId),
  ],
)

/** Knowledge gaps: explicit unknowns (unknown is not false), opened and resolved deterministically. */
export const securityGraphGaps = pgTable(
  'security_graph_gaps',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<GapKind>().notNull(),
    subjectType: text('subject_type').$type<'node' | 'edge'>().notNull(),
    subjectId: text('subject_id').notNull(),
    subjectKey: text('subject_key').notNull(),
    question: text('question').notNull(),
    status: text('status').$type<GapStatus>().notNull().default('open'),
    resolution: text('resolution'),
    resolvedBy: jsonb('resolved_by').$type<{ observationId: string | null; executionId: string | null }>(),
    answeredBy: jsonb('answered_by').$type<ObservationType[]>().notNull().default([]),
    firstDetectedAt: ts('first_detected_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_graph_gaps_subject_idx').on(t.engagementId, t.kind, t.subjectKey),
    index('security_graph_gaps_status_idx').on(t.engagementId, t.status),
  ],
)

/** Persistent security hypotheses: claims to investigate (never verified vulnerabilities). */
export const securityHypotheses = pgTable(
  'security_hypotheses',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    claim: text('claim').notNull(),
    category: text('category').$type<HypothesisCategory>().notNull(),
    status: text('status').$type<HypothesisStatus>().notNull().default('proposed'),
    statusReason: text('status_reason').notNull().default(''),
    confidence: real('confidence').notNull(),
    impact: text('impact').$type<HypothesisImpact>().notNull(),
    rationale: text('rationale').notNull(),
    evidenceChecks: jsonb('evidence_checks').$type<EvidenceCheck[]>().notNull().default([]),
    checkResults: jsonb('check_results').$type<CheckResult[]>().notNull().default([]),
    candidateCapabilities: jsonb('candidate_capabilities').$type<string[]>().notNull().default([]),
    ranking: jsonb('ranking').$type<HypothesisRanking>(),
    priority: real('priority').notNull().default(0),
    expectedInformationGain: real('expected_information_gain'),
    estimatedCost: text('estimated_cost').$type<'low' | 'medium' | 'high'>(),
    executionRisk: text('execution_risk').$type<RiskClass>(),
    attempts: integer('attempts').notNull().default(0),
    origin: jsonb('origin').$type<HypothesisOrigin>().notNull(),
    review: jsonb('review').$type<{ verdict: HypothesisReviewVerdict; note: string | null; providerId: string | null }>().notNull(),
    history: jsonb('history').$type<HypothesisTransition[]>().notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_hypotheses_dedupe_idx').on(t.engagementId, t.dedupeKey),
    index('security_hypotheses_status_idx').on(t.engagementId, t.status),
    index('security_hypotheses_priority_idx').on(t.engagementId, t.priority),
  ],
)

/** A hypothesis's affected entities, supporting/contradicting observations and gaps (one table, indexed both ways). */
export const securityHypothesisLinks = pgTable(
  'security_hypothesis_links',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    hypothesisId: text('hypothesis_id')
      .notNull()
      .references(() => securityHypotheses.id, { onDelete: 'cascade' }),
    role: text('role').$type<'affects' | 'supports' | 'contradicts' | 'gap'>().notNull(),
    targetType: text('target_type').$type<'node' | 'observation' | 'gap'>().notNull(),
    targetId: text('target_id').notNull(),
    addedBy: text('added_by').$type<'ai' | 'audivra' | 'user'>().notNull(),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_hypothesis_links_unique_idx').on(t.hypothesisId, t.role, t.targetType, t.targetId),
    index('security_hypothesis_links_target_idx').on(t.engagementId, t.targetType, t.targetId),
  ],
)

/** Persistent, bounded reasoning loop state (survives worker restart, session loss and provider change). */
export const securityReasoningRuns = pgTable(
  'security_reasoning_runs',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<ReasoningMode>().notNull(),
    status: text('status').$type<ReasoningRunStatus>().notNull().default('queued'),
    stage: text('stage').$type<ReasoningStage>().notNull().default('ingest'),
    iteration: integer('iteration').notNull().default(0),
    budget: jsonb('budget').$type<ReasoningBudget>().notNull(),
    usage: jsonb('usage').$type<ReasoningUsage>().notNull(),
    stopReason: text('stop_reason').$type<ReasoningStopReason>(),
    stopDetail: text('stop_detail'),
    aiCoverage: text('ai_coverage').$type<AiCoverageState>(),
    decisions: jsonb('decisions').$type<ReasoningDecision[]>().notNull().default([]),
    aiRuns: jsonb('ai_runs').$type<AiRunProvenance[]>().notNull().default([]),
    waitingOn: jsonb('waiting_on').$type<string[]>().notNull().default([]),
    requestedBy: jsonb('requested_by').$type<SecurityActor>().notNull(),
    cancelRequestedAt: ts('cancel_requested_at'),
    leaseOwner: text('lease_owner'),
    heartbeatAt: ts('heartbeat_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('security_reasoning_runs_engagement_idx').on(t.engagementId, t.createdAt), index('security_reasoning_runs_status_idx').on(t.status)],
)

/** Typed next-capability proposals and what became of them (validated, preflighted, executed via the broker). */
export const securityReasoningActions = pgTable(
  'security_reasoning_actions',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => securityReasoningRuns.id, { onDelete: 'cascade' }),
    hypothesisId: text('hypothesis_id').references(() => securityHypotheses.id, { onDelete: 'set null' }),
    capabilityId: text('capability_id').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    actionKey: text('action_key').notNull(),
    expectedEvidence: text('expected_evidence').notNull(),
    reason: text('reason').notNull(),
    status: text('status').$type<ActionStatus>().notNull().default('proposed'),
    statusReason: text('status_reason'),
    decision: jsonb('decision').$type<{ decision: 'allow' | 'deny'; stage: string; rule: string; reason: string }>(),
    executionId: text('execution_id'),
    result: jsonb('result').$type<{ executionStatus: string; observations: number; summary: string | null }>(),
    costClass: text('cost_class').$type<'low' | 'medium' | 'high'>(),
    origin: text('origin').$type<'ai' | 'user'>().notNull().default('ai'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('security_reasoning_actions_engagement_idx').on(t.engagementId, t.createdAt),
    index('security_reasoning_actions_hypothesis_idx').on(t.hypothesisId),
    index('security_reasoning_actions_execution_idx').on(t.executionId),
    index('security_reasoning_actions_key_idx').on(t.engagementId, t.actionKey),
  ],
)

// ── Phase 5 (Step 1): application-semantics domain declarations ─────────────────────────────────────

/**
 * Declared (or source/observation/AI-derived) domain records — identities, roles, tenants, resources,
 * business actions, business states and invariants — that the deterministic domain projector turns into
 * Phase 4 Security Graph nodes and edges with `user-declaration` provenance. One row per (engagement, kind,
 * ref). No secrets live here: an identity's `credentialRef` inside `spec` is an opaque pointer a later
 * credential vault resolves, never credential material, and the projector never copies it onto a graph node.
 */
export const securityDomainDeclarations = pgTable(
  'security_domain_declarations',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<DomainDeclarationKind>().notNull(),
    /** Stable handle, unique per (engagement, kind); other declarations reference this. */
    ref: text('ref').notNull(),
    /** Deterministic graph key this declaration projects to. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    source: text('source').$type<DomainSource>().notNull().default('declared'),
    confidence: real('confidence').notNull().default(1),
    status: text('status').$type<DomainDeclarationStatus>().notNull().default('active'),
    /** Version of this (engagement, kind, ref); an update supersedes the prior version and inserts a new one. */
    version: integer('version').notNull().default(1),
    supersededBy: text('superseded_by'),
    retiredAt: ts('retired_at'),
    /** Typed per kind on write (strict); the `credentialRef` here is a pointer, never a secret. */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: jsonb('created_by').$type<SecurityActor>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Only one ACTIVE version per handle; superseded/retired versions stay for history.
    uniqueIndex('security_domain_declarations_active_ref_idx').on(t.engagementId, t.kind, t.ref).where(sql`status = 'active'`),
    index('security_domain_declarations_key_idx').on(t.engagementId, t.key),
    index('security_domain_declarations_kind_idx').on(t.engagementId, t.kind),
  ],
)

// ── Phase 5 (Step 2): credential / session secret boundary ──────────────────────────────────────────

/**
 * Authorized test credentials. The only secret-bearing value Audivra persists is `sealed` — an
 * AES-256-GCM envelope (`av1.<keyId>.<iv>.<tag>.<ciphertext>`) that is useless without the key, which lives
 * outside the database. Everything else is safe metadata. An identity's `credentialRef` points at `ref`;
 * revoking or deleting a credential never touches the identity. No plaintext secret is ever stored here.
 */
export const securityCredentials = pgTable(
  'security_credentials',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    /** The identity declaration handle this credential is for (null: unbound). */
    identityRef: text('identity_ref'),
    /** The opaque reference an identity's `credentialRef` points to; unique per engagement. */
    ref: text('ref').notNull(),
    type: text('type').$type<CredentialType>().notNull(),
    label: text('label').notNull(),
    status: text('status').$type<CredentialStatus>().notNull().default('active'),
    /** The AES-256-GCM envelope. The only secret-bearing column; opaque without the key. */
    sealed: text('sealed').notNull(),
    /** Non-secret fingerprint of the key that sealed it (for rotation visibility). */
    keyId: text('key_id').notNull(),
    encVersion: integer('enc_version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    expiresAt: ts('expires_at'),
  },
  (t) => [
    uniqueIndex('security_credentials_ref_idx').on(t.engagementId, t.ref),
    index('security_credentials_identity_idx').on(t.engagementId, t.identityRef),
    index('security_credentials_status_idx').on(t.engagementId, t.status),
    index('security_credentials_expiry_idx').on(t.expiresAt),
  ],
)

/**
 * Session metadata, separated from sealed session material (`sealed`: cookies/tokens, encrypted like a
 * credential; null until established in Step 3). Establishing sessions is Step 3; this table only prepares
 * the boundary and the lifecycle state.
 */
export const securitySessions = pgTable(
  'security_sessions',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    identityRef: text('identity_ref').notNull(),
    environment: text('environment').$type<SecurityEnvironment>().notNull(),
    authMethod: text('auth_method').notNull(),
    status: text('status').$type<SessionStatus>().notNull().default('pending'),
    /** Encrypted session material (cookies/tokens), or null when none is held. */
    sealed: text('sealed'),
    keyId: text('key_id'),
    encVersion: integer('enc_version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    refreshedAt: ts('refreshed_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('security_sessions_engagement_idx').on(t.engagementId, t.createdAt),
    index('security_sessions_identity_idx').on(t.engagementId, t.identityRef, t.status),
    index('security_sessions_expiry_idx').on(t.expiresAt),
  ],
)

// ── Phase 5 (Step 4): differential authorization / business-logic comparisons ─────────────────────────

/**
 * A structured differential comparison: identity × resource × action × state, optionally contrasted with a
 * second identity/context. Every reference is to an existing declared entity/session; the result is computed
 * deterministically from evidence (never AI-declared), and a comparison is never itself called a finding.
 */
export const securityComparisons = pgTable(
  'security_comparisons',
  {
    id: text('id').primaryKey(),
    engagementId: text('engagement_id')
      .notNull()
      .references(() => securityEngagements.id, { onDelete: 'cascade' }),
    hypothesisId: text('hypothesis_id'),
    dimension: text('dimension').$type<ComparisonDimension>().notNull(),
    /** Stable key of dimension + arms — redundancy control. */
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    resourceRef: text('resource_ref').notNull(),
    action: text('action').notNull(),
    resourceRelationship: text('resource_relationship').$type<ResourceRelationship>().notNull().default('unknown'),
    invariantRef: text('invariant_ref'),
    status: text('status').$type<ComparisonStatus>().notNull().default('planned'),
    arms: jsonb('arms').$type<ComparisonArm[]>().notNull().default([]),
    controls: jsonb('controls').$type<ComparisonControls>().notNull().default({ positive: false, negative: false }),
    semanticDifferences: jsonb('semantic_differences').$type<SemanticDifference[]>().notNull().default([]),
    state: jsonb('state').$type<BusinessStateChange | null>(),
    result: text('result').$type<ComparisonResult>().notNull().default('not-tested'),
    resultReason: text('result_reason').notNull().default(''),
    confidence: real('confidence').notNull().default(0),
    invariantEvaluation: text('invariant_evaluation').$type<InvariantEvalStatus>(),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default([]),
    cleanupAction: jsonb('cleanup_action').$type<CleanupAction | null>(),
    stateProbe: jsonb('state_probe').$type<{ url: string; expectedTransition: string | null } | null>(),
    cleanup: jsonb('cleanup').$type<CleanupStatus>().notNull().default({ required: false, attempted: false, succeeded: null, detail: null }),
    coverageSampled: boolean('coverage_sampled').notNull().default(false),
    origin: text('origin').$type<'ai' | 'user'>().notNull().default('user'),
    retries: integer('retries').notNull().default(0),
    history: jsonb('history').$type<ComparisonTransition[]>().notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('security_comparisons_dedupe_idx').on(t.engagementId, t.dedupeKey),
    index('security_comparisons_engagement_idx').on(t.engagementId, t.createdAt),
    index('security_comparisons_hypothesis_idx').on(t.engagementId, t.hypothesisId),
    index('security_comparisons_dimension_idx').on(t.engagementId, t.dimension),
    index('security_comparisons_invariant_idx').on(t.engagementId, t.invariantRef),
  ],
)
