import path from 'node:path'
import type { AgentActivity } from '../provider.ts'

type Input = Record<string, unknown>

const str = (value: unknown, max = 160) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

function displayPath(file: unknown, cwd: string): string {
  if (typeof file !== 'string') return ''
  const rel = path.relative(cwd, file)
  return (!rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file).split(path.sep).join('/')
}

/** Tools whose calls are already represented by their own events, or are internal bookkeeping. */
const SILENT = new Set([
  'mcp__audit__record_evidence',
  'mcp__audit__log_activity',
  'TodoWrite',
  'StructuredOutput',
])

/**
 * Turns a tool call into a short activity line for the Activity timeline.
 * Only the action is described — never the model's reasoning.
 */
export function describeToolUse(name: string, input: Input, cwd: string): AgentActivity | null {
  if (SILENT.has(name)) return null
  if (name.startsWith('mcp__browser__')) {
    const action = name.slice('mcp__browser__'.length).replace(/^browser_/, '')
    const detail =
      action === 'navigate'
        ? str(input.url, 200)
        : action === 'resize'
          ? `${input.width}×${input.height}`
          : action === 'click' || action === 'hover' || action === 'type' || action === 'select_option'
            ? `“${str(input.element, 80)}”`
            : action === 'take_screenshot'
              ? str(input.filename) || (input.fullPage ? 'full page' : 'viewport')
              : action === 'tabs'
                ? str(input.action)
                : ''
    const labels: Record<string, string> = {
      navigate: 'Opened',
      navigate_back: 'Went back',
      snapshot: 'Read page structure',
      take_screenshot: 'Took screenshot',
      resize: 'Resized viewport to',
      click: 'Clicked',
      hover: 'Hovered',
      type: 'Typed into',
      press_key: 'Pressed key',
      select_option: 'Selected option in',
      evaluate: 'Evaluated script in page',
      console_messages: 'Read console messages',
      network_requests: 'Read network requests',
      wait_for: 'Waited for page',
      tabs: 'Managed tabs',
      fill_form: 'Filled form fields (not submitted)',
      close: 'Closed browser',
    }
    return {
      kind: 'browser',
      tool: name,
      message: `Browser: ${labels[action] ?? action.replace(/_/g, ' ')}${detail ? ` ${detail}` : ''}`,
    }
  }
  if (name.startsWith('mcp__audit__')) {
    const action = name.slice('mcp__audit__'.length)
    if (action === 'get_evidence')
      return { kind: 'evidence', tool: name, message: `Reviewed evidence ${str(input.ref)}` }
    if (action === 'list_evidence')
      return { kind: 'evidence', tool: name, message: 'Reviewed the evidence index' }
    return { kind: 'evidence', tool: name, message: action.replace(/_/g, ' ') }
  }
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const description = str(input.description, 140)
      // Drop a leading `cd <dir> &&` / `cd <dir>;` — the agent always works in its workspace.
      const command = str(
        typeof input.command === 'string'
          ? input.command.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '')
          : '',
        180,
      )
      return {
        kind: 'terminal',
        tool: name,
        message: `Terminal: ${description || command}${description && command ? ` — \`${command}\`` : ''}`,
      }
    }
    case 'Write': {
      const file = displayPath(input.file_path, cwd)
      const isScript = /^scripts\//.test(file) || /\.(m?js|ts|py|sh)$/.test(file)
      return { kind: 'file', tool: name, message: `${isScript ? 'Created script' : 'Wrote'} ${file}` }
    }
    case 'Edit':
      return { kind: 'file', tool: name, message: `Edited ${displayPath(input.file_path, cwd)}` }
    case 'Read':
      return { kind: 'file', tool: name, message: `Read ${displayPath(input.file_path, cwd)}` }
    case 'Glob':
    case 'Grep':
      return { kind: 'search', tool: name, message: `Searched workspace for ${str(input.pattern, 80)}` }
    case 'WebFetch':
      return { kind: 'browser', tool: name, message: `Fetched ${str(input.url, 200)}` }
    case 'WebSearch':
      return { kind: 'search', tool: name, message: `Web search: ${str(input.query, 120)}` }
    default:
      return { kind: 'other', tool: name, message: name }
  }
}
