import { z } from 'zod'
import { Severity } from './enums.ts'

/*
 * Phase 6D — specialist research-engine integration (Strix). A specialist engine is an OPTIONAL, long-running
 * external research tool that produces structured artifacts. It is NEVER Audivra's authority: it does not
 * decide scope, authorization, verification, findings, paths or history. Audivra constructs every runtime
 * input, runs the engine through its own durable execution / scope / policy boundary, ingests only reviewed
 * STRUCTURED artifacts, and normalizes them into observations/candidates that pass through the Phase 6A
 * verification boundary like any other signal.
 *
 *   Audivra reasoning → specialist capability → Audivra authorization + scope + policy → durable specialist run
 *     → engine → structured artifacts → normalization → observations / candidates → 6A verification → findings
 *
 * A specialist result is a SIGNAL, never a verified finding. Native severity/category are kept as source
 * metadata; they never become Audivra severity, a verified finding, a 6B path edge or a 6C history verdict
 * without going through the respective Audivra boundary. No raw CLI/flags/instructions are ever exposed to a
 * model, and no provider secret is ever stored, logged or placed in the graph.
 */

// ── Engine identity + version pin (§0, §18) ───────────────────────────────────────────────────────────

export const SPECIALIST_ENGINES = ['strix'] as const
export const SpecialistEngineId = z.enum(SPECIALIST_ENGINES)
export type SpecialistEngineId = z.infer<typeof SpecialistEngineId>

/** The reviewed, pinned engine build. Audivra never auto-upgrades; a mismatch requires explicit review. */
export const SpecialistVersionPin = z.object({
  engine: SpecialistEngineId,
  /** The approved CLI/package version (e.g. the `strix-agent` version), reviewed and pinned. */
  cliVersion: z.string(),
  /** The approved sandbox image reference/digest, recorded at setup (never pulled implicitly). */
  sandboxImage: z.string().nullable(),
  /** The Audivra adapter version that normalizes this engine's artifacts. */
  adapterVersion: z.string(),
})
export type SpecialistVersionPin = z.infer<typeof SpecialistVersionPin>

// ── Modes (§6) — start conservatively; live-target is gated by proven containment ────────────────────

export const SPECIALIST_MODES = ['source-only', 'local-controlled-web', 'authorized-staging'] as const
export const SpecialistMode = z.enum(SPECIALIST_MODES)
export type SpecialistMode = z.infer<typeof SpecialistMode>

/** Modes that require Audivra to have PROVEN target-traffic containment before they may run. */
export const SPECIALIST_LIVE_MODES: readonly SpecialistMode[] = ['local-controlled-web', 'authorized-staging']

// ── Availability (§17) — a missing/unconfigured engine degrades gracefully ───────────────────────────

export const SPECIALIST_AVAILABILITY_STATES = ['ready', 'needs-setup', 'missing', 'version-mismatch', 'provider-not-configured', 'docker-unavailable', 'disabled', 'error'] as const
export const SpecialistAvailabilityState = z.enum(SPECIALIST_AVAILABILITY_STATES)
export type SpecialistAvailabilityState = z.infer<typeof SpecialistAvailabilityState>

export const SpecialistAvailability = z.object({
  engine: SpecialistEngineId,
  state: SpecialistAvailabilityState,
  /** The installed engine version, when detectable. */
  installedVersion: z.string().nullable(),
  pin: SpecialistVersionPin.nullable(),
  dockerAvailable: z.boolean(),
  providerConfigured: z.boolean(),
  /** Which modes are currently permitted (source-only is the safe default; live modes need proven containment). */
  enabledModes: z.array(SpecialistMode),
  reason: z.string(),
  checkedAt: z.string(),
})
export type SpecialistAvailability = z.infer<typeof SpecialistAvailability>

// ── Budget (§20) — Audivra-derived; the model/user never supplies raw budget flags ──────────────────

export const SpecialistBudget = z.object({
  wallClockMs: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  maxArtifactBytes: z.number().int().positive(),
  /** The deterministic scan mode passed to the engine (chosen by Audivra policy, not the model). */
  scanMode: z.enum(['quick', 'standard', 'deep']),
})
export type SpecialistBudget = z.infer<typeof SpecialistBudget>

// ── Targets (§13) — constructed by Audivra, classified against engagement scope ──────────────────────

export const SPECIALIST_TARGET_KINDS = ['staged-source', 'url', 'repository', 'api-spec'] as const
export const SpecialistTargetKind = z.enum(SPECIALIST_TARGET_KINDS)
export type SpecialistTargetKind = z.infer<typeof SpecialistTargetKind>

export const SpecialistTarget = z.object({
  kind: SpecialistTargetKind,
  /** The concrete value the engine receives (a staged path, an in-scope URL, …). */
  value: z.string(),
  /** The graph entity/asset key this target maps to, when known. */
  assetKey: z.string().nullable(),
  /** Audivra's scope decision for this target — only in-scope targets are ever passed to the engine. */
  inScope: z.boolean(),
})
export type SpecialistTarget = z.infer<typeof SpecialistTarget>

