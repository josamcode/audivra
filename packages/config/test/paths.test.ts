import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditWorkspaceDir, resolveInside, toWorkspaceRelative } from '../src/paths.ts'

const root = path.resolve('/data/audits/abc123def0')

describe('resolveInside', () => {
  it('resolves normal relative paths inside the root', () => {
    expect(resolveInside(root, 'screenshots/home.png')).toBe(path.join(root, 'screenshots', 'home.png'))
    expect(resolveInside(root, 'screenshots\\home.png')).toBe(path.join(root, 'screenshots', 'home.png'))
  })

  it('rejects traversal, absolute paths and empty input', () => {
    expect(resolveInside(root, '../other/secret.txt')).toBeNull()
    expect(resolveInside(root, 'screenshots/../../x')).toBeNull()
    expect(resolveInside(root, '/etc/passwd')).toBeNull()
    expect(resolveInside(root, 'C:/Windows/win.ini')).toBeNull()
    expect(resolveInside(root, '')).toBeNull()
    expect(resolveInside(root, '.')).toBeNull()
    expect(resolveInside(root, 'a\0b')).toBeNull()
  })
})

describe('toWorkspaceRelative', () => {
  it('converts inside paths and rejects outside ones', () => {
    expect(toWorkspaceRelative(root, path.join(root, 'tools', 'a.json'))).toBe('tools/a.json')
    expect(toWorkspaceRelative(root, path.resolve(root, '..', 'x'))).toBeNull()
  })
})

describe('auditWorkspaceDir', () => {
  it('only accepts safe audit ids', () => {
    expect(() => auditWorkspaceDir('../../etc')).toThrow()
    expect(() => auditWorkspaceDir('ABC')).toThrow()
    expect(auditWorkspaceDir('abc123def0')).toMatch(/abc123def0$/)
  })
})
