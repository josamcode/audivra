/**
 * A real, separate worker process that consumes the security execution queue — used by the integration
 * test to crash a worker mid-execution (it is killed by its exact PID) and prove restart reconciliation.
 * Runs against the integration-test database and data directory inherited from the test process.
 */
process.env.AUDIVRA_SERVICE ??= 'worker-test-child'

import { getLogger } from '@audivra/config'
import { createBoss, ensureQueues, getDb, processStore } from '@audivra/database'
import { setProcessStore } from '@audivra/tool-runtime'
import { createSecurityExecutionWorker } from '../src/security-executions.ts'

if (!process.env.DATABASE_URL?.includes('test')) throw new Error('The child worker only runs against the test database')

const { db } = getDb()
setProcessStore({
  insert: (record) => processStore.insert(db, record),
  finish: (id, status, exitCode) => processStore.finish(db, id, status, exitCode),
  listStale: (ownerId) => processStore.listStale(db, ownerId),
})
const boss = createBoss(process.env.DATABASE_URL)
await boss.start()
await ensureQueues(boss)
const worker = createSecurityExecutionWorker({ db, boss, log: getLogger(), runtime: { pollIntervalMs: 200, maxActive: 4 } })
await worker.start()
process.stdout.write(`ready ${process.pid}\n`)
