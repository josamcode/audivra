import { z } from 'zod'

/**
 * ready: installed and verified · needs-setup: usable after a one-time step (e.g. Docker image pull)
 * unavailable: not installed / prerequisite missing · disabled: present but off by policy · error: probe failed
 */
export const TOOL_STATES = ['ready', 'needs-setup', 'unavailable', 'disabled', 'error'] as const
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

/** A process Audivra started and owns (visible under System → Processes). */
export const OwnedProcessItem = z.object({
  id: z.string(),
  pid: z.number(),
  tool: z.string(),
  auditId: z.string().nullable(),
  status: z.enum(['running', 'exited', 'killed', 'reaped', 'gone']),
  command: z.string(),
  containerName: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
})
export type OwnedProcessItem = z.infer<typeof OwnedProcessItem>
