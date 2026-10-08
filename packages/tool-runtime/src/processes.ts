import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { execa } from 'execa'

/**
 * Process ownership registry.
 *
 * Every external process Audivra starts is registered here (PID, OS creation time, tool, audit,
 * working directory, parent). Audivra only ever terminates processes in this registry — and, after
 * a restart, only recorded processes whose PID *and* creation time still match (defeating PID reuse).
 * There is deliberately no API to kill processes by name, pattern or command line.
 */

export interface OwnedProcessMeta {
  tool: string
  auditId?: string | null
  /** Security capability execution that owns the process (cancelled with that execution). */
  securityExecutionId?: string | null
  cwd?: string | null
  command: string
  /** Docker container name we created (always prefixed "audivra-"); stopped by exact name. */
  containerName?: string | null
  /** Short-lived probes (version checks) are tracked in memory only. */
  persist?: boolean
}

export interface OwnedProcessRecord {
  id: string
  pid: number
  processStartedAt: Date | null
  image: string | null
  tool: string
  auditId: string | null
  securityExecutionId: string | null
  ownerId: string
  parentPid: number
  command: string
  cwd: string | null
  containerName: string | null
}

export interface StaleProcessRow {
  id: string
  pid: number
  processStartedAt: Date | null
  image: string | null
  /** PID of the Audivra process that started it. */
  parentPid: number
  containerName: string | null
}

/** Persistence hooks (the worker/server wires these to PostgreSQL). */
export interface ProcessStore {
  insert(record: OwnedProcessRecord): Promise<void>
  finish(id: string, status: 'exited' | 'killed' | 'reaped' | 'gone', exitCode: number | null): Promise<void>
  listStale(ownerId: string): Promise<StaleProcessRow[]>
}

/** Identity of this Audivra process instance; records from other instances are "stale" after a restart. */
export const OWNER_ID = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

interface LiveEntry {
  record: OwnedProcessRecord
  persist: boolean
  killed: boolean
}

const live = new Map<string, LiveEntry>()
let store: ProcessStore | null = null
const pending = new Set<Promise<unknown>>()

export function setProcessStore(next: ProcessStore | null): void {
  store = next
}

function track<T>(promise: Promise<T>): void {
  const p = promise.catch(() => undefined)
  pending.add(p)
  void p.finally(() => pending.delete(p))
}

/** Waits for outstanding persistence writes (tests, shutdown). */
export async function flushProcessStore(): Promise<void> {
  await Promise.all([...pending])
}

/** OS-reported creation time and image name of a PID, or null when the process does not exist. */
export async function processIdentity(pid: number): Promise<{ startedAt: Date; image: string } | null> {
  try {
    if (process.platform === 'win32') {
      const result = await execa(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o') + '|' + $p.ProcessName`],
        { reject: false, windowsHide: true, timeout: 15_000 },
      )
      if (result.exitCode !== 0 || !result.stdout.includes('|')) return null
      const [started, image] = result.stdout.trim().split('|') as [string, string]
      const date = new Date(started)
      return Number.isNaN(date.getTime()) ? null : { startedAt: date, image: image.toLowerCase() }
    }
    const result = await execa('ps', ['-o', 'lstart=,comm=', '-p', String(Number(pid))], { reject: false, timeout: 10_000 })
    if (result.exitCode !== 0 || !result.stdout.trim()) return null
    const line = result.stdout.trim()
    const date = new Date(line.slice(0, 24))
    return Number.isNaN(date.getTime()) ? null : { startedAt: date, image: line.slice(24).trim().split('/').pop()!.toLowerCase() }
  } catch {
    return null
  }
}

export interface OwnedHandle {
  id: string
  pid: number
  /** Marks the process as finished (call when it exits on its own). */
  finish(exitCode: number | null): void
  /** Terminates this process tree (only ever this one). */
  kill(): Promise<void>
}

/** Registers a just-spawned child process as owned. */
export function registerOwned(pid: number | undefined, meta: OwnedProcessMeta): OwnedHandle | null {
  if (!pid) return null
  const record: OwnedProcessRecord = {
    id: `proc_${randomUUID().slice(0, 12)}`,
    pid,
    processStartedAt: null,
    image: null,
    tool: meta.tool,
    auditId: meta.auditId ?? null,
    securityExecutionId: meta.securityExecutionId ?? null,
    ownerId: OWNER_ID,
    parentPid: process.pid,
    command: meta.command.slice(0, 2000),
    cwd: meta.cwd ?? null,
    containerName: meta.containerName ?? null,
  }
  const entry: LiveEntry = { record, persist: meta.persist !== false, killed: false }
  live.set(record.id, entry)
  // The insert waits for the OS identity lookup; the finish write is ordered after it, so a process that
  // exits quickly never leaves a record stuck at "running".
  let inserted: Promise<unknown> = Promise.resolve()
  if (entry.persist) {
    inserted = (async () => {
      const identity = await processIdentity(pid)
      if (identity) {
        record.processStartedAt = identity.startedAt
        record.image = identity.image
      }
      await store?.insert(record)
    })()
    track(inserted)
  }
  return {
    id: record.id,
    pid,
    finish(exitCode) {
      if (!live.has(record.id)) return
      live.delete(record.id)
      if (entry.persist) track(inserted.catch(() => undefined).then(() => store?.finish(record.id, entry.killed ? 'killed' : 'exited', exitCode)))
    },
    async kill() {
      await killEntry(entry)
    },
  }
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    // /T terminates the tree rooted at THIS pid only — the process we started and its descendants.
    await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { reject: false, windowsHide: true, timeout: 20_000 })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already exited
  }
}

