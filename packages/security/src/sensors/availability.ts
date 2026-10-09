import { dockerImagePresent, dockerVersion } from '@audivra/tool-runtime'
import type { ToolStatus } from '@audivra/contracts'
import { APPROVED_RUNTIMES, runtimeImageRef, runtimePullHint, type ApprovedRuntime } from '../execution/runtimes.ts'

/*
 * Availability of the security sensors, as tool statuses for the existing System → Tools view. A sensor
 * is an approved tool runtime (pinned by image digest). Availability is checked by inspecting that exact
 * image — never by pulling it. A missing sensor is reported as a setup step, so it reduces coverage
 * rather than breaking an assessment.
 *
 * The sensor-availability vocabulary maps onto the shared tool states:
 *   AVAILABLE → ready · MISSING → needs-setup (pull the pinned image) · UNHEALTHY/other → error ·
 *   Docker down → unavailable. (VERSION_MISMATCH cannot occur: the image is pinned by digest, so the
 *   image either is that exact version or is absent.)
 */

const SENSOR_RUNTIMES = APPROVED_RUNTIMES.filter((r): r is ApprovedRuntime => r.kind === 'tool')

/** Short digest form for the version column (e.g. `sha256:f8275a7c…`). */
function digestLabel(runtime: ApprovedRuntime): string {
  const d = runtime.image.digest
  return d.length > 19 ? `${d.slice(0, 19)}…` : d
}

async function statusFor(runtime: ApprovedRuntime, dockerUp: boolean): Promise<ToolStatus> {
  const base = { id: `sensor:${runtime.id}`, name: `${runtime.name} (sensor)`, group: 'Security sensors', optional: true, via: 'Docker (isolated runtime)', command: null, version: digestLabel(runtime) }
  if (!dockerUp) return { ...base, state: 'unavailable', detail: 'Docker is not running; sensors cannot run until it is available.' }
  try {
    const present = await dockerImagePresent(runtimeImageRef(runtime))
    if (present) return { ...base, state: 'ready', detail: `${runtime.purpose}` }
    return { ...base, state: 'needs-setup', detail: `Image not present. ${runtimePullHint(runtime)}` }
  } catch (error) {
    return { ...base, state: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Tool statuses for every approved sensor runtime. Images are never pulled here; a missing one is a
 * `needs-setup` entry with its exact pull hint.
 */
export async function sensorRuntimeStatuses(): Promise<ToolStatus[]> {
  const dockerUp = (await dockerVersion()) !== null
  return Promise.all(SENSOR_RUNTIMES.map((runtime) => statusFor(runtime, dockerUp)))
}
