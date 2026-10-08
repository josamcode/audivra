// Executor program for diagnostic.isolated-check — reviewed code shipped with Audivra.
//
// Runs inside the approved node-sandbox runtime: no network, read-only root filesystem, a non-root
// user, and only this execution's inputs (read-only), outputs and artifacts mounted under /audivra.
// It reports what the sandbox looks like from the inside, holds for the requested time, writes a small
// text artifact and a result file. It contacts nothing and needs nothing beyond its inputs.
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const INPUTS = '/audivra/inputs'
const OUTPUTS = '/audivra/outputs'
const ARTIFACTS = '/audivra/artifacts'

const input = JSON.parse(readFileSync(`${INPUTS}/input.json`, 'utf8'))
const marker = String(input.marker ?? '').replace(/[^a-z0-9_]/g, '').slice(0, 40)
const holdMs = Math.max(0, Math.min(900, Number(input.holdSeconds) || 0)) * 1000
const started = Date.now()

const read = (file) => {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

const writable = (file) => {
  try {
    writeFileSync(file, 'probe')
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** Every *.marker file this container can see (bounded walk). */
function markers(dir, depth = 0, found = []) {
  if (depth > 5 || found.length > 50) return found
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) markers(full, depth + 1, found)
    else if (entry.name.endsWith('.marker')) found.push(full)
  }
  return found
}

function sandbox() {
  const status = read('/proc/self/status') ?? ''
  const field = (name) => status.split('\n').find((line) => line.startsWith(`${name}:`))?.split(':')[1]?.trim() ?? null
  return {
    uid: process.getuid(),
    gid: process.getgid(),
    writable: { root: writable('/.audivra-probe'), inputs: writable(`${INPUTS}/.probe`), tmp: writable('/tmp/.probe'), outputs: writable(`${OUTPUTS}/.probe`) },
    dockerControl: ['/var/run/docker.sock', '/run/docker.sock', '/var/run/docker', '/run/desktop'].filter((p) => existsSync(p)),
    hostPaths: ['/mnt/c', '/mnt/d', '/mnt/host', '/mnt/wsl', '/host', '/hostfs', '/run/desktop/mnt/host'].filter((p) => existsSync(p)),
    mounts: (read('/proc/self/mounts') ?? '')
      .split('\n')
      .map((line) => line.split(' ')[1])
      .filter((mount) => mount?.startsWith('/audivra'))
      .sort(),
    markers: [...markers('/audivra'), ...markers('/tmp')].sort(),
    network: Object.keys(os.networkInterfaces()).sort(),
    cgroup: { memoryMax: read('/sys/fs/cgroup/memory.max'), pidsMax: read('/sys/fs/cgroup/pids.max'), cpuMax: read('/sys/fs/cgroup/cpu.max') },
    capabilities: field('CapEff'),
    noNewPrivileges: field('NoNewPrivs'),
    node: process.version,
  }
}

function finish(status) {
  const result = { status, marker, heldMs: Date.now() - started, sandbox: sandbox() }
  writeFileSync(`${OUTPUTS}/result.json`, JSON.stringify(result))
  return result
}

// A graceful stop from Audivra: leave what is known so far, then exit.
process.on('SIGTERM', () => {
  finish('stopped')
  process.exit(143)
})

writeFileSync(`${OUTPUTS}/${marker}.marker`, marker)
console.log(`isolated check ${marker}: holding for ${holdMs} ms`)
await new Promise((resolve) => setTimeout(resolve, holdMs))

const seen = sandbox()
writeFileSync(
  `${ARTIFACTS}/isolated-check.txt`,
  [
    'Audivra isolated runtime check',
    `marker:          ${marker}`,
    `user:            ${seen.uid}:${seen.gid}`,
    `root filesystem: ${seen.writable.root ? 'writable' : 'read-only'}`,
    `inputs:          ${seen.writable.inputs ? 'writable' : 'read-only'}`,
    `network:         ${seen.network.join(', ') || 'none'}`,
    `memory.max:      ${seen.cgroup.memoryMax}`,
    `pids.max:        ${seen.cgroup.pidsMax}`,
    `cpu.max:         ${seen.cgroup.cpuMax}`,
    `held:            ${Date.now() - started} ms`,
    input.note ? `note:            ${String(input.note).slice(0, 200)}` : null,
    `runtime:         node ${process.version}`,
  ]
    .filter(Boolean)
    .join('\n') + '\n',
)
finish('completed')
console.log(`isolated check ${marker}: completed`)
