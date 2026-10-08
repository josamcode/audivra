import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PROMPTS_DIR } from '@audivra/config'

export type PromptName =
  | 'auditor-system'
  | 'reviewer-system'
  | 'finalizer-system'
  | 'planner-system'
  | 'composer-system'
  | 'journey-analyst-system'
  | 'change-analyst-system'
  | 'client-brief-system'

export interface PromptFile {
  name: PromptName
  path: string
  /** e.g. "auditor:v1" — taken from the `<!-- version: ... -->` header and stored on each AgentRun. */
  version: string
  text: string
}

/** Prompts are versioned product assets living in /prompts (never inline TypeScript strings). */
export function loadPrompt(name: PromptName): PromptFile {
  const file = path.join(PROMPTS_DIR, `${name}.md`)
  const text = readFileSync(file, 'utf8')
  const match = text.match(/<!--\s*version:\s*([\w:.-]+)\s*-->/)
  return { name, path: file, version: match?.[1] ?? `${name}:unversioned`, text }
}

const ALL_PROMPTS: PromptName[] = [
  'auditor-system',
  'reviewer-system',
  'finalizer-system',
  'planner-system',
  'composer-system',
  'journey-analyst-system',
  'change-analyst-system',
  'client-brief-system',
]

/** Current version of every role prompt, e.g. { auditor: 'auditor:v5', … } (stored with benchmark runs). */
export function promptVersions(): Record<string, string> {
  return Object.fromEntries(ALL_PROMPTS.map((name) => [name.replace('-system', ''), loadPrompt(name).version]))
}