async function stopContainer(name: string): Promise<void> {
  if (!/^audivra-[a-z0-9-]+$/.test(name)) return
  await execa('docker', ['rm', '-f', name], { reject: false, windowsHide: true, timeout: 30_000 })
}

async function killEntry(entry: LiveEntry): Promise<void> {
  if (entry.killed) return
  entry.killed = true
  await killTree(entry.record.pid)
  if (entry.record.containerName) await stopContainer(entry.record.containerName)
}

/** Terminates every live owned process of one audit (cancellation). */
export async function killOwnedForAudit(auditId: string): Promise<number> {
  const entries = [...live.values()].filter((e) => e.record.auditId === auditId)
  await Promise.all(entries.map(killEntry))
  return entries.length
}

/** Terminates every live owned process of one security capability execution (its cancellation). */
export async function killOwnedForExecution(securityExecutionId: string): Promise<number> {
  const entries = [...live.values()].filter((e) => e.record.securityExecutionId === securityExecutionId)
  await Promise.all(entries.map(killEntry))
  return entries.length
}

/**
 * Removes Docker containers in one audit's namespace (`audivra-<auditId>-…`), including ones the AI
 * started from its terminal with the documented names. Only exact names returned by Docker for that
 * prefix are removed; nothing else is touched.
 */
export async function stopAuditContainers(auditId: string): Promise<string[]> {
  if (!/^[0-9a-z]{6,32}$/.test(auditId)) return []
  const prefix = `audivra-${auditId}-`
  const listed = await execa('docker', ['ps', '-a', '--filter', `name=^${prefix}`, '--format', '{{.Names}}'], { reject: false, windowsHide: true, timeout: 20_000 })
  if (listed.exitCode !== 0) return []
  const names = String(listed.stdout)
    .split(/\r?\n/)
    .map((n) => n.trim())
    .filter((n) => n.startsWith(prefix) && /^audivra-[a-z0-9-]+$/.test(n))
  for (const name of names) await stopContainer(name)
  return names
}

/** Terminates every process this Audivra instance started (shutdown). */
export async function killAllOwned(): Promise<number> {
  const entries = [...live.values()]
  await Promise.all(entries.map(killEntry))
  return entries.length
}

export function liveOwnedProcesses(): OwnedProcessRecord[] {
  return [...live.values()].map((e) => ({ ...e.record }))
}

/**
 * After a restart: terminate recorded processes from previous instances that are verifiably still
 * the same OS process (same PID, creation time within 5 s, same image); mark the rest as gone.
 * Records whose owning Audivra instance is still running (another worker or the server sharing the
 * database) are left alone — they are not stale.
 */
export async function reapStaleProcesses(): Promise<{ reaped: number; gone: number; skipped: number }> {
  if (!store) return { reaped: 0, gone: 0, skipped: 0 }
  let reaped = 0
  let gone = 0
  let skipped = 0
  for (const row of await store.listStale(OWNER_ID)) {
    const owner = await processIdentity(row.parentPid)
    // The owner is alive if a process with that PID exists and started before the child did (a reused
    // PID would belong to a newer process).
    const ownerAlive =
      owner !== null && (row.processStartedAt === null || owner.startedAt.getTime() <= row.processStartedAt.getTime() + 5_000)
    if (ownerAlive) {
      skipped++
      continue
    }
    const identity = await processIdentity(row.pid)
    const sameProcess =
      identity !== null &&
      row.processStartedAt !== null &&
      Math.abs(identity.startedAt.getTime() - row.processStartedAt.getTime()) <= 5_000 &&
      (row.image === null || row.image === identity.image)
    if (sameProcess) {
      await killTree(row.pid)
      reaped++
    } else gone++
    if (row.containerName) await stopContainer(row.containerName)
    await store.finish(row.id, sameProcess ? 'reaped' : 'gone', null)
  }
  return { reaped, gone, skipped }
}
