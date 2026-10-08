import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveInside, toWorkspaceRelative } from '@audivra/config'
import { directorySize } from '../resources.ts'
import { ExecutionError } from './failures.ts'

/*
 * The private workspace of one execution:
 *
 *   <data>/security/<engagement>/executions/<execution>/
 *     inputs/     written by the runtime before the capability starts (validated input)
 *     outputs/    files the capability produces
 *     artifacts/  files the capability produces for evidence
 *     tmp/        scratch space; removed at cleanup
 *
 * Every path handed out or accepted is resolved inside this directory (no absolute paths, traversal,
 * drive letters or symbolic-link escapes). Artifact paths stored with evidence stay relative to the
 * engagement workspace, as in Phase 1, so they keep pointing at the execution that produced them.
 */

export const WORKSPACE_AREAS = ['inputs', 'outputs', 'artifacts', 'tmp'] as const
export type WorkspaceArea = (typeof WORKSPACE_AREAS)[number]

/** Areas whose files may become evidence (inputs are the platform's, tmp is deleted at cleanup). */
const NOT_EVIDENCE: readonly string[] = ['inputs', 'tmp']

const EXECUTION_ID = /^sx_[0-9a-z]{14}$/

export class ExecutionWorkspace {
  /** The engagement workspace (root of evidence artifact paths). */
  readonly root: string
  /** This execution's directory. */
  readonly dir: string

  constructor(engagementRoot: string, readonly executionId: string) {
    if (!EXECUTION_ID.test(executionId)) throw new ExecutionError('preflight-failed', 'workspace.invalid-id', `Invalid execution id: ${executionId}`)
    this.root = path.resolve(engagementRoot)
    this.dir = path.join(this.root, 'executions', executionId)
  }

  area(name: WorkspaceArea): string {
    return path.join(this.dir, name)
  }

  async init(): Promise<void> {
    for (const name of WORKSPACE_AREAS) await mkdir(this.area(name), { recursive: true })
  }

  /** Absolute path of a file inside one area; refuses anything that would leave it. */
  resolve(area: WorkspaceArea, relative: string): string {
    const resolved = resolveInside(this.area(area), relative)
    if (!resolved) throw new ExecutionError('artifact-limit', 'workspace.path-escape', `Path is outside the execution's ${area} area: ${relative}`)
    return resolved
  }

  /** Engagement-relative path of a file inside this execution (forward slashes), or null when outside. */
  relative(absolute: string): string | null {
    const insideExecution = toWorkspaceRelative(this.dir, absolute)
    return insideExecution === null ? null : toWorkspaceRelative(this.root, absolute)
  }

  /** Writes a file inside an area (creating its folders) and returns its absolute path. */
  async write(area: WorkspaceArea, relative: string, content: string | Uint8Array): Promise<string> {
    const file = this.resolve(area, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await this.#assertRealInside(path.dirname(file))
    await writeFile(file, content)
    return file
  }

  /**
   * Validates a file a capability wants to register as evidence: given relative to the engagement
   * workspace, it must be a regular file (not a link) inside this execution, outside inputs/ and tmp/.
   */
  async artifactFile(engagementRelative: string): Promise<{ absolute: string; relative: string; bytes: number }> {
    const absolute = resolveInside(this.root, engagementRelative)
    const inExecution = absolute ? toWorkspaceRelative(this.dir, absolute) : null
    if (!absolute || !inExecution) {
      throw new ExecutionError('artifact-limit', 'artifact.outside-execution', `Artifact path is outside this execution's workspace: ${engagementRelative}`)
    }
    if (NOT_EVIDENCE.includes(inExecution.split('/')[0]!)) {
      throw new ExecutionError('artifact-limit', 'artifact.area-not-allowed', `Files in ${inExecution.split('/')[0]}/ cannot become evidence: ${engagementRelative}`)
    }
    const info = await lstat(absolute).catch(() => null)
    if (!info) throw new ExecutionError('artifact-limit', 'artifact.missing', `Artifact does not exist: ${engagementRelative}`)
    if (!info.isFile()) throw new ExecutionError('artifact-limit', 'artifact.not-a-file', `Artifact is not a regular file: ${engagementRelative}`)
    await this.#assertRealInside(absolute)
    return { absolute, relative: toWorkspaceRelative(this.root, absolute)!, bytes: info.size }
  }

  /**
   * Reads a file an executor produced, safely: a regular file (not a link) inside the area, at most
   * `maxBytes` long. Returns null when it is absent, not a regular file, too large or escapes.
   */
  async readBounded(area: WorkspaceArea, relative: string, maxBytes: number): Promise<string | null> {
    const file = this.resolve(area, relative)
    const info = await lstat(file).catch(() => null)
    if (!info?.isFile() || info.size > maxBytes) return null
    try {
      await this.#assertRealInside(file)
    } catch {
      return null
    }
    return readFile(file, 'utf8')
  }

  /** Bytes the execution's own files occupy (everything except the platform inputs and scratch space). */
  async artifactBytes(): Promise<number> {
    const [total, inputs, tmp] = await Promise.all([directorySize(this.dir), directorySize(this.area('inputs')), directorySize(this.area('tmp'))])
    return Math.max(0, total - inputs - tmp)
  }

  /** Removes scratch space. Idempotent: running it again (or on a workspace that was never created) is a no-op. */
  /**
   * Private directory for Audivra's own per-execution infrastructure files (the network gateway's
   * bundled program, its trusted policy and its bounded decision log). It is never mounted into the
   * executor container — only into the Audivra-controlled gateway container.
   */
  get gatewayDir(): string {
    return path.join(this.dir, '.gateway')
  }

  async cleanup(): Promise<{ removedBytes: number }> {
    const tmp = this.area('tmp')
    const removedBytes = await directorySize(tmp)
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    await rm(this.gatewayDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    return { removedBytes }
  }

  /** Symbolic links and junctions must not lead out of the execution directory. */
  async #assertRealInside(target: string): Promise<void> {
    const [real, base] = await Promise.all([realpath(target), realpath(this.dir).catch(() => this.dir)])
    const rel = path.relative(base, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ExecutionError('artifact-limit', 'workspace.link-escape', `Path leads outside the execution workspace: ${toWorkspaceRelative(this.root, target) ?? target}`)
    }
  }
}
