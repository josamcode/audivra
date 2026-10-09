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
  /**
   * `program`: runs Audivra's reviewed Node.js executor programs. `tool`: runs one approved external
   * sensor tool with Audivra-built arguments (never user- or model-supplied).
   */
  kind: 'program' | 'tool'
  image: { repository: string; tag: string; digest: string }
  /** Interpreter the reviewed executor program runs with (`program` runtimes). */
  command: readonly string[]
  /** Container entrypoint override for a `tool` runtime (the tool binary); null uses the image's own. */
  entrypoint: string | null
  /** Applied to every container of this runtime (recorded in each execution's trusted snapshot). */
  limits: ContainerLimits
  /** For the explicit pull instructions (disk checks come first). */
  approximateSizeMb: number
}

/**
 * Container limits for the sensor tools. They are heavier than the node sandbox (crawlers and analysers
 * can be memory- and CPU-hungry), but still bounded and enforced at the container boundary.
 */
const SENSOR_LIMITS: ContainerLimits = { memoryMb: 1024, cpus: 2, pidsLimit: 512, tmpfsMb: 256 }

export const APPROVED_RUNTIMES: readonly ApprovedRuntime[] = Object.freeze([
  Object.freeze({
    id: 'node-sandbox',
    version: 1,
    name: 'Node.js sandbox',
    purpose: "Runs Audivra's reviewed Node.js executor programs: no network, read-only root filesystem, only the execution's workspace mounted.",
    kind: 'program',
    image: { repository: 'node', tag: '24-alpine', digest: 'sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1' },
    command: ['node'],
    entrypoint: null,
    limits: { memoryMb: 256, cpus: 0.5, pidsLimit: 64, tmpfsMb: 16 },
    approximateSizeMb: 242,
  }),
  Object.freeze({
    id: 'httpx',
    version: 1,
    name: 'httpx (ProjectDiscovery)',
    purpose: 'Safe HTTP inspection of an in-scope target: status, title, server, technologies, CDN, response metadata. Networked — reaches the target only through the execution gateway.',
    kind: 'tool',
    image: { repository: 'projectdiscovery/httpx', tag: 'latest', digest: 'sha256:f8275a7c6aaec187249df9eaf4ad9196f4677adfc6a51a47b4aaa1d4db4f8ffc' },
    command: [],
    entrypoint: 'httpx',
    limits: SENSOR_LIMITS,
    approximateSizeMb: 976,
  }),
  Object.freeze({
    id: 'katana',
    version: 1,
    name: 'Katana (ProjectDiscovery)',
    purpose: 'Bounded same-site crawl/discovery of in-scope URLs and routes. Networked — reaches targets only through the execution gateway.',
    kind: 'tool',
    image: { repository: 'projectdiscovery/katana', tag: 'latest', digest: 'sha256:20c42a63b71f0c2e95cb02d973e8887e70ad65ea9cb818183f163143275e746c' },
    command: [],
    entrypoint: 'katana',
    limits: SENSOR_LIMITS,
    approximateSizeMb: 1275,
  }),
  Object.freeze({
    id: 'semgrep',
    version: 1,
    name: 'Semgrep CE',
    purpose: 'Static analysis of a staged source tree with reviewed rules. No network; only the staged source is mounted read-only.',
    kind: 'tool',
    image: { repository: 'semgrep/semgrep', tag: 'latest', digest: 'sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b' },
    command: [],
    entrypoint: 'semgrep',
    limits: SENSOR_LIMITS,
    approximateSizeMb: 1564,
  }),
  Object.freeze({
    id: 'schemathesis',
    version: 1,
    name: 'Schemathesis',
    purpose: 'Property-based testing of a staged OpenAPI/GraphQL schema against an in-scope API. Networked — reaches the API only through the execution gateway.',
    kind: 'tool',
    image: { repository: 'schemathesis/schemathesis', tag: 'latest', digest: 'sha256:23ec514b4e8c92b0c74327c118e72fde38edbc56b393fcec5bfad2b58691a00f' },
    command: [],
    entrypoint: 'schemathesis',
    limits: SENSOR_LIMITS,
    approximateSizeMb: 157,
  }),
  Object.freeze({
    id: 'nuclei',
    version: 1,
    name: 'Nuclei (ProjectDiscovery)',
    purpose: 'Template-driven web signals using only Audivra-reviewed, staged templates. Networked — reaches the target only through the execution gateway; OAST disabled.',
    kind: 'tool',
    image: { repository: 'projectdiscovery/nuclei', tag: 'latest', digest: 'sha256:582d5546902e67052097cb2d07296c642d50a1afc5e44623cb038845df9a32eb' },
    command: [],
    entrypoint: 'nuclei',
    limits: SENSOR_LIMITS,
    approximateSizeMb: 1304,
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
    // scoped-egress capabilities reach the network only through the execution's gateway; others get none.
    network: execution.network === 'scoped-egress' ? 'scoped-egress' : 'none',
    container: { ...runtime.limits },
  }
}