// ── Run config (Audivra builds this; never from a model/user as raw args) (§4, §5) ───────────────────

export const SpecialistRunConfig = z.object({
  engine: SpecialistEngineId,
  mode: SpecialistMode,
  targets: z.array(SpecialistTarget),
  budget: SpecialistBudget,
  /** The id of a trusted provider profile resolved OUTSIDE AI-visible state; never the secret itself. */
  providerProfileId: z.string().nullable(),
  /** The Audivra execution-owned network this run's sandbox must use (live modes only). */
  executionNetwork: z.string().nullable(),
  /** The execution-owned staged source workspace (source-aware modes). */
  stagedSourceRef: z.string().nullable(),
})
export type SpecialistRunConfig = z.infer<typeof SpecialistRunConfig>

// ── Native structured results (kept as source metadata; never Audivra truth) (§24-§28) ──────────────

export const SPECIALIST_COMPLETIONS = ['completed', 'partial', 'budget-stopped', 'cancelled', 'failed', 'provider-unavailable'] as const
export const SpecialistCompletion = z.enum(SPECIALIST_COMPLETIONS)
export type SpecialistCompletion = z.infer<typeof SpecialistCompletion>

/** An evidence pointer an engine produced (an HTTP exchange, a source location, a screenshot, …). */
export const SpecialistEvidenceRef = z.object({
  kind: z.enum(['http', 'source-location', 'url', 'screenshot', 'request-response', 'artifact', 'other']),
  label: z.string(),
  /** A relative artifact path inside the run workspace, when the evidence is a file. */
  artifactPath: z.string().nullable(),
  detail: z.string(),
})
export type SpecialistEvidenceRef = z.infer<typeof SpecialistEvidenceRef>

/** One native vulnerability the engine reported. Native severity/category are SOURCE metadata only. */
export const SpecialistVulnerability = z.object({
  /** The engine's own id for the result (stable within a run). */
  nativeId: z.string(),
  title: z.string(),
  /** The engine's own severity label — retained, never copied into Audivra severity. */
  nativeSeverity: z.string(),
  /** The engine's own category (OWASP / CWE / its taxonomy). */
  nativeCategory: z.string(),
  /** Whether the engine claims it validated the issue (a claim, never Audivra verification). */
  engineValidated: z.boolean(),
  affected: z.object({ url: z.string().nullable(), sourcePath: z.string().nullable(), apiOperation: z.string().nullable(), assetHint: z.string().nullable() }),
  evidence: z.array(SpecialistEvidenceRef),
  /** Engine prose (UNTRUSTED specialist output — never interpreted as instructions or copied into facts). */
  description: z.string(),
  reproduction: z.string().nullable(),
})
export type SpecialistVulnerability = z.infer<typeof SpecialistVulnerability>

/** The reviewed structured artifact Audivra ingests. The fake engine and the real Strix adapter both produce this. */
export const SPECIALIST_ARTIFACT_SCHEMA_VERSION = 'audivra.specialist.v1'
export const SpecialistArtifact = z.object({
  schemaVersion: z.literal(SPECIALIST_ARTIFACT_SCHEMA_VERSION),
  engine: SpecialistEngineId,
  engineVersion: z.string(),
  runId: z.string(),
  mode: SpecialistMode,
  completion: SpecialistCompletion,
  /** Engine-reported coverage/run metadata (what it did), kept as-is. */
  coverageNote: z.string(),
  vulnerabilities: z.array(SpecialistVulnerability),
  /** Provider metadata that is SAFE to retain (model name, usage) — never a key/secret. */
  providerMeta: z.object({ model: z.string().nullable(), costUsd: z.number().nullable(), turns: z.number().int().nullable() }),
})
export type SpecialistArtifact = z.infer<typeof SpecialistArtifact>

// ── Import linkage (§26-§30) — how each native result mapped into Audivra ────────────────────────────

export const SPECIALIST_IMPORT_ACTIONS = ['observation-created', 'merged-existing', 'knowledge-gap', 'out-of-scope-dropped', 'unsupported-dropped'] as const
export const SpecialistImportAction = z.enum(SPECIALIST_IMPORT_ACTIONS)
export type SpecialistImportAction = z.infer<typeof SpecialistImportAction>

export const SpecialistImport = z.object({
  nativeId: z.string(),
  title: z.string(),
  nativeSeverity: z.string(),
  action: SpecialistImportAction,
  /** The graph entity this result was attached to (null when a gap was raised instead). */
  matchedEntityKey: z.string().nullable(),
  observationId: z.string().nullable(),
  /** A candidate this signal corroborated/merged into (via the existing 6A dedupe), when any. */
  candidateIssueKey: z.string().nullable(),
  reason: z.string(),
})
export type SpecialistImport = z.infer<typeof SpecialistImport>

