import { z } from 'zod'

/*
 * Security observations: normalized, evidence-backed facts a sensor (an approved external tool, run as a
 * capability) reported about an engagement's assets. An observation is NOT a finding — it is a signal
 * that a later reasoning/verification layer may correlate and act on. The raw tool output is always kept
 * as bounded evidence; the observation is the queryable, deduplicated projection that points back to it.
 *
 *   tool output ─► normalized observation ─► evidence (raw artifact) ─► later correlation / verification
 */

export const OBSERVATION_TYPES = [
  /** A technology/framework/server detected on an asset. */
  'technology',
  /** A URL or route discovered (crawl). */
  'endpoint',
  /** An HTTP response characteristic (status, title, length) of an asset. */
  'http-response',
  /** A response header of note. */
  'http-header',
  /** A redirect observed from one URL to another. */
  'redirect',
  /** A form/input surface discovered. */
  'form',
  /** A TLS/certificate configuration signal. */
  'tls-config',
  /** A dependency/package detected. */
  'dependency',
  /** A source-code pattern a static analyser matched. */
  'source-finding',
  /** A network service/port characteristic. */
  'service',
  // ── Phase 3B: dynamic / API families ─────────────────────────────────────────────────────────────
  /** An API operation (method + path) discovered from a schema or exercised. */
  'api-operation',
  /** An API request/response that diverged from its contract (schema/validation mismatch, unexpected class). */
  'api-validation',
  /** A multi-request API state/workflow signal. */
  'api-workflow',
  /** A dynamic web security signal from a scanner (a template/rule matched); a signal, never a verdict. */
  'web-signal',
  /** An out-of-band interaction observed through an OAST correlation id. */
  'oast-interaction',
  /** A captured HTTP request/response flow (traffic observation / replay source). */
  'traffic-flow',
  /** A vulnerability signal against a detected dependency (version/advisory match); a signal, not a verdict. */
  'dependency-vulnerability',
] as const
export const ObservationType = z.enum(OBSERVATION_TYPES)
export type ObservationType = z.infer<typeof ObservationType>

/**
 * Coarse families for grouping observations in the read API and UI, independent of which tool produced
 * them. A family is derived from the type, never stored.
 */
export const OBSERVATION_FAMILIES = ['web', 'api', 'tls', 'traffic', 'dependency', 'source', 'oast', 'discovery'] as const
export const ObservationFamily = z.enum(OBSERVATION_FAMILIES)
export type ObservationFamily = z.infer<typeof ObservationFamily>

const TYPE_FAMILY: Record<ObservationType, ObservationFamily> = {
  technology: 'web',
  endpoint: 'discovery',
  'http-response': 'web',
  'http-header': 'web',
  redirect: 'discovery',
  form: 'web',
  'web-signal': 'web',
  'api-operation': 'api',
  'api-validation': 'api',
  'api-workflow': 'api',
  'tls-config': 'tls',
  'traffic-flow': 'traffic',
  'oast-interaction': 'oast',
  dependency: 'dependency',
  'dependency-vulnerability': 'dependency',
  'source-finding': 'source',
  service: 'discovery',
}

export function observationFamily(type: ObservationType): ObservationFamily {
  return TYPE_FAMILY[type]
}

/**
 * Where a discovered destination sits relative to the engagement scope. Derived from the Phase 1 scope
 * engine (`primary`/`dependency`/`third-party`/`excluded`/`invalid`), never from the tool. A discovered
 * target is never automatically authorized: only `in-scope` destinations are eligible for later
 * capabilities.
 */
export const OBSERVATION_SCOPE_CLASSES = ['in-scope', 'out-of-scope', 'third-party', 'unknown'] as const
export const ObservationScopeClass = z.enum(OBSERVATION_SCOPE_CLASSES)
export type ObservationScopeClass = z.infer<typeof ObservationScopeClass>

/**
 * How the signal was arrived at — the basis for confidence, not a tool's marketing severity. A tool's own
 * severity never becomes Audivra's confidence or severity; the source type does.
 *
 *   tool-reported   a direct, deterministic observation the tool read off the wire/response
 *   tool-inferred   a fingerprint/classification (e.g. Wappalyzer technology)
 *   tool-heuristic  a scanner heuristic / template match — a suspicion to verify, not a fact
 *   version-inferred a suspicion derived from a detected version matching an advisory/range
 *   derived         computed by Audivra from other observations
 */
export const OBSERVATION_SOURCE_TYPES = ['tool-reported', 'tool-inferred', 'tool-heuristic', 'version-inferred', 'derived'] as const
export const ObservationSourceType = z.enum(OBSERVATION_SOURCE_TYPES)
export type ObservationSourceType = z.infer<typeof ObservationSourceType>

/**
 * Confidence rubric (documented, not auto-derived from a tool's severity field). An adapter picks a
 * confidence consistent with its source type; corroboration from independent sensors is represented by
 * multiple contributions on one observation (the reasoning layer in a later phase weighs them).
 */
