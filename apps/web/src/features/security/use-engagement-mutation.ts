import type { SecurityEngagementDetail } from '@audivra/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { queryKeys } from '@/lib/queries'

/**
 * Mutation that returns the updated engagement: stores it, refreshes the list and the audit trail, and
 * reports errors as toasts (server messages explain policy and validation refusals).
 */
export function useEngagementMutation<V>(
  engagementId: string,
  mutationFn: (variables: V) => Promise<SecurityEngagementDetail>,
  messages: { success?: string | ((engagement: SecurityEngagementDetail) => string); error: string },
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (engagement) => {
      queryClient.setQueryData(queryKeys.engagement(engagementId), engagement)
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagements })
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementEvents(engagementId) })
      const success = typeof messages.success === 'function' ? messages.success(engagement) : messages.success
      if (success) toast.success(success)
    },
    onError: (error) => toast.error(messages.error, { description: error instanceof Error ? error.message : String(error) }),
  })
}
