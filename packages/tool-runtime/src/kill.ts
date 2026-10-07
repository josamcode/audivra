import { execa } from 'execa'

/**
 * Kills a process and all of its descendants. On Windows a plain kill leaves children
 * (MCP servers, browsers, shells) running, so taskkill /T is used.
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false, windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already exited
    }
  }
}
