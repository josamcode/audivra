import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeToolUse } from '../src/claude/activity.ts'
import { loadPrompt } from '../src/prompts.ts'

const cwd = path.resolve('/tmp/audit')

describe('describeToolUse', () => {
  it('describes browser actions concisely', () => {
    expect(
      describeToolUse('mcp__browser__browser_navigate', { url: 'https://example.com/a' }, cwd),
    ).toMatchObject({
      kind: 'browser',
      message: 'Browser: Opened https://example.com/a',
    })
    expect(describeToolUse('mcp__browser__browser_resize', { width: 390, height: 844 }, cwd)?.message).toBe(
      'Browser: Resized viewport to 390×844',
    )
  })

  it('prefers the command description for terminal activity', () => {
    const activity = describeToolUse(
      'Bash',
      { command: 'lighthouse https://x --preset=desktop', description: 'Run desktop Lighthouse' },
      cwd,
    )
    expect(activity?.kind).toBe('terminal')
    expect(activity?.message).toContain('Run desktop Lighthouse')
  })

  it('drops the redundant leading cd into the workspace', () => {
    const activity = describeToolUse('Bash', { command: 'cd "D:/data/audits/x"; node scripts/a.mjs' }, cwd)
    expect(activity?.message).toBe('Terminal: node scripts/a.mjs')
  })

  it('labels investigative scripts and shows workspace-relative paths', () => {
    const activity = describeToolUse(
      'Write',
      { file_path: path.join(cwd, 'scripts', 'check-hreflang.mjs') },
      cwd,
    )
    expect(activity?.message).toBe('Created script scripts/check-hreflang.mjs')
  })

  it('stays silent for calls already represented by their own events', () => {
    expect(describeToolUse('mcp__audit__record_evidence', {}, cwd)).toBeNull()
    expect(describeToolUse('mcp__audit__log_activity', {}, cwd)).toBeNull()
    expect(describeToolUse('TodoWrite', {}, cwd)).toBeNull()
  })
})

describe('prompts', () => {
  it('loads versioned prompt files', () => {
    for (const name of ['auditor-system', 'reviewer-system', 'finalizer-system'] as const) {
      const prompt = loadPrompt(name)
      expect(prompt.version).toMatch(/^(auditor|reviewer|finalizer):v\d+$/)
      expect(prompt.text.length).toBeGreaterThan(500)
    }
  })
})
