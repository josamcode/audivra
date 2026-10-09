import { z } from 'zod'
import type { SensorResult } from '@audivra/contracts'
import type { SecurityCapability, SensorNormalizeContext } from './adapter.ts'
import { defineSensor, parseJsonl } from './adapter.ts'
import { classifyDiscovered } from '../execution/observations.ts'

/*
 * Katana sensor (ProjectDiscovery katana) — a bounded, same-site crawl of an in-scope seed URL. Audivra
 * builds every argument; katana reaches targets only through the execution gateway, which enforces scope
 * on every request. katana's own crawl scope is pinned to the seed host and it is told to *emit* (not
 * follow) out-of-scope endpoints it discovers, so discovered destinations are recorded and scope-
 * classified without ever being contacted. Output is normalized into endpoint, form and technology
 * observations, backed by the raw JSONL kept as evidence.
 */

const Input = z.strictObject({
  /** The seed URL to crawl (authorized target; the gateway enforces scope on every crawl request). */
  url: z.string().trim().min(1).max(2048),
  maxDepth: z.number().int().min(1).max(3).default(2),
  durationSeconds: z.number().int().min(1).max(120).default(20),
  concurrency: z.number().int().min(1).max(5).default(2),
})
type Input = z.infer<typeof Input>

const Form = z.object({ method: z.string().optional(), action: z.string().optional(), enctype: z.string().optional(), parameters: z.array(z.string()).optional() }).loose()
/** The subset of katana's JSONL record we read; unknown fields ignored, malformed lines skipped. */
const Record = z
  .object({
    request: z.object({ method: z.string().optional(), endpoint: z.string().optional(), tag: z.string().optional(), attribute: z.string().optional(), source: z.string().optional() }).loose().optional(),
    response: z.object({ status_code: z.number().int().optional(), server: z.string().optional(), content_type: z.string().optional(), technologies: z.array(z.string()).optional(), forms: z.array(Form).optional() }).loose().optional(),
  })
  .loose()

const OUTPUT_FILE = 'katana.jsonl'

function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || '/'
  } catch {
    return url
  }
}

async function normalize(ctx: SensorNormalizeContext<Input>): Promise<{ observations: number; state?: 'success' | 'partial'; reason?: string | null; summary?: string }> {
  const rows = parseJsonl(ctx.raw)
  if (rows.length === 0) return { observations: 0, state: 'partial', reason: 'katana discovered no endpoints (seed did not respond or was filtered by the gateway)' }
  const manifest = ctx.context.scope.manifest
  let count = 0
  let inScope = 0
  let discoveredOut = 0
  for (const raw of rows) {
    const parsed = Record.safeParse(raw)
    if (!parsed.success) continue
    const endpoint = parsed.data.request?.endpoint
    if (!endpoint) continue
    const req = parsed.data.request ?? {}
    const res = parsed.data.response ?? {}
    const scopeClass = classifyDiscovered(manifest, endpoint)
    if (scopeClass === 'in-scope') inScope++
    else discoveredOut++

    await ctx.handles.observations.record({
      type: 'endpoint',
      asset: endpoint,
      subject: req.method ?? 'get',
      title: `${(req.method ?? 'GET').toUpperCase()} ${pathOf(endpoint)}`,
      scopeClass,
      value: { method: req.method ?? null, tag: req.tag ?? null, attribute: req.attribute ?? null, source: req.source ?? null, status: res.status_code ?? null, contacted: scopeClass === 'in-scope' },
      evidenceRef: ctx.evidenceRef,
      confidence: 1,
    })
    count++

    for (const tech of res.technologies ?? []) {
      await ctx.handles.observations.record({ type: 'technology', asset: endpoint, subject: tech, title: `Technology: ${tech}`, sourceType: 'tool-inferred', value: { technology: tech }, evidenceRef: ctx.evidenceRef, confidence: 0.9 })
      count++
    }

    for (const form of res.forms ?? []) {
      const action = form.action ?? endpoint
      await ctx.handles.observations.record({
        type: 'form',
        asset: endpoint,
        subject: `${(form.method ?? 'get').toLowerCase()} ${action}`,
        title: `Form ${(form.method ?? 'GET').toUpperCase()} → ${action}`,
        value: { method: form.method ?? null, action, enctype: form.enctype ?? null, parameters: form.parameters ?? [] },
        evidenceRef: ctx.evidenceRef,
        confidence: 1,
      })
      count++
    }
  }
  return {
    observations: count,
    state: 'success',
    summary: `katana: ${count} observation${count === 1 ? '' : 's'} (${inScope} in-scope endpoint${inScope === 1 ? '' : 's'} crawled, ${discoveredOut} out-of-scope destination${discoveredOut === 1 ? '' : 's'} recorded but not contacted)`,
  }
}

export const katanaSensorCapability: SecurityCapability<Input, SensorResult> = defineSensor<Input>({
  id: 'discovery.crawl',
  version: 1,
  family: 'discovery',
  name: 'Site crawl (katana)',
  description: 'Crawls an in-scope seed URL with katana through the execution gateway, pinned to the seed host, recording discovered endpoints, forms and technologies as scope-classified observations. Out-of-scope destinations are recorded but never contacted.',
  runtime: 'katana',
  tool: 'katana',
  network: 'scoped-egress',
  riskClass: 'low-impact',
  sideEffect: 'read-only',
  supportedEnvironments: ['production', 'staging', 'isolated-lab'],
  requiresAuthorization: true,
  timeoutProfile: { defaultSeconds: 180, maxSeconds: 600 },
  evidenceTypes: ['tool-result'],
  observationTypes: ['endpoint', 'form', 'technology'],
  input: Input,
  targets: (input) => [input.url],
  outputFile: OUTPUT_FILE,
  maxRawBytes: 8 * 1024 * 1024,
  buildArgs: (_context, input, io) => {
    const args = [
      '-u',
      input.url,
      '-jsonl',
      '-silent',
      '-no-color',
      '-duc',
      '-d',
      String(input.maxDepth),
      '-ct',
      String(input.durationSeconds),
      '-c',
      String(input.concurrency),
      '-rl',
      '20',
      '-timeout',
      '10',
      '-fx', // extract forms/inputs into the JSONL output
      '-do', // emit discovered out-of-scope endpoints (recorded, never crawled)
      '-fs',
      'fqdn', // katana's own crawl scope pinned to the exact seed host
      '-o',
      `${io.outputs}/${OUTPUT_FILE}`,
    ]
    // Reach targets only through the execution gateway; the gateway resolves DNS and enforces scope.
    if (io.egressProxy) args.push('-proxy', io.egressProxy)
    return args
  },
  normalize,
})
