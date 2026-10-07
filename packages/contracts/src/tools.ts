import { z } from 'zod'

export const TOOL_STATES = ['ready', 'available', 'missing', 'disabled', 'error'] as const
export const ToolState = z.enum(TOOL_STATES)
export type ToolState = z.infer<typeof ToolState>

export const ToolStatus = z.object({
  id: z.string(),
  name: z.string(),
  group: z.string(),
  state: ToolState,
  version: z.string().nullable(),
  /** How the tool is provided: npm (project-local), binary, docker, wsl, system. */
  via: z.string().nullable(),
  detail: z.string().nullable(),
  /** Shell command the AI auditor can use to invoke it, when applicable. */
  command: z.string().nullable(),
  optional: z.boolean(),
})
export type ToolStatus = z.infer<typeof ToolStatus>

export const SystemStatus = z.object({
  checkedAt: z.string(),
  tools: z.array(ToolStatus),
})
export type SystemStatus = z.infer<typeof SystemStatus>
