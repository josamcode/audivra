import { z } from 'zod'
import type { SensorResult } from '@audivra/contracts'
import type { SecurityCapability, SensorNormalizeContext } from './adapter.ts'
import { defineSensor } from './adapter.ts'
import { AUDIVRA_SEMGREP_RULES } from './semgrep-rules.ts'

/*
 * Semgrep sensor (Semgrep CE) — static analysis of a staged source tree with Audivra's reviewed, in-repo
 * ruleset. It runs with NO network: only the staged source (read-only) is mounted, and the rules are
 * shipped with Audivra, never fetched. Semgrep exits 1 when it has findings — a *successful* run — so the
 * adapter classifies the result from the exit code, not by assuming non-zero means failure. Each match is
 * normalized into a `source-finding` observation: a signal to review, never a verified vulnerability.
 */

const STAGED = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\-/]{1,200}$/
const SourceFile = z.strictObject({
  /** Repository-relative path (no absolute paths, no `..`). */
  path: z.string().trim().min(1).max(200).regex(STAGED, 'must be a safe relative path'),
  content: z.string().max(1_000_000),
})
const Input = z.strictObject({
  /** The source tree to analyse, staged read-only into the container. */
  files: z.array(SourceFile).min(1).max(500),
  maxTargetBytes: z.number().int().min(1_000).max(5_000_000).default(1_000_000),
})
type Input = z.infer<typeof Input>

const Result = z
  .object({
    results: z
      .array(
        z
          .object({
            check_id: z.string().optional(),
            path: z.string().optional(),
            start: z.object({ line: z.number().int().optional() }).loose().optional(),
            end: z.object({ line: z.number().int().optional() }).loose().optional(),
            extra: z.object({ message: z.string().optional(), severity: z.string().optional() }).loose().optional(),
          })
          .loose(),
      )
      .optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .loose()

const OUTPUT_FILE = 'semgrep.json'
const SRC_DIR = 'src'
const RULES_FILE = 'rules/audivra.yaml'

/** Strip the container staging prefix so the asset is the repository-relative path. */
function relativeSource(containerPath: string, inputsDir: string): string {
  const prefix = `${inputsDir}/${SRC_DIR}/`
  return containerPath.startsWith(prefix) ? containerPath.slice(prefix.length) : containerPath.replace(/^.*\/src\//, '')
}

async function normalize(ctx: SensorNormalizeContext<Input>): Promise<{ observations: number; state?: 'success' | 'partial' | 'failed'; reason?: string | null; summary?: string }> {
  const exitCode = ctx.run.exitCode
  // Semgrep: 0 = ran, no findings; 1 = ran, findings present; >=2 = semgrep itself errored.
  if (exitCode >= 2) return { observations: 0, state: 'failed', reason: `semgrep exited ${exitCode} (analysis error)` }
  if (ctx.raw === null) return { observations: 0, state: 'partial', reason: 'semgrep produced no output file' }
  let parsed: z.infer<typeof Result>
  try {
    parsed = Result.parse(JSON.parse(ctx.raw))
  } catch (error) {
    throw new Error(`semgrep JSON was not parseable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const inputsDir = '/audivra/inputs'
  let count = 0
  for (const r of parsed.results ?? []) {
    const checkId = r.check_id ?? 'unknown-rule'
    const line = r.start?.line ?? 0
    const asset = r.path ? relativeSource(r.path, inputsDir) : 'unknown'
    const severity = (r.extra?.severity ?? 'INFO').toUpperCase()
    const message = (r.extra?.message ?? checkId).replace(/\s+/g, ' ').trim().slice(0, 240)
    await ctx.handles.observations.record({
      type: 'source-finding',
      asset,
      subject: `${checkId}:${line}`,
      title: `${checkId} (${severity})`,
      value: { checkId, severity, startLine: line, endLine: r.end?.line ?? line, message, path: asset },
      evidenceRef: ctx.evidenceRef,
      // A static-analysis match is a signal, not a verdict: moderate confidence, never a finding.
      confidence: severity === 'ERROR' ? 0.7 : 0.5,
    })
    count++
  }
  const errors = parsed.errors?.length ?? 0
  return {
    observations: count,
    state: errors > 0 && count === 0 ? 'partial' : 'success',
    reason: errors > 0 ? `${errors} semgrep parse error(s) in the staged source` : null,
    summary: `semgrep: ${count} source-finding signal${count === 1 ? '' : 's'} across ${ctx.input.files.length} file${ctx.input.files.length === 1 ? '' : 's'}`,
  }
}

export const semgrepSensorCapability: SecurityCapability<Input, SensorResult> = defineSensor<Input>({
  id: 'source.static-analysis',
  version: 1,
  family: 'source',
  name: 'Static source analysis (Semgrep CE)',
  description: 'Runs Semgrep CE with Audivra’s reviewed ruleset over a staged source tree, with no network, and records each match as a source-finding observation (a signal to review, not a verified vulnerability).',
  runtime: 'semgrep',
  tool: 'semgrep',
  network: 'none',
  riskClass: 'passive',
  sideEffect: 'read-only',
  supportedEnvironments: ['production', 'staging', 'isolated-lab'],
  requiresAuthorization: false,
  timeoutProfile: { defaultSeconds: 300, maxSeconds: 900 },
  evidenceTypes: ['tool-result'],
  observationTypes: ['source-finding'],
  input: Input,
  // Static analysis contacts no network target; there are no destinations to scope-check.
  targets: () => [],
  outputFile: OUTPUT_FILE,
  maxRawBytes: 8 * 1024 * 1024,
  async stage(_context, input, into) {
    await into.write(RULES_FILE, AUDIVRA_SEMGREP_RULES)
    for (const file of input.files) await into.write(`${SRC_DIR}/${file.path}`, file.content)
  },
  buildArgs: (_context, input, io) => [
    'scan',
    '--config',
    `${io.inputs}/${RULES_FILE}`,
    '--json',
    '--output',
    `${io.outputs}/${OUTPUT_FILE}`,
    '--metrics=off',
    '--disable-version-check',
    '--no-git-ignore',
    '--oss-only',
    '--timeout',
    '30',
    '--timeout-threshold',
    '3',
    '--max-target-bytes',
    String(input.maxTargetBytes),
    `${io.inputs}/${SRC_DIR}`,
  ],
  normalize,
})
