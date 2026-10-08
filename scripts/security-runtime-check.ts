/**
 * Exercises the durable execution runtime on one security engagement without touching its target: it
 * submits the harmless `diagnostic.runtime-check` capability through the capability broker — the same
 * decision path every platform caller uses — and, with --wait, follows the execution until it is final.
 * The worker (`pnpm dev`) picks the execution up from the queue.
 *
 * Usage: pnpm security:runtime-check <engagementId> [--hold <seconds>] [--note <text>] [--wait]
 */
import { parseArgs } from 'node:util'
import { getConfig } from '@audivra/config'
import { isTerminalExecutionStatus } from '@audivra/contracts'
import { closeDb, createBoss, getDb } from '@audivra/database'
import { createDurableBroker, ExecutionService, LOCAL_USER, SecurityService, submitRuntimeCheck } from '@audivra/security'

const USAGE = 'Usage: pnpm security:runtime-check <engagementId> [--hold <seconds>] [--note <text>] [--wait]'
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { hold: { type: 'string', default: '3' }, note: { type: 'string' }, wait: { type: 'boolean', default: false } },
})
const engagementId = positionals[0]
const holdSeconds = Number(values.hold)
if (!engagementId || !Number.isInteger(holdSeconds) || holdSeconds < 0) {
  console.error(USAGE)
  process.exit(1)
}

const { db } = getDb()
const boss = createBoss(getConfig().DATABASE_URL)
try {
  const engagement = await new SecurityService({ db }).getEngagement(engagementId)
  await boss.start()
  const outcome = await submitRuntimeCheck(createDurableBroker({ db, boss }), { engagementId, targetUrl: engagement.targetUrl, holdSeconds, note: values.note, actor: LOCAL_USER })
  if (outcome.status !== 'queued') {
    console.error(`Not queued (${outcome.status}): ${outcome.error ?? outcome.decision.reason} [${outcome.decision.rule}]`)
    process.exitCode = 1
  } else {
    console.log(`Execution ${outcome.executionId} queued for ${engagement.name} (${outcome.decision.rule}).`)
    if (values.wait) {
      const executions = new ExecutionService({ db })
      const deadline = Date.now() + (holdSeconds + 300) * 1000
      let last = ''
      for (;;) {
        const detail = await executions.get(outcome.executionId)
        if (detail.status !== last) console.log(`  ${new Date().toLocaleTimeString()}  ${(last = detail.status)}`)
        if (isTerminalExecutionStatus(detail.status)) {
          if (detail.failure) console.log(`  ${detail.failure.kind}: ${detail.failure.message}`)
          else if (detail.result?.summary) console.log(`  ${detail.result.summary}`)
          if (detail.status !== 'succeeded') process.exitCode = 1
          break
        }
        if (Date.now() > deadline) {
          console.error('  Still not final — is the worker running? (pnpm dev)')
          process.exitCode = 1
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await boss.stop({ graceful: false }).catch(() => undefined)
  await closeDb()
}
