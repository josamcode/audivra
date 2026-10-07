import type { AuditDetail, ExportItem, ExportKind } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Download, FileArchive, FileText, Sheet as SheetIcon, Braces, FileType } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Menu, MenuGroup, MenuItem, MenuSeparator } from '@/components/ui/menu'
import { exportUrl } from '@/lib/api'
import { downloadFile } from '@/lib/download'
import { exportsQuery, isFinished } from '@/lib/queries'

const DEFAULT_LABEL: Record<ExportKind, string> = {
  pdf: 'Client report (PDF)',
  html: 'Client report (HTML)',
  json: 'Audit data (JSON)',
  'csv-findings': 'Findings (CSV)',
  'csv-pages': 'Pages (CSV)',
  'csv-performance': 'Performance (CSV)',
  'csv-broken-links': 'Broken links (CSV)',
  bundle: 'Complete audit bundle (ZIP)',
}

const ICON: Record<ExportKind, ReactNode> = {
  pdf: <FileText />,
  html: <FileType />,
  json: <Braces />,
  'csv-findings': <SheetIcon />,
  'csv-pages': <SheetIcon />,
  'csv-performance': <SheetIcon />,
  'csv-broken-links': <SheetIcon />,
  bundle: <FileArchive />,
}

const GROUPS: { label: string; kinds: ExportKind[] }[] = [
  { label: 'Client report', kinds: ['pdf', 'html'] },
  { label: 'Data', kinds: ['json', 'csv-findings', 'csv-pages', 'csv-performance', 'csv-broken-links'] },
  { label: 'Everything', kinds: ['bundle'] },
]

/** Starts an export download with progress feedback (exports are generated on demand). */
export function startExport(auditId: string, kind: ExportKind, item?: ExportItem) {
  const label = item?.label ?? DEFAULT_LABEL[kind]
  void downloadFile(exportUrl(auditId, kind), item?.filename ?? `${auditId}-${kind}`, label)
}

/** Export menu for finished audits: report (PDF/HTML), data (JSON/CSV) and the full ZIP bundle. */
export function ExportMenu({
  audit,
  label = 'Export',
  include,
}: {
  audit: AuditDetail
  label?: string
  /** Restrict to these kinds (e.g. the report toolbar shows its own PDF/HTML buttons). */
  include?: ExportKind[]
}) {
  const finished = isFinished(audit.status)
  const exports = useQuery({ ...exportsQuery(audit.id), enabled: finished })
  const byKind = new Map((exports.data ?? []).map((item) => [item.kind, item]))
  const groups = GROUPS.map((group) => ({
    ...group,
    kinds: group.kinds.filter((kind) => !include || include.includes(kind)),
  })).filter((group) => group.kinds.length)

  if (!finished) return null
  return (
    <Menu
      trigger={
        <Button size="sm" aria-label={label}>
          <Download />
          <span className="hidden sm:inline">{label}</span>
          <ChevronDown className="text-subtle" />
        </Button>
      }
    >
      {groups.map((group, index) => (
        <div key={group.label}>
          {index > 0 ? <MenuSeparator /> : null}
          <MenuGroup label={group.label}>
            {group.kinds.map((kind) => {
              const item = byKind.get(kind)
              const unavailable = item ? !item.available : false
              return (
                <MenuItem
                  key={kind}
                  icon={ICON[kind]}
                  disabled={unavailable}
                  label={item?.label ?? DEFAULT_LABEL[kind]}
                  hint={unavailable ? (item?.reason ?? 'Not available') : item?.filename}
                  onClick={() => startExport(audit.id, kind, item)}
                >
                  {item?.label ?? DEFAULT_LABEL[kind]}
                </MenuItem>
              )
            })}
          </MenuGroup>
        </div>
      ))}
    </Menu>
  )
}
