import type { Artifact } from '@audivra/contracts'
import { ArtifactView, SVG_EXPORTABLE_TYPES } from '@audivra/report-ui'
import { useNavigate } from '@tanstack/react-router'
import { Download, FileImage, FileCode2 } from 'lucide-react'
import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem } from '@/components/ui/menu'
import { useAuditNav } from '@/features/audit/audit-nav'
import { artifactUrl, visualFileUrl } from '@/lib/api'
import { downloadFile } from '@/lib/download'

/** PNG / SVG export of a single visual, rendered server-side by the same components. */
export function ArtifactExportMenu({ auditId, artifact }: { auditId: string; artifact: Artifact }) {
  const vector = SVG_EXPORTABLE_TYPES.has(artifact.type)
  return (
    <Menu
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`Export ${artifact.ref}`} title="Export visual">
          <Download />
        </Button>
      }
    >
      <MenuItem
        icon={<FileImage />}
        hint={`${artifact.ref}.png · high resolution`}
        onClick={() =>
          void downloadFile(visualFileUrl(auditId, artifact.ref, 'png', true), `${artifact.ref}.png`, `${artifact.ref}.png`)
        }
      >
        PNG image
      </MenuItem>
      <MenuItem
        icon={<FileCode2 />}
        disabled={!vector}
        hint={vector ? `${artifact.ref}.svg · scalable` : 'Not available for this visual type'}
        onClick={() =>
          void downloadFile(visualFileUrl(auditId, artifact.ref, 'svg', true), `${artifact.ref}.svg`, `${artifact.ref}.svg`)
        }
      >
        SVG vector
      </MenuItem>
    </Menu>
  )
}

/**
 * A visual artifact inside the app: trusted renderer from @audivra/report-ui, themed by the app
 * tokens, with evidence/finding references wired to the audit view and optional export controls.
 */
export function AppArtifact({
  artifact,
  auditId,
  exportable = true,
  bare,
  className,
}: {
  artifact: Artifact
  /** The audit being viewed (assets without an explicit audit belong to it). */
  auditId: string
  exportable?: boolean
  bare?: boolean
  className?: string
}) {
  const nav = useAuditNav()
  const navigate = useNavigate()
  const resolveAsset = useCallback(
    (path: string, otherAuditId?: string) => artifactUrl(otherAuditId ?? auditId, path),
    [auditId],
  )
  const onEvidenceClick = useCallback(
    (ref: string) => {
      if (nav) nav.openEvidence(ref)
      else void navigate({ to: '/audits/$auditId', params: { auditId }, search: { tab: 'evidence', ev: ref } })
    },
    [nav, navigate, auditId],
  )
  const onFindingClick = useCallback(
    (ref: string) => {
      if (nav) nav.openFinding(ref)
      else void navigate({ to: '/audits/$auditId', params: { auditId }, search: { finding: ref } })
    },
    [nav, navigate, auditId],
  )
  return (
    <ArtifactView
      artifact={artifact}
      resolveAsset={resolveAsset}
      mode="app"
      onEvidenceClick={onEvidenceClick}
      onFindingClick={onFindingClick}
      bare={bare}
      className={className}
      actions={exportable ? <ArtifactExportMenu auditId={auditId} artifact={artifact} /> : undefined}
    />
  )
}
