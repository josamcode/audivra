import { z } from 'zod'
import { authorizationRequiredFor, SecurityCapabilityMetadata } from '@audivra/contracts'
import type { SecurityCapability } from './types.ts'

export class CapabilityRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapabilityRegistrationError'
  }
}

/**
 * Explicit registry of security capabilities. Registration validates metadata, refuses duplicate IDs
 * and refuses declarations that understate their need for authorization. Lookups return frozen
 * metadata, so policy always sees exactly what was registered.
 */
export class CapabilityRegistry {
  readonly #capabilities = new Map<string, SecurityCapability>()

  register<I, O>(capability: SecurityCapability<I, O>): this {
    const parsed = SecurityCapabilityMetadata.safeParse(capability.metadata)
    if (!parsed.success) {
      throw new CapabilityRegistrationError(`Invalid metadata for ${String(capability.metadata?.id)}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
    }
    const metadata = parsed.data
    if (this.#capabilities.has(metadata.id)) throw new CapabilityRegistrationError(`Capability ${metadata.id} is already registered`)
    if (authorizationRequiredFor({ ...metadata, requiresAuthorization: false }) && !metadata.requiresAuthorization) {
      throw new CapabilityRegistrationError(`${metadata.id} is ${metadata.riskClass} / ${metadata.sideEffect} and must declare requiresAuthorization`)
    }
    const implementation = capability.implementation
    if (!implementation || implementation.id !== metadata.implementation) {
      throw new CapabilityRegistrationError(`${metadata.id}: implementation id must be "${metadata.implementation}"`)
    }
    if (typeof implementation.execute !== 'function' || typeof implementation.targets !== 'function' || !(implementation.input instanceof z.ZodType)) {
      throw new CapabilityRegistrationError(`${metadata.id}: implementation must provide input, targets and execute`)
    }
    this.#capabilities.set(metadata.id, {
      metadata: Object.freeze({ ...metadata }) as SecurityCapabilityMetadata,
      implementation: implementation as SecurityCapability['implementation'],
    })
    return this
  }

  get(id: string): SecurityCapability | undefined {
    return this.#capabilities.get(id)
  }

  has(id: string): boolean {
    return this.#capabilities.has(id)
  }

  /** Policy metadata of every capability, sorted by id. */
  list(): SecurityCapabilityMetadata[] {
    return [...this.#capabilities.values()].map((c) => c.metadata).sort((a, b) => a.id.localeCompare(b.id))
  }

  /** What a model may be told about the capabilities it can *request* (never execute directly). */
  describeForAgents(): { id: string; name: string; description: string; riskClass: string; sideEffect: string; input: unknown }[] {
    return [...this.#capabilities.values()]
      .sort((a, b) => a.metadata.id.localeCompare(b.metadata.id))
      .map(({ metadata, implementation }) => ({
        id: metadata.id,
        name: metadata.name,
        description: metadata.description,
        riskClass: metadata.riskClass,
        sideEffect: metadata.sideEffect,
        input: z.toJSONSchema(implementation.input, { io: 'input', unrepresentable: 'any' }),
      }))
  }
}
