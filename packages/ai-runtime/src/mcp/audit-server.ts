/**
 * "audit" MCP server, launched by the Claude CLI for each agent run (stdio transport).
 * It gives the agent first-class evidence recording and concise activity notes — infrastructure only;
 * it contains no audit logic. stdout is the MCP protocol channel, so nothing else may write to it.
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { EVIDENCE_TYPES, type EvidenceSource } from '@audivra/contracts'
import { resolveInside, toWorkspaceRelative } from '@audivra/config'
import { createDb, createEvidence, getEvidence, listEvidence, recordEvent } from '@audivra/database'

const auditId = required('AUDIT_ID')
const workspace = required('AUDIT_WORKSPACE')
const agentRunId = process.env.AGENT_RUN_ID || null
const role = process.env.AGENT_ROLE ?? 'auditor'
const source: EvidenceSource = role === 'reviewer' ? 'reviewer' : 'auditor'
const { db } = createDb(required('DATABASE_URL'), 2)

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    process.stderr.write(`audit MCP server: missing ${name}\n`)
    process.exit(1)
  }
  return value
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const fail = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true })

/** Accepts workspace-relative or absolute paths inside the workspace; rejects everything else. */
function normalizeArtifact(
  input: string | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!input) return { ok: true, value: null }
  const candidate = path.isAbsolute(input)
    ? toWorkspaceRelative(workspace, input)
    : input.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!candidate)
    return { ok: false, error: `artifactPath must be inside the audit workspace (${workspace})` }
  const abs = resolveInside(workspace, candidate)
  if (!abs) return { ok: false, error: 'artifactPath escapes the audit workspace' }
  if (!existsSync(abs) || !statSync(abs).isFile())
    return { ok: false, error: `artifactPath does not exist: ${candidate}` }
  return { ok: true, value: candidate }
}

const server = new McpServer({ name: 'audit', version: '1.0.0' })

server.registerTool(
  'record_evidence',
  {
    description:
      'Record a piece of evidence for this audit and get its ID (e.g. "EV-31"). Use it for anything a finding relies on: ' +
      'screenshots you saved, measurements, console/network observations, DOM observations, tool output, script results. ' +
      'Save files inside the workspace first and pass artifactPath (workspace-relative). Findings may only cite recorded evidence IDs.',
    inputSchema: {
      type: z.enum(EVIDENCE_TYPES).describe('Evidence type.'),
      title: z
        .string()
        .min(3)
        .max(200)
        .describe('Specific, factual title, e.g. "Mobile: booking CTA below the fold on /services".'),
      summary: z
        .string()
        .min(3)
        .max(3000)
        .describe('What exactly was observed or measured, with concrete values. No speculation.'),
      url: z.string().optional().describe('Page or resource URL this evidence is about.'),
      artifactPath: z
        .string()
        .optional()
        .describe('Workspace-relative path of a saved file (screenshot, JSON, log, script output).'),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Small structured data (numbers, selectors, headers). Keep it compact.'),
    },
  },
  async (args) => {
    const artifact = normalizeArtifact(args.artifactPath)
    if (!artifact.ok) return fail(artifact.error)
    const metadata = args.metadata ?? {}
    if (JSON.stringify(metadata).length > 60_000)
      return fail('metadata too large: save large data to a file and pass artifactPath instead')
    const item = await createEvidence(db, {
      auditId,
      source,
      type: args.type,
      title: args.title,
      summary: args.summary,
      url: args.url ?? null,
      artifactPath: artifact.value,
      metadata,
      agentRunId,
    })
    await recordEvent(db, {
      auditId,
      type: 'evidence.created',
      message: `${item.ref} · ${item.title}`,
      data: { ref: item.ref, type: item.type, role },
      agentRunId,
    })
    return text(`Recorded ${item.ref}`)
  },
)

server.registerTool(
  'list_evidence',
  {
    description:
      'List evidence recorded so far for this audit (baseline and agent evidence), optionally filtered.',
    inputSchema: {
      type: z.enum(EVIDENCE_TYPES).optional(),
      query: z.string().optional().describe('Case-insensitive text filter on title/summary/url.'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async (args) => {
    const items = await listEvidence(db, auditId)
    const q = args.query?.toLowerCase()
    const filtered = items
      .filter((e) => !args.type || e.type === args.type)
      .filter((e) => !q || `${e.title} ${e.summary} ${e.url ?? ''}`.toLowerCase().includes(q))
      .slice(0, args.limit ?? 200)
    const lines = filtered.map(
      (e) =>
        `${e.ref} [${e.type}] (${e.source}) ${e.title}${e.url ? ` — ${e.url}` : ''}${e.artifactPath ? ` — file: ${e.artifactPath}` : ''}`,
    )
    return text(lines.length ? lines.join('\n') : 'No evidence matches.')
  },
)

server.registerTool(
  'get_evidence',
  {
    description: 'Get one evidence item with its full summary and metadata.',
    inputSchema: { ref: z.string().describe('Evidence ID, e.g. "EV-12".') },
  },
  async ({ ref }) => {
    const item = await getEvidence(db, auditId, ref.trim())
    if (!item) return fail(`No evidence ${ref}`)
    const json = JSON.stringify(item, null, 2)
    return text(
      json.length > 40_000
        ? `${json.slice(0, 40_000)}\n…(truncated; read the artifact file for full data)`
        : json,
    )
  },
)

server.registerTool(
  'log_activity',
  {
    description:
      'Post a one-sentence, user-facing note about what you are doing or decided and why (shown in the audit Activity timeline). ' +
      'Example: "Site looks like lead-generation for a dental clinic; focusing on the WhatsApp booking journey on mobile." ' +
      'Use it at meaningful milestones (5–20 times per run), not for every step. Never include private reasoning.',
    inputSchema: { message: z.string().min(3).max(400) },
  },
  async ({ message }) => {
    await recordEvent(db, { auditId, type: 'agent.note', message, data: { role }, agentRunId })
    return text('Noted.')
  },
)

await server.connect(new StdioServerTransport())
