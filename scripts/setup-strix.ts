import { statfsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { getLogger } from '@audivra/config'

/*
 * Phase 6D — EXPLICIT, opt-in setup for the optional Strix specialist engine. Nothing here runs during
 * `pnpm install`, app startup, dev or the test suite (§19). It checks disk FIRST, verifies Docker and the
 * pinned CLI, and performs the (potentially large) sandbox-image pull ONLY with `--confirm`. It never prunes
 * or touches unrelated Docker data. Review and pin the approved version before enabling the engine.
 *
 *   pnpm setup:strix            # inspect only: report versions, disk, what a pull would do
 *   pnpm setup:strix --confirm  # perform the explicit sandbox-image pull (after the disk check)
 */

const log = getLogger()
const confirm = process.argv.includes('--confirm')
const MIN_FREE_GB = 12 // the Kali-based sandbox image is multi-GB; leave ample margin.
const pinnedCli = process.env.STRIX_PINNED_CLI_VERSION ?? ''
const sandboxImage = process.env.STRIX_PINNED_SANDBOX_IMAGE ?? ''

function cmd(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim()
  } catch {
    return null
  }
}

function freeGb(path: string): number {
  try {
    const s = statfsSync(path)
    return (Number(s.bavail) * Number(s.bsize)) / 1_073_741_824
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const docker = cmd('docker', ['--version'])
const strix = cmd('strix', ['--version'])
const free = freeGb(process.cwd())

log.info(
  {
    docker: docker ?? 'MISSING',
    strixCli: strix ?? 'MISSING',
    pinnedCliVersion: pinnedCli || '(unset — review and pin via STRIX_PINNED_CLI_VERSION)',
    pinnedSandboxImage: sandboxImage || '(unset — review and pin via STRIX_PINNED_SANDBOX_IMAGE)',
    freeDiskGb: Math.round(free),
    enabled: process.env.STRIX_ENABLED === 'true' || process.env.STRIX_ENABLED === '1',
  },
  'Strix specialist setup — review these before enabling the engine',
)

if (!docker) {
  log.error('Docker is not available. Strix requires Docker for its sandbox. Aborting (no changes made).')
  process.exit(1)
}
if (!pinnedCli || !sandboxImage) {
  log.warn('Pin the approved Strix CLI version and sandbox image (STRIX_PINNED_CLI_VERSION / STRIX_PINNED_SANDBOX_IMAGE) before enabling. No pull performed.')
}
if (strix && pinnedCli && strix.includes(pinnedCli) === false) {
  log.warn({ installed: strix, pinned: pinnedCli }, 'Installed Strix CLI does not match the pinned version — explicit review required before use.')
}

if (!confirm) {
  log.info('Inspect-only run. Re-run with --confirm to perform the explicit sandbox-image pull (after the disk check). This script never prunes Docker.')
  process.exit(0)
}

if (free < MIN_FREE_GB) {
  log.error({ freeDiskGb: Math.round(free), requiredGb: MIN_FREE_GB }, 'Not enough free disk for the Strix sandbox image. Aborting the pull (no changes made).')
  process.exit(1)
}
if (!sandboxImage) {
  log.error('No pinned sandbox image to pull (STRIX_PINNED_SANDBOX_IMAGE unset). Aborting.')
  process.exit(1)
}

log.info({ image: sandboxImage }, 'Pulling the pinned Strix sandbox image explicitly (this may be large). No unrelated Docker data is touched.')
try {
  execFileSync('docker', ['pull', sandboxImage], { stdio: 'inherit', timeout: 20 * 60_000 })
  log.info('Done. The engine still runs only when STRIX_ENABLED=true and a provider profile is configured; live-target modes remain disabled until a containment spike is proven.')
} catch (error) {
  log.error({ err: error }, 'The sandbox-image pull failed. No cleanup/prune performed.')
  process.exit(1)
}
