import { egressCheckCapability } from './egress-check.ts'
import { httpObserveCapability } from './http-observe.ts'
import { isolatedCheckCapability } from './isolated-check.ts'
import { CapabilityRegistry } from './registry.ts'
import { runtimeCheckCapability } from './runtime-check.ts'
import { httpxSensorCapability } from '../sensors/httpx-sensor.ts'
import { katanaSensorCapability } from '../sensors/katana-sensor.ts'
import { semgrepSensorCapability } from '../sensors/semgrep-sensor.ts'

/**
 * The security capabilities Audivra ships. The Phase 1 passive HTTP observation, plus the Phase 3A
 * sensors: each wraps one approved external tool as a reviewed adapter that normalizes the tool's output
 * into evidence-backed observations. A sensor is never raw CLI access — Audivra builds every argument.
 */
export function createDefaultRegistry(): CapabilityRegistry {
  return new CapabilityRegistry()
    .register(httpObserveCapability)
    .register(httpxSensorCapability)
    .register(katanaSensorCapability)
    .register(semgrepSensorCapability)
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
