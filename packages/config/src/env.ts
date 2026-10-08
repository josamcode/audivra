import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { REPO_ROOT } from './paths.ts'

let loaded = false

/** Loads the repository .env once (without overriding variables already set in the process). */
export function loadEnv(): void {
  if (loaded) return
  loaded = true
  const file = path.join(REPO_ROOT, '.env')
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file)
    } catch {
      // A malformed .env should not prevent startup; defaults apply.
    }
  }
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))

const Env = z.object({
  DATABASE_URL: z.string().default('postgres://audivra:audivra@127.0.0.1:5440/audivra'),
  TEST_DATABASE_URL: z.string().default('postgres://audivra:audivra@127.0.0.1:5440/audivra_test'),
  SERVER_PORT: z.coerce.number().int().default(4310),
  WEB_PORT: z.coerce.number().int().default(4300),
  AUDIVRA_AI: z.enum(['claude', 'off']).default('claude'),
  AUDITOR_MODEL: optionalString,
  AUDITOR_EFFORT: optionalString,
  REVIEWER_MODEL: optionalString,
  REVIEWER_EFFORT: optionalString,
  FINALIZER_MODEL: optionalString,
  FINALIZER_EFFORT: optionalString,
  PRESENTER_MODEL: optionalString,
  PRESENTER_EFFORT: optionalString,
  AUDITOR_TIMEOUT_MINUTES: z.coerce.number().positive().default(60),
  AUDITOR_MAX_TURNS: z.coerce.number().int().positive().default(400),
  /** Safety ceilings for one investigation run (normal audits use a fraction of these). */
  AUDITOR_MAX_BROWSER_ACTIONS: z.coerce.number().int().positive().default(300),
  AUDITOR_MAX_COMMANDS: z.coerce.number().int().positive().default(200),
  AUDITOR_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(600),
  AUDIT_MAX_REVISIONS: z.coerce.number().int().min(0).max(3).default(1),
  BASELINE_MAX_PAGES: z.coerce.number().int().positive().default(30),
  BASELINE_MAX_LINK_CHECKS: z.coerce.number().int().positive().default(200),
  BASELINE_BROWSER_PAGES: z.coerce.number().int().positive().default(4),
  /** Optional baseline scanners (comma-separated): httpx, katana, pa11y, zap, testssl. Empty disables all. */
  BASELINE_SCANNERS: z.string().default('httpx,katana,pa11y,zap,testssl'),
  /**
   * Security capability executions are refused when the data volume has less free space than this.
   * Operational threshold only: security *policy* lives in versioned policy profiles, not here.
   */
  SECURITY_MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(2048),
  /**
   * Security executions that may be active at once across every worker sharing the database (also the
   * worker's pg-boss concurrency for the execution queue). Operational capacity, not policy.
   */
  SECURITY_EXECUTION_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  CLAUDE_BIN: z.string().default('claude'),
})
export type AppConfig = z.infer<typeof Env>

let cached: AppConfig | undefined

export function getConfig(): AppConfig {
  if (cached) return cached
  loadEnv()
  cached = Env.parse(process.env)
  return cached
}

/** For tests: re-read configuration after mutating process.env. */
export function resetConfig(): void {
  cached = undefined
}
