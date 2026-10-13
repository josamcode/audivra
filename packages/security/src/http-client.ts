import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { parseIp, type ExecutionLimits, type MutationClass, type ScopeEvaluation, type ScopeManifest } from '@audivra/contracts'
import type { Resolver } from './dns.ts'
import { evaluateNetworkDestination, evaluateRedirect, evaluateUrl } from './scope.ts'

/*
 * The network boundary handed to capability executors. Executors never open sockets themselves: every
 * request goes through `request()`, which for each hop (the first request and every redirect)
 *   1. checks the HTTP method against the capability's mutation class,
 *   2. takes a request from the execution budget (count, rate, concurrency),
 *   3. evaluates the URL against scope (redirects as independent destinations),
 *   4. resolves the host and evaluates the resolved addresses,
 *   5. connects to an address that was just evaluated (pinned: no second DNS lookup).
 * Every attempt, allowed or denied, is logged for the execution record.
 *
 * Limitation: this binds code that uses the client. It is not an OS or network-level control — a
 * process could still open its own sockets. That guarantee needs the mediated egress / isolation layer
 * planned for a later phase (docs/security-engagements.md).
 */

export const SECURITY_USER_AGENT = 'Audivra-Security/0.1 (authorized engagement)'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export class ScopeViolationError extends Error {
  constructor(readonly evaluation: ScopeEvaluation) {
    super(`Out of scope: ${evaluation.reason}`)
    this.name = 'ScopeViolationError'
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export interface NetworkAttempt {
  url: string
  method: string
  decision: 'allow' | 'deny'
  rule: string
  reason: string
  addresses: string[]
  status: number | null
  error: string | null
  at: string
}

export interface ScopedRequest {
  url: string
  method?: 'GET' | 'HEAD' | 'OPTIONS'
  followRedirects?: boolean
}

export interface ScopedResponse {
  requestedUrl: string
  finalUrl: string
  status: number
  headers: Record<string, string | string[]>
  bodyBytes: number
  bodySha256: string | null
  truncated: boolean
  redirects: { from: string; to: string; status: number }[]
  /** A redirect the scope engine refused; it was not followed. */
  blockedRedirect: { location: string; evaluation: ScopeEvaluation } | null
}

export interface ScopedHttpClientOptions {
  manifest: ScopeManifest
  limits: ExecutionLimits
  mutation: MutationClass
  resolver: Resolver
  signal: AbortSignal
  /**
   * Identity-aware auth material injected by the trusted runtime (Phase 5 Step 3). Attached ONLY to
   * requests whose origin matches `origin`, so a session's cookies/token never leak to another host even
   * across an in-scope redirect. Never set from capability input or model output.
   */
  auth?: { headers: Record<string, string>; origin: string } | null
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('Aborted'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason ?? new Error('Aborted'))), { once: true })
  })

export class ScopedHttpClient {
  readonly attempts: NetworkAttempt[] = []
  #issued = 0
  #active = 0
  #nextStart = 0
  #waiters: (() => void)[] = []

  constructor(private readonly options: ScopedHttpClientOptions) {}

  get requestCount(): number {
    return this.#issued
  }

  async request(request: ScopedRequest): Promise<ScopedResponse> {
    const method = request.method ?? 'GET'
    // This client only ever sends safe methods, whatever the capability's mutation class: writing
    // capabilities will need their own reviewed client.
    if (!SAFE_METHODS.has(method)) {
      throw new ScopeViolationError(this.#policyDenial(request.url, `HTTP ${method} is not permitted (${this.options.mutation} capability, safe methods only)`))
    }
    const first = evaluateUrl(this.options.manifest, request.url)
    const redirects: ScopedResponse['redirects'] = []
    let current = request.url
    let evaluation = first
    for (let hop = 0; ; hop++) {
      if (evaluation.decision === 'deny') {
        this.#log(current, method, evaluation, [], null, null)
        throw new ScopeViolationError(evaluation)
      }
      const response = await this.#hop(current, method, evaluation)
      const location = response.headers.location
      const isRedirect = response.status >= 300 && response.status < 400 && typeof location === 'string'
      if (!isRedirect || request.followRedirects === false) {
        return { requestedUrl: request.url, finalUrl: current, redirects, blockedRedirect: null, ...response }
      }
      const next = evaluateRedirect(this.options.manifest, current, location, hop + 1)
      if (next.decision === 'deny') {
        this.#log(next.destination.url ?? location, method, next, [], null, null)
        return { requestedUrl: request.url, finalUrl: current, redirects, blockedRedirect: { location, evaluation: next }, ...response }
      }
      redirects.push({ from: current, to: next.destination.url!, status: response.status })
      current = next.destination.url!
      evaluation = next
    }
  }

  #policyDenial(url: string, reason: string): ScopeEvaluation {
    return {
      decision: 'deny',
      rule: 'policy.method-not-permitted',
      reason,
      kind: 'url',
      classification: 'invalid',
      destination: { url, scheme: null, host: null, port: null, path: null, addresses: [] },
      from: null,
      matched: null,
      limitations: [],
    }
  }