export const CONFIDENCE_BY_SOURCE: Record<ObservationSourceType, number> = {
  'tool-reported': 1,
  'tool-inferred': 0.8,
  'tool-heuristic': 0.5,
  'version-inferred': 0.4,
  derived: 0.6,
}

/**
 * One sensor's contribution to an observation. Several of these accumulate on a deduplicated observation
 * so provenance from every tool/run that reported the same thing is retained.
 */
export const ObservationContribution = z.object({
  executionId: z.string(),
  capabilityId: z.string(),
  tool: z.string(),
  /** Exact version of the sensor that produced it — the pinned image reference (digest) is authoritative. */
  toolVersion: z.string(),
  /** Evidence (`EV-n`) that backs this contribution; the raw artifact is reachable through it. */
  evidenceRef: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  at: z.string(),
})
export type ObservationContribution = z.infer<typeof ObservationContribution>

export const SecurityObservation = z.object({
  id: z.string(),
  engagementId: z.string(),
  /** Stable key for deduplication: `type:asset:subject` (normalized), unique per engagement. */
  dedupeKey: z.string(),
  type: ObservationType,
  /** The asset the observation is about (a URL, host, file path, …), normalized. */
  asset: z.string(),
  /** The normalized subject within the asset (a technology name, header name, route, rule id, …). */
  subject: z.string(),
  /** Short human-facing title. */
  title: z.string(),
  /** Scope classification for discovered destinations; null when not applicable. */
  scopeClass: ObservationScopeClass.nullable(),
  /** Small structured detail (bounded); the full tool output stays in evidence. */
  value: z.record(z.string(), z.unknown()),
  sourceType: ObservationSourceType,
  /** Highest confidence across contributions. */
  confidence: z.number().min(0).max(1),
  /** Evidence refs (`EV-n`) supporting this observation, across all contributions. */
  evidenceRefs: z.array(z.string()),
  /** Every tool/run that reported this observation (provenance retained on dedup). */
  contributions: z.array(ObservationContribution),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
})
export type SecurityObservation = z.infer<typeof SecurityObservation>

// ── Sensor execution result states ───────────────────────────────────────────────────────────────────

/**
 * How a sensor run turned out, for coverage. `partial` (some output, bounded or truncated) must never be
 * reported as a complete assessment, and a sensor that ran successfully never means "no issue exists".
 */
export const SENSOR_RESULT_STATES = ['success', 'partial', 'failed', 'unavailable', 'skipped'] as const
export const SensorResultState = z.enum(SENSOR_RESULT_STATES)
export type SensorResultState = z.infer<typeof SensorResultState>

/**
 * Maps a sensor's own result state to the shared coverage vocabulary (`CoverageStatus`), so sensor
 * coverage reads the same way as the Website Audit's capability coverage. A sensor that has not run for an
 * engagement is reported as `skipped` (nothing ran), never silently omitted.
 */
export const sensorStateToCoverage: Record<SensorResultState, 'ran' | 'partial' | 'skipped' | 'failed' | 'unavailable'> = {
  success: 'ran',
  partial: 'partial',
  skipped: 'skipped',
  failed: 'failed',
  unavailable: 'unavailable',
}

/**
 * Sensor coverage states. A superset of what the shared `CoverageStatus` carries, so sensor coverage can
 * say *why* a sensor did not run — never run (`skipped`), its input is absent (`missing-input`, e.g. no API
 * schema), it is not allowed in this environment/policy (`blocked`), its tool/runtime is absent
 * (`unavailable`), or it does not apply at all (`not-applicable`). "Not run" is never read as "secure".
 */
export const SENSOR_COVERAGE_STATES = ['ran', 'partial', 'failed', 'skipped', 'unavailable', 'missing-input', 'blocked', 'not-applicable'] as const
export const SensorCoverageState = z.enum(SENSOR_COVERAGE_STATES)
export type SensorCoverageState = z.infer<typeof SensorCoverageState>

/** Coverage of one sensor for an engagement, derived from its most recent execution and eligibility. */
export const SensorCoverageItem = z.object({
  capabilityId: z.string(),
  name: z.string(),
  tool: z.string(),
  family: ObservationFamily,
  status: SensorCoverageState,
  lastExecutionId: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  observations: z.number().int(),
  reason: z.string().nullable(),
})
export type SensorCoverageItem = z.infer<typeof SensorCoverageItem>

/** The structured result a sensor adapter returns from one execution. */
export const SensorResult = z.object({
  state: SensorResultState,
  tool: z.string(),
  toolVersion: z.string(),
  /** Count of normalized observations recorded. */
  observations: z.number().int(),
  /** Short note (what ran, what was bounded, why it was partial/failed). */
  summary: z.string(),
  /** Reason it was not a full success; null on success. */
  reason: z.string().nullable(),
})
export type SensorResult = z.infer<typeof SensorResult>
