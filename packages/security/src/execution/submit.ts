import type { Logger } from '@audivra/config'
import type { SecurityActor } from '@audivra/contracts'
import type { Db, PgBoss } from '@audivra/database'
import { CapabilityBroker, type SubmitOutcome } from '../broker.ts'
import { createRuntimeRegistry } from '../capabilities/catalog.ts'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import type { Resolver } from '../dns.ts'
import type { ExecutionAuthResolver } from '../session/auth-resolver.ts'
import { VaultAuthResolver } from '../session/auth-resolver.ts'
import { createDbSecurityStore } from '../store.ts'
import { createSecretVault } from '../vault/vault.ts'
import { createBossExecutionQueue, createDbExecutionStore } from './store.ts'

/** A capability broker that accepts durable executions into PostgreSQL and the pg-boss queue. */
export function createDurableBroker(options: { db: Db; boss: PgBoss; registry?: CapabilityRegistry; resolver?: Resolver; authResolver?: ExecutionAuthResolver; log?: Logger }): CapabilityBroker {
  return new CapabilityBroker({
    registry: options.registry ?? createRuntimeRegistry(),
    store: createDbSecurityStore(options.db),
    resolver: options.resolver,
    // Identity-aware decisions validate the referenced session at decision time (no secret touched).
    authResolver: options.authResolver ?? new VaultAuthResolver({ db: options.db, vault: createSecretVault(options.db, { log: options.log }) }),
    log: options.log,
    executions: { store: createDbExecutionStore(options.db), queue: createBossExecutionQueue(options.boss) },
  })
}

/**
 * Requests the harmless runtime check for an engagement through the broker — the same decision path as
 * any capability. Its target is the engagement's own URL, which is scope-checked but never contacted.
 */
export function submitRuntimeCheck(
  broker: CapabilityBroker,
  request: { engagementId: string; targetUrl: string; holdSeconds?: number; note?: string; actor: SecurityActor },
): Promise<SubmitOutcome> {
  return broker.submit({
    engagementId: request.engagementId,
    capabilityId: 'diagnostic.runtime-check',
    input: { target: request.targetUrl, ...(request.holdSeconds !== undefined ? { holdSeconds: request.holdSeconds } : {}), ...(request.note ? { note: request.note } : {}) },
    actor: request.actor,
  })
}
