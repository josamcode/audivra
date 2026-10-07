import type { Artifact } from '@audivra/contracts'
import type { ReactNode } from 'react'

/**
 * Maps a workspace-relative file path (e.g. "screenshots/home-mobile.png") to a URL the renderer can
 * load: an API URL in the app, a data: URI in standalone HTML, a file:// URL for PDF.
 * `auditId` is passed for assets that belong to another audit of the same site (before/after pairs);
 * when omitted the asset belongs to the audit being rendered.
 */
export type AssetResolver = (workspacePath: string, auditId?: string) => string

export type RenderMode = 'app' | 'report'

export interface ArtifactViewProps {
  artifact: Artifact
  resolveAsset: AssetResolver
  /** 'app': interactive, themed by the host app's tokens. 'report': print-friendly light theme. */
  mode?: RenderMode
  onEvidenceClick?: (ref: string) => void
  onFindingClick?: (ref: string) => void
  /** Hide title/question header (when the host already shows them). */
  bare?: boolean
  /** Host-provided controls shown at the end of the title row (app mode only, e.g. export links). */
  actions?: ReactNode
  className?: string
}

/** Shared rendering context passed to individual artifact renderers. */
export interface RenderContext {
  mode: RenderMode
  resolveAsset: AssetResolver
  onEvidenceClick?: (ref: string) => void
  onFindingClick?: (ref: string) => void
}
