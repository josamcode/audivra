import type { Logger } from '@audivra/config'
import type { SpecialistArtifact, SpecialistAvailability, SpecialistEngineId, SpecialistRunConfig, SpecialistVersionPin } from '@audivra/contracts'

/*
 * Phase 6D — the Specialist Engine abstraction. It represents an OPTIONAL, long-running external research
 * engine that produces structured artifacts. It is deliberately small: it is NOT a general execution
 * framework. Everything an engine needs that is security-relevant (the target set, budget, provider profile,
 * network, workspace, execution id for ownership, cancellation signal) is constructed by Audivra and handed
 * in; the engine only runs and returns a reviewed structured artifact, then cleans up EXACTLY its own
 * resources. It never decides scope, authorization, verification or findings.
 */

export interface SpecialistRunContext {
  engagementId: string
  /** The Audivra execution id that owns this run's subprocess/sandbox/workspace. */
  executionId: string
  config: SpecialistRunConfig
  /** The execution-owned workspace directory (artifacts are written here, under Audivra's budget). */
  workspaceDir: string
  /** Abort → stop the run and its owned resources (Audivra cancellation / timeout). */
  signal: AbortSignal
  log?: Logger
}

export interface SpecialistCleanupResult {
  /** Exactly the resources this execution owned that were removed (ids/names). */
  removed: string[]
  /** Any resources that appeared attributable to this run but were NOT owned as expected (a red flag). */
  unownedFound: string[]
}

export interface SpecialistEngine {
  readonly id: SpecialistEngineId
  /** Whether the engine is installed, pinned, provider-configured and Docker-ready; degrades gracefully. */
  availability(opts: { pin: SpecialistVersionPin | null; providerConfigured: boolean; dockerAvailable: boolean }): Promise<SpecialistAvailability>
  /** Prepare → start → collect, honoring `ctx.signal` for cancellation/timeout. Returns a structured artifact. */
  run(ctx: SpecialistRunContext): Promise<SpecialistArtifact>
  /** Remove exactly this execution's owned resources (never a wildcard/global prune). */
  cleanup(ctx: Pick<SpecialistRunContext, 'engagementId' | 'executionId' | 'workspaceDir' | 'config'> & { log?: Logger }): Promise<SpecialistCleanupResult>
}

/** The set of enabled modes for a given availability — source-only is always safe; live modes need proven containment. */
export function enabledModesFor(opts: { dockerAvailable: boolean; providerConfigured: boolean; liveContainmentProven: boolean }): SpecialistArtifact['mode'][] {
  if (!opts.dockerAvailable || !opts.providerConfigured) return []
  return opts.liveContainmentProven ? ['source-only', 'local-controlled-web', 'authorized-staging'] : ['source-only']
}
