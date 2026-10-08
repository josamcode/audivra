import { createFileRoute, redirect } from '@tanstack/react-router'

/** The report preview became the Client view; old links keep working. */
export const Route = createFileRoute('/audits/$auditId_/report')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/audits/$auditId/client', params: { auditId: params.auditId }, replace: true })
  },
})
