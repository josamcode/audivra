import { z } from 'zod'

/*
 * Phase 6F — operational diagnostics for the security platform (`pnpm doctor` / the System → Health view).
 * Every requirement reports a precise state with an explanation, the consequence of it being unmet, and a
 * concrete remediation step — never a generic "something went wrong". A missing OPTIONAL component degrades
 * gracefully; only a missing required one blocks.
 */

export const DIAGNOSTIC_STATES = ['ready', 'optional', 'needs-setup', 'unavailable', 'misconfigured'] as const
export const DiagnosticState = z.enum(DIAGNOSTIC_STATES)
export type DiagnosticState = z.infer<typeof DiagnosticState>

export const SystemCheck = z.object({
  id: z.string(),
  label: z.string(),
  /** Whether this requirement is required for a security assessment, or optional. */
  required: z.boolean(),
  state: DiagnosticState,
  detail: z.string(),
  /** What is lost / blocked while this is unmet. */
  consequence: z.string(),
  /** A concrete next step to fix it (empty when ready). */
  remediation: z.string(),
})
export type SystemCheck = z.infer<typeof SystemCheck>

/** An installed-vs-approved tool/runtime version row. */
export const ToolVersionStatus = z.object({
  name: z.string(),
  approved: z.string().nullable(),
  installed: z.string().nullable(),
  state: DiagnosticState,
  match: z.boolean(),
})
export type ToolVersionStatus = z.infer<typeof ToolVersionStatus>

/** Audivra-OWNED resources (never anything Audivra did not create), for the disk/leak views. */
export const OwnedResourceInventory = z.object({
  storageBytes: z.number().int(),
  dataDir: z.string(),
  ownedProcesses: z.number().int(),
  ownedContainers: z.array(z.string()),
  ownedNetworks: z.array(z.string()),
  activeExecutions: z.number().int(),
  unfinishedExecutions: z.number().int(),
})
export type OwnedResourceInventory = z.infer<typeof OwnedResourceInventory>

export const SystemDiagnostics = z.object({
  version: z.string(),
  checkedAt: z.string(),
  /** `ready` = all required checks ready; `degraded` = optional gaps only; `blocked` = a required check unmet. */
  overall: z.enum(['ready', 'degraded', 'blocked']),
  checks: z.array(SystemCheck),
  tools: z.array(ToolVersionStatus),
  resources: OwnedResourceInventory,
})
export type SystemDiagnostics = z.infer<typeof SystemDiagnostics>
