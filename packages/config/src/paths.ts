import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))
export const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts')
export const LOCAL_TOOLS_DIR = path.join(REPO_ROOT, '.tools')
export const LOCAL_BIN_DIR = path.join(LOCAL_TOOLS_DIR, 'bin')

export function dataDir(): string {
  return process.env.AUDIVRA_DATA_DIR
    ? path.resolve(REPO_ROOT, process.env.AUDIVRA_DATA_DIR)
    : path.join(REPO_ROOT, '.local-data')
}

export function auditsDir(): string {
  return path.join(dataDir(), 'audits')
}

const AUDIT_ID_PATTERN = /^[0-9a-z]{6,32}$/

/** Root of an audit's private workspace. The ID is validated to prevent path traversal. */
export function auditWorkspaceDir(auditId: string): string {
  if (!AUDIT_ID_PATTERN.test(auditId)) throw new Error(`Invalid audit id: ${auditId}`)
  return path.join(auditsDir(), auditId)
}

/**
 * Resolves a workspace-relative path and guarantees it stays inside the workspace.
 * Returns null for absolute paths, traversal attempts or other escapes.
 */
export function resolveInside(root: string, relative: string): string | null {
  if (!relative || relative.includes('\0')) return null
  const normalized = relative.replace(/\\/g, '/')
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return null
  const resolved = path.resolve(root, normalized)
  const rel = path.relative(root, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}

/** Converts an absolute path inside root into a forward-slash workspace-relative path. */
export function toWorkspaceRelative(root: string, absolute: string): string | null {
  const rel = path.relative(root, path.resolve(root, absolute))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}
