import { z } from 'zod'
import type { SensorResult } from '@audivra/contracts'
import type { SecurityCapability, SensorNormalizeContext } from './adapter.ts'
import { defineSensor, parseJsonl } from './adapter.ts'
import { classifyDiscovered } from '../execution/observations.ts'
import { AUDIVRA_NUCLEI_TEMPLATES } from './nuclei-templates.ts'

/*
 * Nuclei sensor — template-driven web signals against an in-scope URL, reached only through the execution
 * gateway. It runs ONLY Audivra's reviewed, staged templates (never the bundled public set, never a
 * user/model path), with OAST disabled and template updates disabled. Each match is a `web-signal`
 * observation: a signal to review, never a verified vulnerability. The template severity is recorded but
 * is NOT Audivra's severity. Restricted to staging / isolated-lab environments.
 */

const Input = z.strictObject({
  /** The URL to probe (authorized target; the gateway enforces scope on every request). */
  url: z.string().trim().min(1).max(2048),
})
type Input = z.infer<typeof Input>

/** The subset of a Nuclei JSONL result we read. Unknown fields ignored, malformed lines skipped. */
const Match = z
  .object({
    'template-id': z.string().optional(),
    'matched-at': z.string().optional(),
    host: z.string().optional(),
    type: z.string().optional(),
    'matcher-name': z.string().optional(),
    'extracted-results': z.array(z.string()).optional(),
    info: z.object({ name: z.string().optional(), severity: z.string().optional() }).loose().optional(),
  })
  .loose()

const OUTPUT_FILE = 'nuclei.jsonl'
const TEMPLATES_DIR = 'templates'

async function normalize(ctx: SensorNormalizeContext<Input>): Promise<{ observations: number; state?: 'success' | 'partial'; reason?: string | null; summary?: string }> {
  // No matches is a normal, successful outcome (nuclei writes the file only when something matches): an
  // empty/absent output with a clean exit means "ran, nothing matched", not a failure.
  const rows = parseJsonl(ctx.raw)
  const manifest = ctx.context.scope.manifest
  let count = 0
  for (const raw of rows) {
    const parsed = Match.safeParse(raw)
    if (!parsed.success) continue
    const m = parsed.data
    const asset = m['matched-at'] ?? (m.host ? `http://${m.host}` : ctx.input.url)
    const templateId = m['template-id'] ?? 'unknown-template'
    await ctx.handles.observations.record({
      type: 'web-signal',
      asset,
      subject: templateId,
      title: m.info?.name ?? templateId,
      scopeClass: classifyDiscovered(manifest, asset),
      // A template match is a scanner heuristic — a signal to verify, not a verdict.
      sourceType: 'tool-heuristic',
      value: { templateId, toolSeverity: m.info?.severity ?? null, name: m.info?.name ?? null, matcher: m['matcher-name'] ?? null, extracted: m['extracted-results'] ?? [] },
      evidenceRef: ctx.evidenceRef,
      confidence: 0.5,
    })
    count++
  }
  return { observations: count, state: 'success', summary: `nuclei: ${count} web signal${count === 1 ? '' : 's'} from ${Object.keys(AUDIVRA_NUCLEI_TEMPLATES).length} reviewed template${Object.keys(AUDIVRA_NUCLEI_TEMPLATES).length === 1 ? '' : 's'}` }
}

export const nucleiSensorCapability: SecurityCapability<Input, SensorResult> = defineSensor<Input>({
  id: 'web.signal-scan',
  version: 1,
  family: 'web',
  name: 'Web signal scan (Nuclei)',
  description: 'Runs Audivra’s reviewed, passive Nuclei templates against an in-scope URL through the execution gateway (OAST and template updates disabled), recording matches as web-signal observations (signals to review, not verified vulnerabilities).',
  runtime: 'nuclei',
  tool: 'nuclei',
  network: 'scoped-egress',
  riskClass: 'low-impact',
  sideEffect: 'read-only',
  // Deliberately not production: a request-sending scanner runs only in staging / isolated lab.
  supportedEnvironments: ['staging', 'isolated-lab'],
  requiresAuthorization: true,
  requiredInputs: ['url', 'templates'],
  costClass: 'medium',
  typicalDurationSeconds: 45,
  timeoutProfile: { defaultSeconds: 180, maxSeconds: 600 },
  evidenceTypes: ['tool-result'],
  observationTypes: ['web-signal'],
  input: Input,
  targets: (input) => [input.url],
  outputFile: OUTPUT_FILE,
  maxRawBytes: 8 * 1024 * 1024,
  async stage(_context, _input, into) {
    for (const [name, content] of Object.entries(AUDIVRA_NUCLEI_TEMPLATES)) await into.write(`${TEMPLATES_DIR}/${name}`, content)
  },
  buildArgs: (_context, input, io) => {
    const args = [
      '-u',
      input.url,
      '-t',
      `${io.inputs}/${TEMPLATES_DIR}`, // ONLY Audivra's reviewed templates
      '-disable-update-check',
      '-no-interactsh', // no OAST calls to shared/public infrastructure
      '-jsonl',
      '-o',
      `${io.outputs}/${OUTPUT_FILE}`,
      '-silent',
      '-no-color',
    ]
    // Reach the target only through the execution gateway; the gateway resolves DNS and enforces scope.
    if (io.egressProxy) args.push('-proxy', io.egressProxy)
    return args
  },
  normalize,
})
