import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/queries'

/** On-demand AI work over a finished audit (runs on the worker; progress shows in Runs). */
export type EnrichKind = 'journeys' | 'changes' | 'brief'

const COPY: Record<EnrichKind, { queued: string; description: string; error: string }> = {
  journeys: {
    queued: 'Journey analysis queued',
    description: 'Maps journeys from the evidence this audit recorded. The site is not browsed again.',
    error: 'Could not start journey analysis',
  },
  changes: {
    queued: 'Change intelligence queued',
    description: 'Explains the stored comparison with the previous audit.',
    error: 'Could not start change intelligence',
  },
  brief: {
    queued: 'Client brief queued',
    description: 'Written from the finalized findings, evidence and history.',
    error: 'Could not start the client brief',
  },
}

const ACTIONS: Record<EnrichKind, (auditId: string) => Promise<unknown>> = {
  journeys: api.analyzeJourneys,
  changes: api.analyzeChanges,
  brief: api.generateBrief,
}

const KEYS: Record<EnrichKind, (auditId: string) => readonly unknown[]> = {
  journeys: queryKeys.journeys,
  changes: queryKeys.changes,
  brief: queryKeys.brief,
}

export function useEnrichMutation(auditId: string, kind: EnrichKind) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => ACTIONS[kind](auditId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEYS[kind](auditId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns(auditId) })
      toast(COPY[kind].queued, { description: COPY[kind].description })
    },
    onError: (error) => toast.error(COPY[kind].error, { description: error.message }),
  })
}

/**
 * When an on-demand job finishes, refreshes what it changed elsewhere: journey analysis links
 * findings to journeys (findings, graph, report); change intelligence feeds the report.
 */
export function useRefreshAfterEnrich(auditId: string, kind: EnrichKind, running: boolean | undefined) {
  const queryClient = useQueryClient()
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && running === false) {
      const keys: (readonly unknown[])[] = [queryKeys.agentRuns(auditId), queryKeys.events(auditId), queryKeys.report(auditId)]
      if (kind === 'journeys') keys.push(queryKeys.findings(auditId), ['audit', auditId, 'graph'])
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key })
    }
    wasRunning.current = running
  }, [auditId, kind, running, queryClient])
}
