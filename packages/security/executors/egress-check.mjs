// Executor program for diagnostic.egress-check — reviewed code shipped with Audivra.
//
// Runs inside the approved node-sandbox runtime on an execution-private internal network whose only
// reachable peer is the Audivra gateway (alias `egress`). It has no DNS for and no route to anything
// else. It reaches the network ONLY by sending absolute-form HTTP requests to the gateway, which
// evaluates each one against the trusted scope and allows or denies it. This program makes the
// requested probes, records what the gateway returned for each (it never decides scope itself), writes
// a small artifact and a result file. It also reports that it has no direct route, as evidence of
// containment. It contacts nothing directly.
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'

const EGRESS = { host: 'egress', port: 3128 }
const OUTPUTS = '/audivra/outputs'
const ARTIFACTS = '/audivra/artifacts'

const input = JSON.parse((await import('node:fs')).readFileSync('/audivra/inputs/input.json', 'utf8'))
const marker = String(input.marker ?? '').replace(/[^a-z0-9_]/g, '').slice(0, 40)
const probes = Array.isArray(input.probes) ? input.probes.slice(0, 20) : []
const holdMs = Math.max(0, Math.min(900, Number(input.holdSeconds) || 0)) * 1000
const started = Date.now()

/** A single hop through the gateway proxy (absolute-form); never a direct connection to the destination. */
function hop(url) {
  return new Promise((resolve) => {
    const req = http.request({ host: EGRESS.host, port: EGRESS.port, path: url, method: 'GET', timeout: 8000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body.length < 200 ? (body += c) : null))
      res.on('end', () => resolve({ status: res.statusCode, denied: res.statusCode === 403, location: res.headers.location ?? null, body: body.slice(0, 80) }))
    })
    req.on('error', (e) => resolve({ error: e.code ?? e.message }))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

/**
 * A request through the gateway, following redirects — like a real HTTP tool would. Every hop, including
 * each redirect, goes back through the gateway and is evaluated against scope, so a redirect cannot leave
 * the engagement's scope: an out-of-scope location is denied and never reached.
 */
async function viaGateway(url) {
  let current = url
  const chain = []
  for (let i = 0; i < 4; i++) {
    const result = await hop(current)
    if (result.status >= 300 && result.status < 400 && result.location) {
      chain.push({ from: current, status: result.status })
      current = new URL(result.location, current).toString()
      continue
    }
    return { ...result, hops: chain.length, finalUrl: current, redirectChain: chain }
  }
  return { error: 'too many redirects', hops: chain.length, finalUrl: current, redirectChain: chain }
}

/** A raw TCP attempt that bypasses the gateway — must fail, proving there is no alternate route. */
function directAttempt(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 3000 })
    s.on('connect', () => (s.destroy(), resolve('CONNECTED')))
    s.on('timeout', () => (s.destroy(), resolve('timeout')))
    s.on('error', (e) => resolve(e.code ?? e.message))
  })
}

function finish(status, requests, direct) {
  const result = { status, marker, heldMs: Date.now() - started, requests, direct }
  writeFileSync(`${OUTPUTS}/result.json`, JSON.stringify(result))
  return result
}

process.on('SIGTERM', () => {
  finish('stopped', [], {})
  process.exit(143)
})

const requests = []
for (const probe of [{ label: 'target', url: input.target }, ...probes]) {
  if (typeof probe?.url !== 'string') continue
  requests.push({ label: String(probe.label ?? 'probe').slice(0, 40), url: probe.url, outcome: await viaGateway(probe.url) })
}

// Containment self-check: a direct route around the gateway must not exist.
const direct = {
  'host.docker.internal:80': await directAttempt('host.docker.internal', 80),
  '8.8.8.8:53': await directAttempt('8.8.8.8', 53),
}

if (holdMs) await new Promise((r) => setTimeout(r, holdMs))

const lines = [
  'Audivra controlled-egress check',
  `marker:   ${marker}`,
  ...requests.map((r) => `request:  ${r.label} ${r.url} -> ${r.outcome.denied ? 'DENIED by gateway' : r.outcome.status ? 'status ' + r.outcome.status : 'error ' + r.outcome.error}`),
  `direct:   host.docker.internal:80 -> ${direct['host.docker.internal:80']}; 8.8.8.8:53 -> ${direct['8.8.8.8:53']}`,
  input.note ? `note:     ${String(input.note).slice(0, 200)}` : null,
]
writeFileSync(`${ARTIFACTS}/egress-check.txt`, lines.filter(Boolean).join('\n') + '\n')
finish('completed', requests, direct)
console.log(`egress check ${marker}: ${requests.length} request(s) through the gateway`)
