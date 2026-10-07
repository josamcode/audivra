import { createContext, useContext, useState } from 'react'
import { tagVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { artifactUrl } from '@/lib/api'
import { formatNumber, humanizeKey } from '@/lib/format'
import { cn } from '@/lib/utils'

const MAX_ROWS = 8
const MAX_COLUMNS = 6
const MAX_SCALARS = 24
/** Workspace-relative artifact paths such as "tools/lighthouse/home.report.html". */
const ARTIFACT_PATH =
  /^(?!https?:)[\w.-]+(\/[\w.-]+)+\.(png|jpe?g|webp|gif|svg|json|html?|txt|log|md|mjs|js|csv|xml|har|zip)$/i

/** Lets nested values link workspace artifact paths to the audit they belong to. */
export const ArtifactAuditContext = createContext<string | null>(null)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function ScalarValue({ value }: { value: unknown }) {
  const auditId = useContext(ArtifactAuditContext)
  const [expanded, setExpanded] = useState(false)
  if (value === null || value === undefined) return <span className="text-subtle">—</span>
  if (typeof value === 'boolean') return <span className="font-mono text-xs">{value ? 'true' : 'false'}</span>
  if (typeof value === 'number')
    return <span className="font-mono text-xs tabular-nums">{formatNumber(value)}</span>
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs text-link hover:underline text-break"
        >
          {value}
        </a>
      )
    }
    if (auditId && ARTIFACT_PATH.test(value)) {
      return (
        <a
          href={artifactUrl(auditId, value)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs text-link hover:underline text-break"
        >
          {value}
        </a>
      )
    }
    if (value.length > 160 && !expanded) {
      return (
        <span className="text-break">
          {value.slice(0, 160)}…{' '}
          <button
            type="button"
            className="cursor-pointer text-xs text-link hover:underline"
            onClick={() => setExpanded(true)}
          >
            more
          </button>
        </span>
      )
    }
    return <span className="text-break whitespace-pre-wrap">{value}</span>
  }
  if (Array.isArray(value) && value.every(isScalar)) {
    const text = value.map(String).join(', ')
    return <span className="text-xs text-break">{text.length > 200 ? `${text.slice(0, 200)}…` : text}</span>
  }
  const text = JSON.stringify(value)
  return (
    <code className="font-mono text-xs text-muted text-break">
      {text.length > 200 ? `${text.slice(0, 200)}…` : text}
    </code>
  )
}

function ObjectTable({ rows, keyColumn }: { rows: Record<string, unknown>[]; keyColumn?: string }) {
  const [showAll, setShowAll] = useState(false)
  const columns: string[] = keyColumn ? [keyColumn] : []
  for (const row of rows.slice(0, 20)) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key) && columns.length < MAX_COLUMNS) columns.push(key)
    }
  }
  const visible = showAll ? rows : rows.slice(0, MAX_ROWS)
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-muted">
            {columns.map((column) => (
              <th key={column} className="h-7 px-2.5 text-left font-medium whitespace-nowrap text-muted">
                {humanizeKey(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={index} className="border-b border-border align-top last:border-b-0">
              {columns.map((column) => (
                <td key={column} className="max-w-md px-2.5 py-1.5">
                  <ScalarValue value={row[column]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS ? (
        <div className="border-t border-border px-2.5 py-1">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${formatNumber(rows.length)}`}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ScalarList({ values }: { values: unknown[] }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? values : values.slice(0, 12)
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((value, index) => (
        <span key={index} className={tagVariants({ kind: 'code' })}>
          {String(value)}
        </span>
      ))}
      {values.length > 12 ? (
        <button
          type="button"
          className="cursor-pointer px-1 text-2xs text-link hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'fewer' : `+${values.length - 12} more`}
        </button>
      ) : null}
    </div>
  )
}

/** Flattens one level of nesting so `{ scores: { seo: 90 } }` reads as rows. */
function flatten(metadata: Record<string, unknown>): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const [key, value] of Object.entries(metadata)) {
    if (isPlainObject(value) && Object.values(value).every(isScalar) && Object.keys(value).length <= 16) {
      for (const [inner, innerValue] of Object.entries(value)) out.push([`${key}.${inner}`, innerValue])
    } else {
      out.push([key, value])
    }
  }
  return out
}

/** `{ script: { count, bytes }, image: { count, bytes } }` → table rows keyed by the outer key. */
function isRecordOfRecords(value: unknown): value is Record<string, Record<string, unknown>> {
  return (
    isPlainObject(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((inner) => isPlainObject(inner) && Object.values(inner).every(isScalar))
  )
}

function ComplexValue({ name, value }: { name: string; value: unknown }) {
  const label = (
    <div className="mb-1 flex items-baseline gap-2 text-xs font-medium text-muted">
      {humanizeKey(name)}
      {Array.isArray(value) ? <span className="font-mono text-2xs text-subtle">{value.length}</span> : null}
    </div>
  )
  let body
  if (Array.isArray(value)) {
    if (value.length === 0) body = <p className="text-xs text-subtle">None</p>
    else if (value.every(isPlainObject)) body = <ObjectTable rows={value} />
    else if (value.every(isScalar)) body = <ScalarList values={value} />
    else body = <ScalarValue value={value} />
  } else if (isRecordOfRecords(value)) {
    body = (
      <ObjectTable keyColumn="key" rows={Object.entries(value).map(([key, inner]) => ({ key, ...inner }))} />
    )
  } else if (isPlainObject(value)) {
    body = <MetadataView metadata={value} />
  } else {
    body = <ScalarValue value={value} />
  }
  return (
    <div>
      {label}
      {body}
    </div>
  )
}

/**
 * Generic, readable rendering of evidence metadata of any shape: scalars as key/value rows,
 * arrays of objects as compact tables, nested records as tables — never a raw JSON dump.
 */
export function MetadataView({
  metadata,
  className,
}: {
  metadata: Record<string, unknown>
  className?: string
}) {
  const [showAllScalars, setShowAllScalars] = useState(false)
  const entries = flatten(metadata)
  const scalars = entries.filter(([, value]) => isScalar(value))
  const complex = entries.filter(([, value]) => !isScalar(value))
  if (entries.length === 0) return null
  const visibleScalars = showAllScalars ? scalars : scalars.slice(0, MAX_SCALARS)

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {scalars.length ? (
        <dl className="divide-y divide-border rounded-md border border-border">
          {visibleScalars.map(([key, value]) => {
            const [group, field] = key.includes('.')
              ? [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
              : [null, key]
            return (
              <div key={key} className="grid grid-cols-[minmax(7rem,12rem)_1fr] gap-3 px-2.5 py-1.5 text-sm">
                <dt className="truncate text-xs text-muted" title={key}>
                  {humanizeKey(field)}
                  {group ? <span className="text-subtle"> · {humanizeKey(group)}</span> : null}
                </dt>
                <dd className="min-w-0 text-sm text-foreground">
                  <ScalarValue value={value} />
                </dd>
              </div>
            )
          })}
          {scalars.length > MAX_SCALARS ? (
            <div className="px-2.5 py-1">
              <Button variant="ghost" size="sm" onClick={() => setShowAllScalars((v) => !v)}>
                {showAllScalars ? 'Show fewer' : `Show all ${scalars.length} fields`}
              </Button>
            </div>
          ) : null}
        </dl>
      ) : null}
      {complex.map(([key, value]) => (
        <ComplexValue key={key} name={key} value={value} />
      ))}
    </div>
  )
}
