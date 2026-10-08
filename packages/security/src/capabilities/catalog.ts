import { egressCheckCapability } from './egress-check.ts'
import { httpObserveCapability } from './http-observe.ts'
import { isolatedCheckCapability } from './isolated-check.ts'
import { CapabilityRegistry } from './registry.ts'
import { runtimeCheckCapability } from './runtime-check.ts'

/**
 * The capabilities Audivra ships. Phase 1 has exactly one, and it is passive and read-only: it exists to
 * prove the control plane end to end, not to test anything.
 */
export function createDefaultRegistry(): CapabilityRegistry {
  return new CapabilityRegistry().register(httpObserveCapability)
}

/**
 * What the execution runtime can run: the security capabilities plus platform diagnostics. Diagnostics
 * (`diagnostic.runtime-check` in-process, `diagnostic.isolated-check` in an isolated container) go through
 * the broker like any capability but never contact a target, so they are not part of the security
 * capability catalog shown to people and agents.
 */
export function createRuntimeRegistry(): CapabilityRegistry {
  return createDefaultRegistry().register(runtimeCheckCapability).register(isolatedCheckCapability).register(egressCheckCapability)
}
