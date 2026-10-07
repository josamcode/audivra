import { z } from 'zod'

export const EXPORT_KINDS = [
  'pdf',
  'html',
  'json',
  'csv-findings',
  'csv-pages',
  'csv-performance',
  'csv-broken-links',
  'bundle',
] as const
export const ExportKind = z.enum(EXPORT_KINDS)
export type ExportKind = z.infer<typeof ExportKind>

/** An export the API can produce for an audit (generated on demand from persisted data). */
export const ExportItem = z.object({
  kind: ExportKind,
  label: z.string(),
  filename: z.string(),
  url: z.string(),
  available: z.boolean(),
  /** Why the export is unavailable (e.g. "No broken links were found"). */
  reason: z.string().nullable(),
  /** When the cached file was last generated, if any. */
  generatedAt: z.string().nullable(),
})
export type ExportItem = z.infer<typeof ExportItem>

export const AUDIT_EXPORT_SCHEMA_VERSION = 'audivra.audit.v1'
