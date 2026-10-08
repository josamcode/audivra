import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reviewed executor programs shipped with Audivra (`packages/security/executors/`). An isolated
 * capability names one of these files; nothing else can be run in an execution container.
 */
export const EXECUTORS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'executors')

const PROGRAM_NAME = /^[a-z0-9][a-z0-9-]*\.mjs$/

/** Absolute path of a shipped executor program, or null for anything else (unknown, traversal, not a file). */
export function executorProgramPath(name: unknown): string | null {
  if (typeof name !== 'string' || !PROGRAM_NAME.test(name)) return null
  const file = path.join(EXECUTORS_DIR, name)
  return existsSync(file) && statSync(file).isFile() ? file : null
}
