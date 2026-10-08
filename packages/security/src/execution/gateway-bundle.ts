import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from '@audivra/config'

/*
 * The execution gateway program (`packages/security/gateway/main.ts`) carries the real Phase 1 scope
 * engine, so network scope is interpreted in exactly one place. It runs inside the approved runtime
 * container, which has no node_modules, so it is bundled with esbuild into a single ESM file and cached
 * on disk, keyed by a hash of the gateway source and this module. There is no second scope interpreter.
 */

export const GATEWAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gateway')
const GATEWAY_ENTRY = path.join(GATEWAY_DIR, 'main.ts')
const CACHE_DIR = path.join(dataDir(), 'security', '.gateway')
/** Bumped when the bundling inputs or options change, to invalidate stale caches. */
const BUNDLE_VERSION = 1

let building: Promise<string> | null = null

/** Absolute path of the bundled gateway program, building and caching it on first use. */
export function gatewayBundlePath(): Promise<string> {
  building ??= build()
  return building
}

async function build(): Promise<string> {
  const source = await readFile(GATEWAY_ENTRY, 'utf8')
  const hash = createHash('sha256').update(`v${BUNDLE_VERSION}\n`).update(source).digest('hex').slice(0, 16)
  const outFile = path.join(CACHE_DIR, `gateway-${hash}.mjs`)
  if (existsSync(outFile)) return outFile
  await mkdir(CACHE_DIR, { recursive: true })
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: [GATEWAY_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    legalComments: 'none',
  })
  const code = result.outputFiles[0]!.text
  // Write atomically so a concurrent worker never stages a half-written bundle.
  const temp = `${outFile}.${process.pid}.tmp`
  await writeFile(temp, code, 'utf8')
  await rename(temp, outFile).catch(async (error: NodeJS.ErrnoException) => {
    if (existsSync(outFile)) return
    throw error
  })
  return outFile
}
