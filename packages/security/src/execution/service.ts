import { existsSync } from 'node:fs'
import path from 'node:path'
import { engagementWorkspaceDir, resolveInside } from '@audivra/config'
import type { SecurityActor, SecurityEventItem, SecurityEvidenceItem, SecurityExecutionDetail, SecurityExecutionItem } from '@audivra/contracts'
import {
  findExecutionArtifactEvidence,
  getEngagementRow,
  listSecurityEvents,
  listSecurityEvidence,
  toSecurityExecutionDetail,
  toSecurityExecutionItem,
  type Db,
} from '@audivra/database'
import { LOCAL_USER, SecurityRequestError } from '../service.ts'
import { createDbSecurityStore } from '../store.ts'
import { requestExecutionCancel } from './control.ts'
import { createDbExecutionStore, type ExecutionRecord, type ExecutionStore } from './store.ts'

const EXECUTION_ID = /^sx_[0-9a-z]{14}$/

/**
 * What the API may do with executions: inspect them and request cancellation. Creating an execution is
 * not here — executions come into being only through the capability broker.
 */
export class ExecutionService {
  readonly #db: Db
  readonly #executions: ExecutionStore
  readonly #now: () => Date

  constructor(options: { db: Db; now?: () => Date }) {
    this.#db = options.db
    this.#executions = createDbExecutionStore(options.db)
    this.#now = options.now ?? (() => new Date())
  }

  async list(engagementId: string): Promise<SecurityExecutionItem[]> {
    const engagement = /^[0-9a-z]{6,32}$/.test(engagementId) ? await getEngagementRow(this.#db, engagementId) : undefined
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    const now = this.#now()
    return (await this.#executions.listForEngagement(engagementId)).map((row) => toSecurityExecutionItem(row, now))
  }

  async get(id: string): Promise<SecurityExecutionDetail> {
    return toSecurityExecutionDetail(await this.#row(id), this.#now())
  }

  /** The execution's own entries in the append-only security events (decision, lifecycle, cleanup). */
  async events(id: string): Promise<SecurityEventItem[]> {
    const row = await this.#row(id)
    return listSecurityEvents(this.#db, row.engagementId, { executionId: id })
  }

  async evidence(id: string): Promise<SecurityEvidenceItem[]> {
    const row = await this.#row(id)
    return listSecurityEvidence(this.#db, row.engagementId, id)
  }

  async cancel(id: string, actor: SecurityActor = LOCAL_USER): Promise<SecurityExecutionDetail> {
    await this.#row(id)
    const { execution } = await requestExecutionCancel({ store: createDbSecurityStore(this.#db), executions: this.#executions }, id, actor)
    return toSecurityExecutionDetail(execution, this.#now())
  }

  /**
   * A file the execution registered as evidence, resolved inside its workspace. Only registered
   * artifacts are served — never arbitrary files of the workspace.
   */
  async artifact(id: string, relative: string): Promise<{ file: string; root: string; name: string }> {
    const row = await this.#row(id)
    const normalized = relative.replace(/\\/g, '/')
    const prefix = `executions/${id}/`
    const engagementRelative = normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`
    if (!(await findExecutionArtifactEvidence(this.#db, id, engagementRelative))) throw new SecurityRequestError(404, 'Artifact not found')
    const root = engagementWorkspaceDir(row.engagementId)
    const file = resolveInside(path.join(root, 'executions', id), engagementRelative.slice(prefix.length))
    if (!file || !existsSync(file)) throw new SecurityRequestError(404, 'Artifact not found')
    return { file, root, name: path.basename(file) }
  }

  async #row(id: string): Promise<ExecutionRecord> {
    const row = EXECUTION_ID.test(id) ? await this.#executions.get(id) : null
    if (!row) throw new SecurityRequestError(404, 'Execution not found')
    return row
  }
}
