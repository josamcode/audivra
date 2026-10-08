/*
 * Audivra execution gateway — the only network path out of a scoped-egress execution's container.
 *
 * Bundled (esbuild) into a single file and staged read-only into the gateway container; it carries the
 * real Phase 1 scope engine, so scope is interpreted exactly once in the codebase. It is an HTTP forward
 * proxy: the executor sends absolute-form requests, the gateway evaluates each one (and its resolved
 * addresses) against the trusted policy it was given, enforces the execution's request budget, connects
 * only to an address it just approved, and never follows redirects itself. It trusts nothing the
 * executor says about scope, has no database or Audivra credentials, and writes bounded decisions.
 */
import http from 'node:http'
import net from 'node:net'
import { readFileSync, appendFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { ScopeManifest, ExecutionLimits, classifyIp, parseIp } from '@audivra/contracts'
import { evaluateUrl, evaluateNetworkDestination } from '../src/scope.ts'

const POLICY = JSON.parse(readFileSync(process.env.AUDIVRA_GATEWAY_POLICY ?? '/audivra/gateway/policy.json', 'utf8'))
const manifest = ScopeManifest.parse(POLICY.manifest)
const limits = ExecutionLimits.parse(POLICY.limits)
const DECISIONS = process.env.AUDIVRA_GATEWAY_LOG ?? '/audivra/outputs/gateway.jsonl'
const PORT = Number(process.env.AUDIVRA_GATEWAY_PORT ?? 3128)
/** On Docker Desktop the host's loopback services are reached through this name, not 127.0.0.1. */
const HOST_GATEWAY = process.env.AUDIVRA_HOST_GATEWAY ?? 'host.docker.internal'

const counters = { requested: 0, allowed: 0, denied: 0 }
const byReason: Record<string, number> = {}
let logged = 0
function decide(entry: Record<string, unknown>): void {
  counters.requested++
  if (entry.decision === 'allow') counters.allowed++
  else {
    counters.denied++
    byReason[String(entry.rule)] = (byReason[String(entry.rule)] ?? 0) + 1
  }
  if (logged++ < 2000) {
    try {
      appendFileSync(DECISIONS, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    } catch {
      /* bounded best-effort */
    }
  }
}

// ── Request budget, enforced independently of the executor ──────────────────────────────────────────
let issued = 0
let active = 0
let windowStart = Date.now()
let windowCount = 0
const waiters: (() => void)[] = []
function tryTakeRateSlot(): boolean {
  const now = Date.now()
  if (now - windowStart >= 1000) {
    windowStart = now
    windowCount = 0
  }
  if (windowCount >= limits.requestsPerSecond) return false
  windowCount++
  return true
}
async function acquire(): Promise<void> {
  while (active >= limits.concurrency) await new Promise<void>((r) => waiters.push(r))
  active++
}
function release(): void {
  active--
  waiters.shift()?.()
}

const bad = (res: http.ServerResponse, code: number, message: string) => {
  res.writeHead(code, { 'content-type': 'text/plain' })
  res.end(message)
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? ''
  if (!/^https?:\/\//i.test(url)) {
    decide({ decision: 'deny', rule: 'gateway.absolute-form-only', reason: 'Only absolute-form HTTP proxy requests are accepted', url })
    return bad(res, 400, 'absolute-form only')
  }
  if ((req.method ?? 'GET') !== 'GET' && req.method !== 'HEAD') {
    decide({ decision: 'deny', rule: 'gateway.method-not-allowed', reason: `Method ${req.method} is not mediated`, url, method: req.method })
    return bad(res, 405, 'method not allowed')
  }
  if (issued >= limits.maxRequests) {
    decide({ decision: 'deny', rule: 'network.request-budget', reason: `Request budget of ${limits.maxRequests} reached`, url })
    return bad(res, 429, 'request budget exhausted')
  }
  if (!tryTakeRateSlot()) {
    decide({ decision: 'deny', rule: 'network.rate-limit', reason: `Rate limit of ${limits.requestsPerSecond}/s reached`, url })
    return bad(res, 429, 'rate limit')
  }

  const named = evaluateUrl(manifest, url)
  if (named.decision === 'deny') {
    decide({ decision: 'deny', rule: named.rule, reason: named.reason, url, host: named.destination.host, port: named.destination.port })
    return bad(res, 403, `denied: ${named.reason}`)
  }
  const host = named.destination.host!
  const port = named.destination.port!

  // Resolve and evaluate the resolved addresses (the gateway's own DNS; the executor has none).
  let addresses: string[]
  try {
    const literal = parseIp(host)
    addresses = literal ? [literal.text] : [...new Set((await lookup(host, { all: true, verbatim: true })).map((a) => a.address))]
  } catch {
    decide({ decision: 'deny', rule: 'dns.resolution-failed', reason: `Could not resolve ${host}`, url, host })
    return bad(res, 502, 'dns resolution failed')
  }
  const network = evaluateNetworkDestination(manifest, { host, port, addresses, classification: named.classification, url: named.destination.url })
  if (network.decision === 'deny') {
    decide({ decision: 'deny', rule: network.rule, reason: network.reason, url, host, port, addresses })
    return bad(res, 403, `denied: ${network.reason}`)
  }
  const pinned = network.destination.addresses[0]?.address ?? addresses[0]!
  const pinnedIp = parseIp(pinned)
  const dial = pinnedIp && classifyIp(pinnedIp) === 'loopback' ? HOST_GATEWAY : pinned

  issued++
  await acquire()
  decide({ decision: 'allow', rule: network.rule, reason: network.reason, url, host, port, address: pinned })
  const upstream = http.request(
    { host: dial, port, path: new URL(url).pathname + new URL(url).search, method: req.method, headers: { ...req.headers, host: `${host}${port === 80 ? '' : `:${port}`}` }, timeout: 30_000 },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
      up.on('end', release)
    },
  )
  upstream.on('error', (e: NodeJS.ErrnoException) => {
    release()
    if (!res.headersSent) bad(res, 502, `upstream error: ${e.code ?? e.message}`)
    else res.end()
  })
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
  req.pipe(upstream)
})

// HTTPS tunnelling is not mediated in this phase: refuse CONNECT rather than open an opaque tunnel.
server.on('connect', (req, socket: net.Socket) => {
  decide({ decision: 'deny', rule: 'gateway.connect-unsupported', reason: 'HTTPS CONNECT tunnelling is not mediated in this phase', url: req.url })
  socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
})

function summary(): void {
  try {
    appendFileSync(DECISIONS, JSON.stringify({ at: new Date().toISOString(), summary: { ...counters, byReason } }) + '\n')
  } catch {
    /* ignore */
  }
  process.stdout.write(`AUDIVRA_GATEWAY_SUMMARY ${JSON.stringify({ ...counters, byReason })}\n`)
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (summary(), process.exit(0)))
server.listen(PORT, '0.0.0.0', () => process.stdout.write(`AUDIVRA_GATEWAY_READY ${PORT}\n`))
