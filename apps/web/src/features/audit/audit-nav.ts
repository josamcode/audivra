import { createContext, useContext } from 'react'

export const AUDIT_TABS = [
  'overview',
  'findings',
  'journeys',
  'visuals',
  'evidence',
  'pages',
  'history',
  'activity',
  'runs',
] as const
export type AuditTab = (typeof AUDIT_TABS)[number]

/** In-page navigation for the audit view, so nested components can open findings/evidence/tabs. */
export interface AuditNav {
  auditId: string
  openFinding: (ref: string) => void
  openEvidence: (ref: string) => void
  openTab: (tab: AuditTab) => void
  /** Opens the Findings tab filtered to findings that affect one page. */
  showPageFindings: (url: string) => void
  /** Opens the evidence graph centred on a node, e.g. "finding:F3" or "journey:J1". */
  openGraph: (focus: string) => void
  openJourney: (ref: string) => void
}

export const AuditNavContext = createContext<AuditNav | null>(null)

export function useAuditNav(): AuditNav | null {
  return useContext(AuditNavContext)
}
