import { z } from 'zod'
import { authorizationRequiredFor, capabilityExecution, SecurityCapabilityMetadata } from '@audivra/contracts'
import { executorProgramPath } from '../execution/executors.ts'
import { findApprovedRuntime } from '../execution/runtimes.ts'
import type { CapabilityImplementation, SecurityCapability } from './types.ts'

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
    if (typeof implementation.targets !== 'function' || !(implementation.input instanceof z.ZodType)) {
      throw new CapabilityRegistrationError(`${metadata.id}: implementation must provide input and targets`)
    }
    checkExecutionShape(metadata, implementation as CapabilityImplementation)
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

/**
 * The implementation must match the declared execution mode exactly. In particular an isolated-container
 * capability has no in-process `execute`, so no code path can run it outside its container.
 */
function checkExecutionShape(metadata: SecurityCapabilityMetadata, implementation: CapabilityImplementation): void {
  const fail = (reason: string) => {
    throw new CapabilityRegistrationError(`${metadata.id}: ${reason}`)
  }
  const execution = capabilityExecution(metadata)
  if (execution.mode === 'in-process') {
    if (typeof implementation.execute !== 'function') fail('an in-process capability must provide execute')
    if (implementation.program !== undefined || implementation.collect !== undefined) fail('an in-process capability has no executor program')
    return
  }
  if (implementation.execute !== undefined) fail('an isolated-container capability must not provide an in-process execute')
  const runtime = findApprovedRuntime(execution.runtime)
  if (!runtime) fail(`runtime ${String(execution.runtime)} is not an approved runtime`)
  if (runtime!.kind === 'tool') {
    // A sensor capability runs an approved tool with Audivra-built arguments; no reviewed node program.
    if (typeof implementation.toolArgs !== 'function' || typeof implementation.collect !== 'function') fail('a sensor (tool) capability must provide toolArgs and collect')
    if (implementation.program !== undefined || implementation.programInput !== undefined) fail('a sensor (tool) capability has no executor program')
    if (!metadata.sensor) fail('a sensor (tool) capability must declare its sensor metadata (tool, observationTypes)')
  } else {
    if (typeof implementation.programInput !== 'function' || typeof implementation.collect !== 'function') fail('an isolated-container capability must provide program, programInput and collect')
    if (!executorProgramPath(implementation.program)) fail(`executor program ${String(implementation.program)} is not a reviewed executor shipped with Audivra`)
    if (implementation.toolArgs !== undefined) fail('a node-sandbox capability does not provide toolArgs')
  }
  // Network: `none` means no network at all; `scoped-egress` means the execution-private gateway. An
  // isolated capability that needs the network must use the gateway, and declaring scoped-egress is
  // itself the declaration that it needs the network.
  if (execution.network === 'scoped-egress') {
    if (!metadata.requiresNetwork) fail('a scoped-egress capability must declare requiresNetwork')
  } else if (metadata.requiresNetwork) {
    fail('an isolated capability that requires the network must declare the scoped-egress network profile')
  }
  if (metadata.resourceProfile.containerImage !== null) fail('an isolated capability names an approved runtime, never an image')
  if (metadata.resourceProfile.spawnsProcesses) fail('an isolated capability starts no host processes')
}
