import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ActivityEvent } from '@audivra/contracts'
import { streamUrl } from './api'
import { queryKeys } from './queries'

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting'

type InvalidationTarget = 'audit' | 'findings' | 'evidence' | 'runs' | 'pages' | 'list' | 'visuals'

/** Which cached resources an incoming event makes stale. */
function targetsFor(event: ActivityEvent): InvalidationTarget[] {
  const type = event.type
  if (type === 'evidence.created') return ['evidence', 'audit']
  if (type === 'finding.created') return ['findings', 'audit']
  if (type === 'artifact.created') return ['visuals', 'audit']
  if (type === 'report.ready') return ['visuals', 'audit']
  if (type.startsWith('tool.')) return ['runs']
  if (
    type.startsWith('agent.started') ||
    type.startsWith('agent.completed') ||
    type.startsWith('agent.failed')
  )
    return ['runs', 'audit']
  if (type.startsWith('stage.')) {
    const stage = event.data?.stage
    return stage === 'presenting' ? ['audit', 'runs', 'visuals'] : ['audit', 'pages', 'runs']
  }
  if (type.startsWith('baseline.') || type.startsWith('review.')) return ['audit', 'pages', 'runs']
  if (type.startsWith('audit.')) return ['audit', 'findings', 'evidence', 'runs', 'pages', 'list', 'visuals']
  return []
}

/**
 * Subscribes to an audit's live activity stream (SSE) while the audit is in flight.
 * Events are appended to the cached activity list; dependent queries are invalidated in
 * debounced batches so a burst of events causes a single refetch.
 */
export function useAuditStream(auditId: string, enabled: boolean, ready: boolean): StreamState {
  const queryClient = useQueryClient()
  // Only updated from EventSource callbacks; the public state is derived below.
  const [connection, setConnection] = useState<'pending' | 'live' | 'reconnecting'>('pending')
  const pending = useRef(new Set<InvalidationTarget>())
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!enabled || !ready) return
    const cached = queryClient.getQueryData<ActivityEvent[]>(queryKeys.events(auditId)) ?? []
    const lastId = cached.reduce((max, event) => Math.max(max, event.id), 0)
    const source = new EventSource(streamUrl(auditId, lastId))

    const flush = () => {
      timer.current = undefined
      const targets = pending.current
      pending.current = new Set()
      if (targets.has('audit'))
        void queryClient.invalidateQueries({ queryKey: queryKeys.audit(auditId), exact: true })
      if (targets.has('findings'))
        void queryClient.invalidateQueries({ queryKey: queryKeys.findings(auditId) })
      if (targets.has('evidence'))
        void queryClient.invalidateQueries({ queryKey: queryKeys.evidence(auditId), exact: true })
      if (targets.has('pages')) void queryClient.invalidateQueries({ queryKey: queryKeys.pages(auditId) })
      if (targets.has('runs')) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.toolRuns(auditId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns(auditId) })
      }
      if (targets.has('list')) void queryClient.invalidateQueries({ queryKey: queryKeys.audits })
      if (targets.has('visuals')) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.visuals(auditId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.report(auditId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.exports(auditId) })
      }
    }

    source.onopen = () => setConnection('live')
    source.onerror = () => setConnection('reconnecting')
    source.addEventListener('activity', (message) => {
      let event: ActivityEvent
      try {
        event = JSON.parse((message as MessageEvent<string>).data) as ActivityEvent
      } catch {
        return
      }
      queryClient.setQueryData<ActivityEvent[]>(queryKeys.events(auditId), (previous = []) =>
        previous.some((existing) => existing.id === event.id) ? previous : [...previous, event],
      )
      for (const target of targetsFor(event)) pending.current.add(target)
      if (pending.current.size && timer.current === undefined) timer.current = window.setTimeout(flush, 600)
    })

    return () => {
      source.close()
      setConnection('pending')
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current)
        flush()
      }
    }
  }, [auditId, enabled, ready, queryClient])

  if (!enabled || !ready) return 'idle'
  return connection === 'pending' ? 'connecting' : connection
}
