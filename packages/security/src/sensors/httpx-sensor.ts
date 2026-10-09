import { z } from 'zod'
import type { SensorResult } from '@audivra/contracts'
import type { SecurityCapability, SensorNormalizeContext } from './adapter.ts'
import { defineSensor, parseJsonl } from './adapter.ts'
import { classifyDiscovered } from '../execution/observations.ts'

/*
 * httpx sensor (ProjectDiscovery httpx) — safe HTTP inspection of a single in-scope URL. Audivra builds
 * every argument; the only destination is the authorized target, reached through the execution gateway.
 * httpx is run without redirect-following, so a discovered redirect destination is recorded and scope-
 * classified but never contacted. Its JSON output is normalized into response, technology, header and
 * redirect observations, all backed by the raw JSONL kept as evidence.
 */

const Input = z.strictObject({
  /** The single HTTP URL to inspect (authorized target; the gateway enforces scope on the request). */
  url: z.string().trim().min(1).max(2048),
  /** Run httpx technology detection (wappalyzer). */
  techDetect: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(1).max(60).default(15),
})
type Input = z.infer<typeof Input>

/** The subset of httpx's JSON record we read. Unknown fields are ignored; malformed lines are skipped. */
const Record = z
  .object({
    url: z.string().optional(),
    input: z.string().optional(),
    status_code: z.number().int().optional(),
    title: z.string().optional(),
    webserver: z.string().optional(),
    content_type: z.string().optional(),
    content_length: z.number().optional(),
    method: z.string().optional(),
    scheme: z.string().optional(),
    host: z.string().optional(),
    location: z.string().optional(),
    tech: z.array(z.string()).optional(),
  })
  .loose()

const OUTPUT_FILE = 'httpx.jsonl'

/** Resolve a (possibly relative) redirect location against the source URL; null if it cannot be parsed. */
function resolveLocation(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString()
  } catch {
    return null
  }
}

async function normalize(ctx: SensorNormalizeContext<Input>): Promise<{ observations: number; state?: 'success' | 'partial'; reason?: string | null; summary?: string }> {
  const rows = parseJsonl(ctx.raw)
  if (rows.length === 0) return { observations: 0, state: 'partial', reason: 'httpx returned no result rows (target did not respond or was filtered by the gateway)' }
  const manifest = ctx.context.scope.manifest
  let count = 0
  for (const raw of rows) {
    const parsed = Record.safeParse(raw)
    if (!parsed.success) continue
    const r = parsed.data
    const asset = r.url ?? r.input
    if (!asset) continue

    // The HTTP response itself.
    if (r.status_code !== undefined) {
      await ctx.handles.observations.record({
        type: 'http-response',
        asset,
        subject: 'response',
        title: `HTTP ${r.status_code}${r.title ? ` · ${r.title}` : ''}`,
        value: { status: r.status_code, title: r.title ?? null, contentType: r.content_type ?? null, contentLength: r.content_length ?? null, method: r.method ?? null, scheme: r.scheme ?? null },
        evidenceRef: ctx.evidenceRef,
        confidence: 1,
      })
      count++
    }

    // The server header, when reported.
    if (r.webserver) {
      await ctx.handles.observations.record({ type: 'http-header', asset, subject: 'server', title: `Server: ${r.webserver}`, value: { header: 'server', value: r.webserver }, evidenceRef: ctx.evidenceRef, confidence: 1 })
      count++
    }

    // Detected technologies (inferred — wappalyzer fingerprints, not a verdict).
    for (const tech of r.tech ?? []) {
      await ctx.handles.observations.record({ type: 'technology', asset, subject: tech, title: `Technology: ${tech}`, sourceType: 'tool-inferred', value: { technology: tech }, evidenceRef: ctx.evidenceRef, confidence: 0.9 })
      count++
    }

    // A redirect: the destination is recorded and scope-classified but was NOT followed/contacted.
    if (r.location && r.status_code !== undefined && r.status_code >= 300 && r.status_code < 400) {
      const dest = resolveLocation(r.location, asset)
      const scopeClass = dest ? classifyDiscovered(manifest, dest) : 'unknown'
      await ctx.handles.observations.record({
        type: 'redirect',
        asset,
        subject: dest ?? r.location,
        title: `Redirect ${r.status_code} → ${dest ?? r.location}`,
        scopeClass,
        value: { status: r.status_code, location: r.location, destination: dest, followed: false },
        evidenceRef: ctx.evidenceRef,
        confidence: 1,
      })
      count++
    }
  }
  return { observations: count, state: 'success', summary: `httpx: ${count} observation${count === 1 ? '' : 's'} from ${rows.length} response${rows.length === 1 ? '' : 's'}` }
}

export const httpxSensorCapability: SecurityCapability<Input, SensorResult> = defineSensor<Input>({
  id: 'discovery.http-inspect',
  version: 1,
  family: 'discovery',
  name: 'HTTP inspection (httpx)',
  description: 'Inspects a single in-scope URL with httpx (status, title, server, technologies, redirect target) through the execution gateway, without following redirects, and records normalized observations.',
  runtime: 'httpx',
  tool: 'httpx',
  network: 'scoped-egress',
  requiredInputs: ['url'],
  costClass: 'low',
  typicalDurationSeconds: 30,
  riskClass: 'passive',
  sideEffect: 'read-only',
  supportedEnvironments: ['production', 'staging', 'isolated-lab'],
  requiresAuthorization: true,
  timeoutProfile: { defaultSeconds: 90, maxSeconds: 300 },
  evidenceTypes: ['tool-result'],
  observationTypes: ['http-response', 'http-header', 'technology', 'redirect'],
  input: Input,
  targets: (input) => [input.url],
  outputFile: OUTPUT_FILE,
  buildArgs: (_context, input, io) => {
    const args = [
      '-u',
      input.url,
      '-json',
      '-silent',
      '-no-color',
      '-no-stdin',
      '-disable-update-check',
      '-timeout',
      String(input.timeoutSeconds),
      '-retries',
      '1',
      '-o',
      `${io.outputs}/${OUTPUT_FILE}`,
    ]
    if (input.techDetect) args.push('-td')
    // Reach the target only through the execution gateway; the gateway resolves DNS and enforces scope.
    if (io.egressProxy) args.push('-proxy', io.egressProxy)
    return args
  },
  normalize,
})
