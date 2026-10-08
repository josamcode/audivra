import { mkdir, readdir, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { SecurityCapabilityMetadata } from '@audivra/contracts'

/*
 * Resource preflight before a capability executes. A machine running many projects at once must not be
 * taken down by one engagement (Audivra has already lived through a full system drive), so:
 * - execution is refused when the data volume is below the configured free-space threshold;
 * - an engagement's artifacts may not grow past its artifact budget;
 * - container images are never pulled implicitly — a capability whose image is missing is refused.
 */

export interface ResourceCheck {
  ok: boolean
  rule: string
  reason: string
  details: Record<string, unknown>
}

export interface ResourceCheckInput {
  capability: SecurityCapabilityMetadata
  /** The engagement workspace (created if missing). */
  workspaceRoot: string
  minFreeBytes: number
  maxArtifactBytes: number
  /** Checks a local image without pulling it (tool-runtime `dockerImagePresent`). */
  imagePresent: (image: string) => Promise<boolean>
}

/** Total size of files under a directory (bounded walk: stops counting after 20,000 entries). */
export async function directorySize(dir: string, budget = { entries: 20_000 }): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (--budget.entries < 0) break
    const full = path.join(dir, name)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    total += info.isDirectory() ? await directorySize(full, budget) : info.size
  }
  return total
}

export async function checkExecutionResources(input: ResourceCheckInput): Promise<ResourceCheck> {
  const { capability } = input
  if (capability.resourceProfile.containerImage) {
    const image = capability.resourceProfile.containerImage
    if (!(await input.imagePresent(image))) {
      return {
        ok: false,
        rule: 'resources.image-missing',
        reason: `${image} is not available locally. Images are never pulled automatically; pull it explicitly after checking free disk space.`,
        details: { image },
      }
    }
  }
  if (capability.resourceProfile.disk === 'none') return { ok: true, rule: 'resources.ok', reason: 'No disk use', details: {} }

  await mkdir(input.workspaceRoot, { recursive: true })
  const fs = await statfs(input.workspaceRoot)
  const freeBytes = Number(fs.bavail) * Number(fs.bsize)
  if (freeBytes < input.minFreeBytes) {
    return {
      ok: false,
      rule: 'resources.disk-low',
      reason: `Only ${Math.round(freeBytes / 1_048_576)} MB free on the data volume (minimum ${Math.round(input.minFreeBytes / 1_048_576)} MB)`,
      details: { freeBytes, minFreeBytes: input.minFreeBytes },
    }
  }
  const usedBytes = await directorySize(input.workspaceRoot)
  if (usedBytes >= input.maxArtifactBytes) {
    return {
      ok: false,
      rule: 'resources.artifact-budget',
      reason: `The engagement's artifacts use ${Math.round(usedBytes / 1_048_576)} MB of its ${Math.round(input.maxArtifactBytes / 1_048_576)} MB budget`,
      details: { usedBytes, maxArtifactBytes: input.maxArtifactBytes },
    }
  }
  return { ok: true, rule: 'resources.ok', reason: `${Math.round(freeBytes / 1_048_576)} MB free; artifacts ${Math.round(usedBytes / 1024)} KB`, details: { freeBytes, usedBytes } }
}
