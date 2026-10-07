import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { auditWorkspaceDir, resolveInside, toWorkspaceRelative } from '@audivra/config'

export const WORKSPACE_DIRS = [
  'baseline',
  'screenshots',
  'browser',
  'network',
  'tools',
  'scripts',
  'notes',
  'agent',
  'reports',
  'final',
] as const
export type WorkspaceDir = (typeof WORKSPACE_DIRS)[number]

/** An audit's private working directory. All artifact paths stored in the DB are relative to `root`. */
export class Workspace {
  readonly root: string

  constructor(readonly auditId: string) {
    this.root = auditWorkspaceDir(auditId)
  }

  async init(): Promise<void> {
    await Promise.all(WORKSPACE_DIRS.map((dir) => mkdir(path.join(this.root, dir), { recursive: true })))
  }

  /** Absolute path for a workspace-relative path; throws on traversal. */
  abs(relative: string): string {
    const resolved = resolveInside(this.root, relative)
    if (!resolved) throw new Error(`Path escapes audit workspace: ${relative}`)
    return resolved
  }

  /** Workspace-relative (forward slash) path for an absolute path inside the workspace, else null. */
  rel(absolute: string): string | null {
    return toWorkspaceRelative(this.root, absolute)
  }

  async writeJson(relative: string, data: unknown): Promise<string> {
    const file = this.abs(relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
    return relative
  }

  async writeText(relative: string, text: string): Promise<string> {
    const file = this.abs(relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
    return relative
  }
}

/** Filesystem-safe slug for a URL (used to name per-page artifacts). */
export function urlSlug(url: string, maxLength = 60): string {
  try {
    const parsed = new URL(url)
    const raw = `${parsed.pathname}${parsed.search}`.replace(/\/+$/, '') || 'home'
    const slug = raw
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
    return (slug || 'home').slice(0, maxLength)
  } catch {
    return 'page'
  }
}
