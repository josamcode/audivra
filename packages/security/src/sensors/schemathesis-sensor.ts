import { z } from 'zod'
import type { SensorResult } from '@audivra/contracts'
import type { SecurityCapability, SensorNormalizeContext } from './adapter.ts'
import { defineSensor } from './adapter.ts'
import { classifyDiscovered } from '../execution/observations.ts'

/*
 * Schemathesis sensor — property-based testing of a staged API schema (OpenAPI/GraphQL) against an
 * in-scope API, reached only through the execution gateway. Audivra controls the schema, the base URL,
 * the limits and the runtime; no arbitrary arguments. The JSON run report is normalized into API
 * observations (operations exercised, contract/validation divergences, stateful signals). A divergence is
 * a *signal to review*, never an automatic client finding, and the tool's own severity never becomes
 * Audivra's severity.
 */

const Input = z.strictObject({
  /** The API schema document (OpenAPI/GraphQL), staged read-only into the container. */
  schema: z.string().trim().min(1).max(2_000_000),
  schemaFormat: z.enum(['json', 'yaml']).default('json'),
  /** The API base URL (authorized target; the gateway enforces scope on every request). */
  url: z.string().trim().min(1).max(2048),
  maxExamples: z.number().int().min(1).max(100).default(15),
})
type Input = z.infer<typeof Input>

/** The subset of Schemathesis's JSON run report we read. Unknown fields ignored. */
const Report = z
  .object({
    complete: z.boolean().optional(),
    exit_code: z.number().int().optional(),
    operations: z.object({ total: z.number().optional(), tested: z.number().optional(), errored: z.number().optional() }).loose().optional(),
    phases: z.record(z.string(), z.object({ status: z.string().optional() }).loose()).optional(),
    valid_rates: z.record(z.string(), z.unknown()).optional(),
    failures: z.array(z.object({ type: z.string().optional(), title: z.string().optional(), severity: z.string().optional(), count: z.number().optional(), operations: z.array(z.string()).optional() }).loose()).optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .loose()

const OUTPUT_FILE = 'schemathesis.json'
const schemaFile = (format: 'json' | 'yaml') => `schema.${format}`

async function normalize(ctx: SensorNormalizeContext<Input>): Promise<{ observations: number; state?: 'success' | 'partial' | 'failed'; reason?: string | null; summary?: string }> {
  if (ctx.raw === null) return { observations: 0, state: 'partial', reason: 'Schemathesis produced no JSON report (it may have failed to load the schema or reach the API)' }
  let report: z.infer<typeof Report>
  try {
    report = Report.parse(JSON.parse(ctx.raw))
  } catch (error) {
    throw new Error(`Schemathesis report was not parseable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const manifest = ctx.context.scope.manifest
  const scopeClass = classifyDiscovered(manifest, ctx.input.url)
  let count = 0

  // Operations exercised (deterministic discovery).
  const operations = Object.keys(report.valid_rates ?? {})
  for (const op of operations) {
    await ctx.handles.observations.record({
      type: 'api-operation',
      asset: ctx.input.url,
      subject: op,
      title: `API operation ${op}`,
      scopeClass,
      value: { operation: op },
      evidenceRef: ctx.evidenceRef,
      confidence: 1,
    })
    count++
  }

  // Contract/validation divergences — signals to review, not findings. The tool's severity is stored but
  // is NOT Audivra's severity.
  for (const failure of report.failures ?? []) {
    const type = failure.type ?? 'divergence'
    for (const op of failure.operations ?? ['(unknown operation)']) {
      await ctx.handles.observations.record({
        type: 'api-validation',
        asset: ctx.input.url,
        subject: `${type} ${op}`,
        title: failure.title ?? type,
        scopeClass,
        sourceType: 'tool-reported',
        value: { type, title: failure.title ?? null, toolSeverity: failure.severity ?? null, operation: op, count: failure.count ?? 1 },
        evidenceRef: ctx.evidenceRef,
        confidence: 0.85,
      })
      count++
    }
  }

  // A stateful-phase failure is a workflow/state signal.
  if (report.phases?.stateful?.status === 'failure') {
    await ctx.handles.observations.record({
      type: 'api-workflow',
      asset: ctx.input.url,
      subject: 'stateful',
      title: 'Stateful workflow divergence',
      scopeClass,
      sourceType: 'tool-inferred',
      value: { phase: 'stateful' },
      evidenceRef: ctx.evidenceRef,
      confidence: 0.7,
    })
    count++
  }

  const errored = report.errors?.length ?? 0
  const complete = report.complete !== false
  const state: 'success' | 'partial' = complete && errored === 0 ? 'success' : 'partial'
  return {
    observations: count,
    state,
    reason: errored > 0 ? `${errored} Schemathesis error(s) during the run` : complete ? null : 'Schemathesis did not complete',
    summary: `schemathesis: ${operations.length} operation${operations.length === 1 ? '' : 's'}, ${(report.failures ?? []).length} contract divergence group${(report.failures ?? []).length === 1 ? '' : 's'}`,
  }
}

export const schemathesisSensorCapability: SecurityCapability<Input, SensorResult> = defineSensor<Input>({
  id: 'api.contract-test',
  version: 1,
  family: 'api',
  name: 'API contract testing (Schemathesis)',
  description: 'Tests an in-scope API against a staged OpenAPI/GraphQL schema with Schemathesis, through the execution gateway, and records operations and contract divergences as API observations (signals, not findings).',
  runtime: 'schemathesis',
  tool: 'schemathesis',
  network: 'scoped-egress',
  riskClass: 'low-impact',
  sideEffect: 'read-only',
  supportedEnvironments: ['staging', 'isolated-lab'],
  requiresAuthorization: true,
  requiredInputs: ['schema', 'url'],
  costClass: 'medium',
  typicalDurationSeconds: 60,
  timeoutProfile: { defaultSeconds: 300, maxSeconds: 900 },
  evidenceTypes: ['tool-result'],
  observationTypes: ['api-operation', 'api-validation', 'api-workflow'],
  input: Input,
  targets: (input) => [input.url],
  outputFile: OUTPUT_FILE,
  maxRawBytes: 8 * 1024 * 1024,
  async stage(_context, input, into) {
    await into.write(schemaFile(input.schemaFormat), input.schema)
  },
  buildArgs: (_context, input, io) => {
    const args = [
      'run',
      `${io.inputs}/${schemaFile(input.schemaFormat)}`,
      '--url',
      input.url,
      '--report',
      'json',
      '--report-dir',
      `${io.outputs}/sch-report`,
      '--report-json-path',
      `${io.outputs}/${OUTPUT_FILE}`,
      '--coverage-no-report',
      '--generation-database',
      'none', // no Hypothesis example DB in the read-only working directory
      '--seed',
      '0',
      '--max-examples',
      String(input.maxExamples),
      '--workers',
      '1',
      '--no-color',
    ]
    // Reach the API only through the execution gateway; the gateway resolves DNS and enforces scope.
    if (io.egressProxy) args.push('--proxy', io.egressProxy)
    return args
  },
  normalize,
})
