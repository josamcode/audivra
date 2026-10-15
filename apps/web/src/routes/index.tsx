import { createFileRoute } from '@tanstack/react-router'
import { LandingPage } from '@/features/landing/landing-page'

export const Route = createFileRoute('/')({
  // Not code-split: the landing page is the usual first paint, so it ships with the entry chunk instead of
  // waiting for a second request after the router starts.
  codeSplitGroupings: [],
  staticData: { chrome: 'none' },
  component: LandingPage,
})
