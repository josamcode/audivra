import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  killOwnedForAudit,
  liveOwnedProcesses,
  OWNER_ID,
  processIdentity,
  reapStaleProcesses,
  registerOwned,
  setProcessStore,
  type OwnedProcessRecord,
  type ProcessStore,
  type StaleProcessRow,
} from '../src/processes.ts'

const children: ChildProcess[] = []

/** A harmless idle Node process we own for the duration of a test. */
function idleChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}

const exited = (child: ChildProcess, ms = 15_000) =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

afterEach(() => {
  setProcessStore(null)
  for (const child of children.splice(0)) if (alive(child)) child.kill()
})

class MemoryStore implements ProcessStore {
  inserted: OwnedProcessRecord[] = []
  finished: { id: string; status: string }[] = []
  constructor(private readonly stale: StaleProcessRow[] = []) {}
  async insert(record: OwnedProcessRecord) {
    this.inserted.push(record)
  }
  async finish(id: string, status: 'exited' | 'killed' | 'reaped' | 'gone') {
    this.finished.push({ id, status })
  }
  async listStale(ownerId: string) {
    expect(ownerId).toBe(OWNER_ID)
    return this.stale
  }
}

describe('process ownership registry', () => {
  it('terminates only the processes of the cancelled audit', async () => {
    const a = idleChild()
    const b = idleChild()
    registerOwned(a.pid, { tool: 'test', auditId: 'auditaaaaa', command: 'idle a', persist: false })
    registerOwned(b.pid, { tool: 'test', auditId: 'auditbbbbb', command: 'idle b', persist: false })
    expect(await killOwnedForAudit('auditaaaaa')).toBe(1)
    expect(await exited(a)).toBe(true)
    expect(alive(b)).toBe(true)
    expect(liveOwnedProcesses().some((p) => p.pid === b.pid)).toBe(true)
  }, 60_000)

  it('persists owned processes with their OS creation time', async () => {
    const store = new MemoryStore()
    setProcessStore(store)
    const child = idleChild()
    const handle = registerOwned(child.pid, { tool: 'lighthouse', auditId: 'auditccccc', command: 'lighthouse x' })!
    await new Promise((r) => setTimeout(r, 3000))
    expect(store.inserted[0]).toMatchObject({ pid: child.pid, tool: 'lighthouse', auditId: 'auditccccc', ownerId: OWNER_ID, parentPid: process.pid })
    expect(store.inserted[0]!.processStartedAt).toBeInstanceOf(Date)
    await handle.kill()
    expect(await exited(child)).toBe(true)
  }, 60_000)

  it('after a restart, reaps only verified leftovers and never touches live owners or reused PIDs', async () => {
    const leftover = idleChild()
    const reused = idleChild()
    const otherInstance = idleChild()
    const [leftoverId, reusedId, otherId] = await Promise.all([processIdentity(leftover.pid!), processIdentity(reused.pid!), processIdentity(otherInstance.pid!)])
    const deadOwner = 4_194_300 // no such process
    const store = new MemoryStore([
      // Started by a crashed worker: same PID and creation time → terminated.
      { id: 'p1', pid: leftover.pid!, processStartedAt: leftoverId!.startedAt, image: leftoverId!.image, parentPid: deadOwner, containerName: null },
      // Recorded PID now belongs to a different process (creation time differs) → only marked gone.
      { id: 'p2', pid: reused.pid!, processStartedAt: new Date(reusedId!.startedAt.getTime() - 3_600_000), image: reusedId!.image, parentPid: deadOwner, containerName: null },
      // Owned by another Audivra instance that is still running (this test process) → left alone.
      { id: 'p3', pid: otherInstance.pid!, processStartedAt: otherId!.startedAt, image: otherId!.image, parentPid: process.pid, containerName: null },
    ])
    setProcessStore(store)
    expect(await reapStaleProcesses()).toEqual({ reaped: 1, gone: 1, skipped: 1 })
    expect(await exited(leftover)).toBe(true)
    expect(alive(reused)).toBe(true)
    expect(alive(otherInstance)).toBe(true)
    expect(store.finished).toEqual([
      { id: 'p1', status: 'reaped' },
      { id: 'p2', status: 'gone' },
    ])
  }, 90_000)
})
