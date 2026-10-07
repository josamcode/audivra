import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/queries'

/** Queues the presenting stage (artifact planner + report composer) for a finished audit. */
export function usePresentMutation(auditId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.present(auditId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit(auditId), exact: true })
      toast('Visual report queued', { description: 'Built from the stored findings and evidence.' })
    },
    onError: (error) => toast.error('Could not start visual report', { description: error.message }),
  })
}
