import { getSystemStatus } from '@audivra/tool-runtime'

const status = await getSystemStatus({ refresh: true })
const pad = (s: string, n: number) => s.padEnd(n)
console.log(`\nAudivra tool registry (${status.checkedAt})\n`)
for (const tool of status.tools) {
  console.log(
    `  ${pad(tool.name, 30)} ${pad(tool.state.toUpperCase(), 10)} ${pad(tool.version ?? '', 12)} ${tool.detail ?? ''}`,
  )
}
console.log()
