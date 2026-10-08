import type { ContainerLimits, ExecutionIsolation, SecurityCapabilityMetadata } from '@audivra/contracts'
import { capabilityExecution } from '@audivra/contracts'

/*
 * Approved container runtimes: the only images Audivra ever runs executions in. Versioned code assets,
 * like policy profiles — not configuration, and never something a request, a capability or a model can
 * name. A capability declares a runtime *id*; Audivra resolves it here to an exact image (pinned by
 * digest) and to the resource limits applied at the container boundary.
 *
 * Images are never pulled implicitly. A runtime whose image is missing is reported unavailable and
 * executions that need it are refused; pulling is an explicit action after checking free disk space.
 */

export interface ApprovedRuntime {
  id: string
  version: number
  name: string
  purpose: string
  image: { repository: string; tag: string; digest: string }
  /** Interpreter the reviewed executor program runs with. */
  command: readonly string[]
  /** Applied to every container of this runtime (recorded in each execution's trusted snapshot). */
  limits: ContainerLimits
  /** For the explicit pull instructions (disk checks come first). */
  approximateSizeMb: number
}

export const APPROVED_RUNTIMES: readonly ApprovedRuntime[] = Object.freeze([
  Object.freeze({
    id: 'node-sandbox',
    version: 1,
    name: 'Node.js sandbox',
    purpose: "Runs Audivra's reviewed Node.js executor programs: no network, read-only root filesystem, only the execution's workspace mounted.",
    image: { repository: 'node', tag: '24-alpine', digest: 'sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1' },
    command: ['node'],
    limits: { memoryMb: 256, cpus: 0.5, pidsLimit: 64, tmpfsMb: 16 },
    approximateSizeMb: 242,
  }),
])

export function findApprovedRuntime(id: string | null | undefined): ApprovedRuntime | undefined {
  return APPROVED_RUNTIMES.find((r) => r.id === id)
}

/** The exact image reference executions run (repository pinned by digest). */
export function runtimeImageRef(runtime: ApprovedRuntime): string {
  return `${runtime.image.repository}@${runtime.image.digest}`
}

/** How to make a missing runtime available — explicitly, never automatically. */
export function runtimePullHint(runtime: ApprovedRuntime): string {
  return `docker pull ${runtime.image.repository}:${runtime.image.tag}@${runtime.image.digest} (about ${runtime.approximateSizeMb} MB; check free disk space first)`
}

/** The isolation an execution of this capability gets, resolved at decision time for its trusted snapshot. */
export function isolationFor(capability: SecurityCapabilityMetadata): ExecutionIsolation {
  const execution = capabilityExecution(capability)
  if (execution.mode === 'in-process') return { mode: 'in-process', runtime: null, network: 'scoped-client', container: null }
  const runtime = findApprovedRuntime(execution.runtime)
  if (!runtime) throw new Error(`${capability.id} names runtime ${execution.runtime}, which is not approved`)
  return {
    mode: 'isolated-container',
    runtime: { id: runtime.id, version: runtime.version, image: runtimeImageRef(runtime) },
    network: 'none',
    container: { ...runtime.limits },
  }
}