// ── The durable specialist run (§21) ──────────────────────────────────────────────────────────────────

export const SPECIALIST_RUN_STATES = ['requested', 'preparing', 'running', 'collecting', 'completed', 'partial', 'budget-stopped', 'cancelled', 'failed', 'unavailable'] as const
export const SpecialistRunState = z.enum(SPECIALIST_RUN_STATES)
export type SpecialistRunState = z.infer<typeof SpecialistRunState>

export const SpecialistRun = z.object({
  id: z.string(),
  engagementId: z.string(),
  engine: SpecialistEngineId,
  engineVersion: z.string().nullable(),
  adapterVersion: z.string(),
  mode: SpecialistMode,
  /** The Audivra durable execution that owns the subprocess / sandbox / workspace. */
  executionId: z.string().nullable(),
  targets: z.array(SpecialistTarget),
  /** Provider profile id + model only — never a secret. */
  providerProfileId: z.string().nullable(),
  providerModel: z.string().nullable(),
  state: SpecialistRunState,
  completion: SpecialistCompletion.nullable(),
  stateReason: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  terminationReason: z.string().nullable(),
  /** Bounded references to the stored raw artifacts (evidence refs). */
  artifactRefs: z.array(z.string()),
  costUsd: z.number().nullable(),
  turns: z.number().int().nullable(),
  /** Counts of what ingestion produced. */
  imported: z.object({ vulnerabilities: z.number().int(), observations: z.number().int(), merged: z.number().int(), gaps: z.number().int(), outOfScope: z.number().int() }),
  imports: z.array(SpecialistImport),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SpecialistRun = z.infer<typeof SpecialistRun>

// ── Read views & coverage (§33, §36) ──────────────────────────────────────────────────────────────────

/** A specialist signal: one imported native result, with the Audivra objects it became (candidate/finding). */
export const SpecialistSignal = z.object({
  runId: z.string(),
  nativeId: z.string(),
  title: z.string(),
  nativeSeverity: z.string(),
  nativeCategory: z.string(),
  action: SpecialistImportAction,
  matchedEntityKey: z.string().nullable(),
  observationId: z.string().nullable(),
  candidateIssueKey: z.string().nullable(),
  /** The Audivra finding (and its verification state) this signal eventually corroborated, when any. */
  finding: z.object({ id: z.string(), title: z.string(), severity: Severity, verificationState: z.string() }).nullable(),
})
export type SpecialistSignal = z.infer<typeof SpecialistSignal>

/** Specialist coverage, kept SEPARATE from Audivra's deterministic-sensor coverage (§33). */
export const SpecialistCoverage = z.object({
  engine: SpecialistEngineId,
  runs: z.object({ total: z.number().int(), byState: z.record(z.string(), z.number().int()), byCompletion: z.record(z.string(), z.number().int()) }),
  signals: z.object({ total: z.number().int(), observations: z.number().int(), merged: z.number().int(), gaps: z.number().int(), corroboratedFindings: z.number().int() }),
  /** A clean specialist run never means the application is secure — surfaced explicitly. */
  caveat: z.string(),
})
export type SpecialistCoverage = z.infer<typeof SpecialistCoverage>

export const SpecialistRunDetail = z.object({
  run: SpecialistRun,
  signals: z.array(SpecialistSignal),
  artifacts: z.array(z.object({ ref: z.string(), type: z.string(), title: z.string() })),
})
export type SpecialistRunDetail = z.infer<typeof SpecialistRunDetail>

// ── API input (§35) — typed, no raw args/flags/instructions ──────────────────────────────────────────

export const RequestSpecialistRunInput = z.strictObject({
  engine: SpecialistEngineId.default('strix'),
  mode: SpecialistMode.default('source-only'),
  /** What to research: existing finding ids to deepen, resource refs to study, or a staged source ref. */
  findingIds: z.array(z.string().max(120)).max(32).default([]),
  resourceRefs: z.array(z.string().max(200)).max(64).default([]),
  stagedSourceRef: z.string().max(400).nullable().default(null),
  /** An allowlisted focus hint (NOT free-form instructions to the engine). */
  focus: z.enum(['broad', 'authorization', 'injection', 'source-review']).default('broad'),
})
export type RequestSpecialistRunInput = z.infer<typeof RequestSpecialistRunInput>

// ── Planner metadata (§37, §38) — how reasoning may propose the specialist ───────────────────────────

export const SpecialistPlannerMetadata = z.object({
  engine: SpecialistEngineId,
  capabilityId: z.string(),
  costClass: z.enum(['low', 'medium', 'high', 'very-high']),
  typicalDurationSeconds: z.number().int(),
  supportedTargetKinds: z.array(SpecialistTargetKind),
  requiredEnvironments: z.array(z.string()),
  /** The kind of uncertainty broad specialist research is worth spending on (never the default action). */
  expectedInformationGain: z.string(),
})
export type SpecialistPlannerMetadata = z.infer<typeof SpecialistPlannerMetadata>
