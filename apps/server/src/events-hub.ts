import pg from 'pg'
import type { Logger } from '@audivra/config'
import type { ActivityEvent } from '@audivra/contracts'
import { EVENTS_CHANNEL, listEvents, type Db } from '@audivra/database'

type Listener = (event: ActivityEvent) => void

/**
 * Relays activity events written by the worker (via pg_notify) to SSE subscribers.
 * Notifications only carry IDs; events are read back from the database so nothing is lost
 * and payload size limits never apply.
 */
export class EventHub {
  private client: pg.Client | undefined
  private readonly listeners = new Map<string, Set<{ listener: Listener; lastId: number }>>()
  private readonly pending = new Map<string, Promise<void>>()
  private stopped = false

  constructor(
    private readonly url: string,
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.url })
    client.on('error', (error) => {
      this.log.warn({ err: error }, 'event listener connection error; reconnecting')
      this.client = undefined
      if (!this.stopped) setTimeout(() => void this.connect().catch(() => undefined), 2000)
    })
    client.on('notification', (message) => {
      if (!message.payload) return
      try {
        const { auditId } = JSON.parse(message.payload) as { auditId: string }
        this.flush(auditId)
      } catch {
        // ignore malformed payloads
      }
    })
    await client.connect()
    await client.query(`LISTEN ${EVENTS_CHANNEL}`)
    this.client = client
  }

  /** Subscribes to an audit's events after `lastId`. Returns an unsubscribe function. */
  subscribe(auditId: string, lastId: number, listener: Listener): () => void {
    const set = this.listeners.get(auditId) ?? new Set()
    const entry = { listener, lastId }
    set.add(entry)
    this.listeners.set(auditId, set)
    this.flush(auditId)
    return () => {
      set.delete(entry)
      if (set.size === 0) this.listeners.delete(auditId)
    }
  }

  private flush(auditId: string): void {
    if (!this.listeners.has(auditId)) return
    // Serialize flushes per audit so events are delivered in order exactly once.
    const previous = this.pending.get(auditId) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const subscribers = this.listeners.get(auditId)
        if (!subscribers?.size) return
        const minId = Math.min(...[...subscribers].map((s) => s.lastId))
        const events = await listEvents(this.db, auditId, { afterId: minId, limit: 1000 })
        for (const subscriber of subscribers) {
          for (const event of events) {
            if (event.id > subscriber.lastId) {
              subscriber.lastId = event.id
              subscriber.listener(event)
            }
          }
        }
      })
      .catch((error: unknown) => this.log.warn({ err: error, auditId }, 'failed to relay events'))
      .finally(() => {
        if (this.pending.get(auditId) === next) this.pending.delete(auditId)
      })
    this.pending.set(auditId, next)
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.client?.end().catch(() => undefined)
  }
}