  #log(url: string, method: string, evaluation: ScopeEvaluation, addresses: string[], status: number | null, error: string | null) {
    this.attempts.push({ url, method, decision: evaluation.decision, rule: evaluation.rule, reason: evaluation.reason, addresses, status, error, at: new Date().toISOString() })
  }

  async #acquire(): Promise<void> {
    const { limits, signal } = this.options
    if (this.#issued >= limits.maxRequests) throw new BudgetExceededError(`Request budget of ${limits.maxRequests} exhausted`)
    this.#issued++
    while (this.#active >= limits.concurrency) await new Promise<void>((resolve) => this.#waiters.push(resolve))
    this.#active++
    const wait = this.#nextStart - Date.now()
    this.#nextStart = Math.max(Date.now(), this.#nextStart) + 1000 / limits.requestsPerSecond
    if (wait > 0) await sleep(wait, signal)
  }

  #release(): void {
    this.#active--
    this.#waiters.shift()?.()
  }

  async #hop(url: string, method: string, nameEvaluation: ScopeEvaluation): Promise<Omit<ScopedResponse, 'requestedUrl' | 'finalUrl' | 'redirects' | 'blockedRedirect'>> {
    await this.#acquire()
    try {
      const host = nameEvaluation.destination.host!
      const port = nameEvaluation.destination.port!
      let addresses: string[]
      try {
        addresses = parseIp(host) ? [host] : await this.options.resolver(host, this.options.signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#log(url, method, { ...nameEvaluation, decision: 'deny', rule: 'dns.lookup-failed', reason: message }, [], null, message)
        throw error
      }
      const network = evaluateNetworkDestination(this.options.manifest, { host, port, addresses, classification: nameEvaluation.classification, url })
      if (network.decision === 'deny') {
        this.#log(url, method, network, addresses, null, null)
        throw new ScopeViolationError(network)
      }
      const pinned = network.destination.addresses[0]!.address
      try {
        const response = await this.#send(url, method, pinned)
        this.#log(url, method, network, addresses, response.status, null)
        return response
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#log(url, method, network, addresses, null, message)
        throw error
      }
    } finally {
      this.#release()
    }
  }

  #send(url: string, method: string, address: string): Promise<Omit<ScopedResponse, 'requestedUrl' | 'finalUrl' | 'redirects' | 'blockedRedirect'>> {
    const target = new URL(url)
    const family = parseIp(address)!.family
    // Connect to the address that was just evaluated instead of resolving the name again.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) (callback as unknown as (e: null, list: { address: string; family: number }[]) => void)(null, [{ address, family }])
      else callback(null, address, family)
    }
    const transport = target.protocol === 'https:' ? https : http
    const { maxResponseBytes, executionTimeoutSeconds } = this.options.limits
    // Auth material is attached only when the request origin matches the session's origin.
    const auth = this.options.auth && this.options.auth.origin === target.origin ? this.options.auth.headers : {}
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method,
          headers: { 'user-agent': SECURITY_USER_AGENT, accept: '*/*', ...auth },
          lookup,
          signal: this.options.signal,
          timeout: Math.min(executionTimeoutSeconds * 1000, 30_000),
        },
        (res) => {
          const hash = createHash('sha256')
          let bytes = 0
          let truncated = false
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > maxResponseBytes) {
              truncated = true
              res.destroy()
              return
            }
            hash.update(chunk)
          })
          const finish = () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: Object.fromEntries(Object.entries(res.headers).filter((e): e is [string, string | string[]] => e[1] !== undefined)),
              bodyBytes: bytes,
              bodySha256: bytes && !truncated ? hash.digest('hex') : null,
              truncated,
            })
          res.on('end', finish)
          res.on('close', () => (truncated ? finish() : undefined))
          res.on('error', (error) => (truncated ? finish() : reject(error)))
        },
      )
      req.on('timeout', () => req.destroy(new Error('Request timed out')))
      req.on('error', reject)
      req.end()
    })
  }
}
