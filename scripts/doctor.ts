import { getConfig, getLogger } from '@audivra/config'
import { canConnect, getDb } from '@audivra/database'
import { collectDiagnostics } from '@audivra/security'

/*
 * Phase 6F — `pnpm doctor`: deterministic environment diagnostics for the security platform. Read-only — it
 * never installs, pulls, prunes or mutates anything. Prints each requirement with its state, consequence and
 * remediation, then the owned-resource inventory and tool versions. Exits non-zero only when a REQUIRED check
 * is blocked.
 */

const log = getLogger()
const config = getConfig()

const reachable = await canConnect(config.DATABASE_URL)
if (!reachable.ok) {
  console.log(`\nAudivra doctor\n\n  ✗ PostgreSQL unreachable at ${new URL(config.DATABASE_URL).host} (${reachable.error})`)
  console.log('    → Start PostgreSQL (or `docker compose up -d db`) and run `pnpm run setup`.\n')
  process.exit(1)
}

const { db } = getDb()
const report = await collectDiagnostics({ db })

const icon = (s: string) => (s === 'ready' ? '✓' : s === 'optional' ? '○' : s === 'unavailable' || s === 'misconfigured' ? '✗' : '!')
console.log(`\nAudivra doctor — v${report.version} — overall: ${report.overall.toUpperCase()}\n`)
for (const c of report.checks) {
  console.log(`  ${icon(c.state)} ${c.label.padEnd(26)} ${c.state.toUpperCase().padEnd(12)} ${c.detail}`)
  if (c.state !== 'ready' && c.state !== 'optional') {
    if (c.consequence) console.log(`      consequence: ${c.consequence}`)
    if (c.remediation) console.log(`      fix: ${c.remediation}`)
  }
}
if (report.tools.length) {
  console.log('\n  Tools (installed vs approved):')
  for (const t of report.tools) console.log(`    ${icon(t.state)} ${t.name.padEnd(20)} ${t.match ? 'match' : t.state}`)
}
const r = report.resources
console.log(`\n  Owned resources: ${Math.round(r.storageBytes / 1_048_576)} MB storage, ${r.ownedProcesses} process(es), ${r.ownedContainers.length} container(s), ${r.ownedNetworks.length} network(s); ${r.activeExecutions} active / ${r.unfinishedExecutions} unfinished execution(s).`)
console.log(`  Data dir: ${r.dataDir}\n`)

log.debug({ overall: report.overall }, 'doctor complete')
process.exit(report.overall === 'blocked' ? 1 : 0)
