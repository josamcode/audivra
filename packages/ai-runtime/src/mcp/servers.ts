import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getConfig } from '@audivra/config'
import { chromiumExecutable, packageDir } from '@audivra/tool-runtime'
import type { AgentRole } from '@audivra/contracts'
import type { McpServerSpec } from '../provider.ts'

const AUDIT_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-server.ts')

/** Official Playwright MCP server: a real, isolated, headless browser the agent can drive freely. */
export function browserMcpServer(workspaceRoot: string): McpServerSpec {
  const dir = packageDir('@playwright/mcp')
  if (!dir) throw new Error('@playwright/mcp is not installed')
  const chromium = chromiumExecutable()
  return {
    command: process.execPath,
    args: [
      path.join(dir, 'cli.js'),
      '--headless',
      '--isolated',
      '--output-dir',
      path.join(workspaceRoot, 'browser'),
      '--viewport-size',
      '1440x900',
      '--console-level',
      'warning',
      '--timeout-navigation',
      '45000',
      '--block-service-workers',
      ...(chromium ? ['--executable-path', chromium] : []),
    ],
  }
}

/** Audivra's evidence MCP server (record/list/get evidence, activity notes). */
export function auditMcpServer(input: {
  auditId: string
  workspaceRoot: string
  agentRunId: string
  role: AgentRole
}): McpServerSpec {
  const tsx = packageDir('tsx')
  if (!tsx) throw new Error('tsx is not installed')
  return {
    command: process.execPath,
    args: ['--import', pathToFileURL(path.join(tsx, 'dist', 'loader.mjs')).href, AUDIT_SERVER],
    env: {
      AUDIT_ID: input.auditId,
      AUDIT_WORKSPACE: input.workspaceRoot,
      AGENT_RUN_ID: input.agentRunId,
      AGENT_ROLE: input.role,
      DATABASE_URL: getConfig().DATABASE_URL,
      LOG_LEVEL: 'silent',
    },
  }
}
