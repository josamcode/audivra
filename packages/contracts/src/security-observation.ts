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
] as const
export const ObservationType = z.enum(OBSERVATION_TYPES)
export type ObservationType = z.infer<typeof ObservationType>

/**
 * Where a discovered destination sits relative to the engagement scope. Derived from the Phase 1 scope
 * engine (`primary`/`dependency`/`third-party`/`excluded`/`invalid`), never from the tool. A discovered
 * target is never automatically authorized: only `in-scope` destinations are eligible for later
 * capabilities.
 */
export const OBSERVATION_SCOPE_CLASSES = ['in-scope', 'out-of-scope', 'third-party', 'unknown'] as const
export const ObservationScopeClass = z.enum(OBSERVATION_SCOPE_CLASSES)
export type ObservationScopeClass = z.infer<typeof ObservationScopeClass>

/** How confident the normalization is in the observation (a signal, not a verdict). */
export const OBSERVATION_SOURCE_TYPES = ['tool-reported', 'tool-inferred', 'derived'] as const
export const ObservationSourceType = z.enum(OBSERVATION_SOURCE_TYPES)
export type ObservationSourceType = z.infer<typeof ObservationSourceType>

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

/** Coverage of one sensor for an engagement, derived from its most recent execution. */
export const SensorCoverageItem = z.object({
  capabilityId: z.string(),
  name: z.string(),
  tool: z.string(),
  /** `skipped` when the sensor has never run for this engagement. */
  status: z.enum(['ran', 'partial', 'skipped', 'failed', 'unavailable']),
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
