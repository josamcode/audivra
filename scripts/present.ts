/**
 * Regenerates the deterministic (no-AI) visual artifacts for an audit from persisted data.
 * Usage: pnpm present <auditId>
 * The full AI presentation (Artifact Planner + Report Composer) runs in the worker's presenting
 * stage or via POST /api/audits/:id/present.
 */
import { closeDb, getDb } from '@audivra/database'
import { generateSystemArtifacts } from '@audivra/insights'

const auditId = process.argv[2]
if (!auditId) {
  console.error('Usage: pnpm present <auditId>')
  process.exit(1)
}
const { artifacts, issues } = await generateSystemArtifacts(getDb().db, auditId)
console.log(`Stored ${artifacts.length} artifact(s): ${artifacts.map((a) => `${a.ref} ${a.type}`).join(', ')}`)
for (const issue of issues) console.log(`  - ${issue}`)
await closeDb()
