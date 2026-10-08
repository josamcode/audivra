import { httpObserveCapability } from './http-observe.ts'
import { CapabilityRegistry } from './registry.ts'

/**
 * The capabilities Audivra ships. Phase 1 has exactly one, and it is passive and read-only: it exists to
 * prove the control plane end to end, not to test anything.
 */
export function createDefaultRegistry(): CapabilityRegistry {
  return new CapabilityRegistry().register(httpObserveCapability)
}
