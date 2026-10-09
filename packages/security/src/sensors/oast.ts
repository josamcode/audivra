import { randomUUID } from 'node:crypto'
import type { ObservationScopeClass } from '@audivra/contracts'
import type { RecordObservationInput } from '../capabilities/types.ts'

/*
 * OAST (out-of-band application security testing) provider abstraction.
 *
 * Phase 3B implements the *abstraction* and a deterministic, in-process provider for tests. It does NOT
 * stand up or depend on any shared/public OAST infrastructure (e.g. the public Interactsh servers) — doing
 * so for a sensitive assessment would leak target information to third-party infrastructure. Running a
 * *private* OAST service is a concrete next step, deferred here deliberately.
 *
 * The abstraction fixes the contract an eventual private deployment must satisfy: per-execution
 * correlation ids, expiration, execution ownership (only the owning execution may poll/release), bounded
 * storage, private configuration, and a clean mapping from an interaction to an `oast-interaction`
 * observation (so OAST evidence links like any other sensor signal).
 */

export interface OastHandle {
  /** The correlation id a sensor embeds in payloads; interactions are matched back to it. */
  correlationId: string
  /** The payload host/domain a sensor would use. The local provider returns a non-routable placeholder. */
  payloadDomain: string
  issuedAt: string
  expiresAt: string
}

export const OAST_PROTOCOLS = ['dns', 'http', 'smtp', 'ldap'] as const
export type OastProtocol = (typeof OAST_PROTOCOLS)[number]

export interface OastInteraction {
  correlationId: string
  protocol: OastProtocol
  /** The remote address that caused the interaction, when known. */
  remoteAddress: string | null
  at: string
  detail: string | null
}

/** A provider mints correlation ids and collects interactions for them. A real one wraps a private service. */
export interface OastProvider {
  readonly id: string
  /** Mint a correlation id owned by this execution, valid for `ttlSeconds`. */
  register(executionId: string, ttlSeconds?: number): Promise<OastHandle>
  /** Interactions seen for a correlation id — only for the owning execution, only before expiry. */
  poll(executionId: string, correlationId: string): Promise<OastInteraction[]>
  /** Release every correlation id this execution owns (bounded cleanup). */
  release(executionId: string): Promise<void>
}

const DEFAULT_TTL = 900
const MAX_INTERACTIONS_PER_ID = 200
const MAX_IDS = 1000

/**
 * A deterministic, in-process OAST provider for tests and local development. No network, no external
 * infrastructure: a test injects interactions directly. It enforces ownership, expiry and bounded storage
 * exactly as a real provider must, so sensors and tests can be written against the real contract now.
 */
export class DeterministicLocalOastProvider implements OastProvider {
  readonly id = 'local-deterministic'
  readonly #now: () => number
  readonly #records = new Map<string, { executionId: string; expiresAt: number; interactions: OastInteraction[] }>()

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  async register(executionId: string, ttlSeconds = DEFAULT_TTL): Promise<OastHandle> {
    this.#evictExpired()
    if (this.#records.size >= MAX_IDS) throw new Error('OAST provider is at capacity')
    const correlationId = randomUUID().replace(/-/g, '').slice(0, 24)
    const now = this.#now()
    const expiresAt = now + ttlSeconds * 1000
    this.#records.set(correlationId, { executionId, expiresAt, interactions: [] })
    // `.oast.local` is a reserved, non-routable placeholder — never a real, reachable host.
    return { correlationId, payloadDomain: `${correlationId}.oast.local`, issuedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString() }
  }

  async poll(executionId: string, correlationId: string): Promise<OastInteraction[]> {
    const record = this.#records.get(correlationId)
    if (!record) return []
    if (record.executionId !== executionId) throw new Error('OAST correlation id does not belong to this execution')
    if (this.#now() > record.expiresAt) return []
    return [...record.interactions]
  }

  async release(executionId: string): Promise<void> {
    for (const [id, record] of this.#records) if (record.executionId === executionId) this.#records.delete(id)
  }

  /** Test affordance: simulate an out-of-band interaction against a correlation id. */
  inject(correlationId: string, interaction: Omit<OastInteraction, 'correlationId' | 'at'> & { at?: string }): void {
    const record = this.#records.get(correlationId)
    if (!record) throw new Error(`Unknown OAST correlation id: ${correlationId}`)
    if (record.interactions.length >= MAX_INTERACTIONS_PER_ID) return // bounded storage
    record.interactions.push({ correlationId, protocol: interaction.protocol, remoteAddress: interaction.remoteAddress ?? null, at: interaction.at ?? new Date(this.#now()).toISOString(), detail: interaction.detail ?? null })
  }

  #evictExpired(): void {
    const now = this.#now()
    for (const [id, record] of this.#records) if (now > record.expiresAt) this.#records.delete(id)
  }
}

/**
 * Maps one OAST interaction to the observation input a sensor records through `handles.observations`. The
 * asset is the correlation id (the out-of-band channel); the remote address, when known, is scope-
 * classified by the caller — a callback from an out-of-scope address is still recorded (discovery), never
 * an authorization to contact it.
 */
export function oastInteractionObservation(interaction: OastInteraction, scopeClass: ObservationScopeClass | null, evidenceRef: string | null): RecordObservationInput {
  return {
    type: 'oast-interaction',
    asset: `oast://${interaction.correlationId}`,
    subject: `${interaction.protocol} ${interaction.remoteAddress ?? 'unknown'}`,
    title: `OAST ${interaction.protocol} interaction${interaction.remoteAddress ? ` from ${interaction.remoteAddress}` : ''}`,
    scopeClass,
    sourceType: 'tool-reported',
    value: { protocol: interaction.protocol, remoteAddress: interaction.remoteAddress, detail: interaction.detail, at: interaction.at },
    evidenceRef,
    confidence: 1,
  }
}
