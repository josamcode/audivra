/** @jsxRuntime automatic @jsxImportSource react */
import type { CellStatus, Severity } from '@audivra/contracts'
import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import type { Tone } from '../format.ts'
import type { RenderContext } from '../types.ts'

const CELL: Record<CellStatus, { mark: string; label: string; className: string }> = {
  yes: { mark: '✓', label: 'Yes', className: 'av-cell-yes' },
  no: { mark: '✕', label: 'No', className: 'av-cell-no' },
  partial: { mark: '◐', label: 'Partial', className: 'av-cell-partial' },
  unknown: { mark: '?', label: 'Unknown', className: 'av-cell-unknown' },
  na: { mark: '–', label: 'Not applicable', className: 'av-cell-na' },
}

/** Status mark for matrix-like cells; the text label is always available to assistive tech. */
export function CellMark({ status, note }: { status: CellStatus; note?: string }) {
  const cell = CELL[status]
  return (
    <span className={clsx('av-cell-mark', cell.className)} title={note ? `${cell.label}: ${note}` : cell.label}>
      <span aria-hidden>{cell.mark}</span>
      <span className="av-sr">{cell.label}</span>
    </span>
  )
}

export function cellStatusLabel(status: CellStatus): string {
  return CELL[status].label
}

export function ToneText({ tone, children, mono = true }: { tone: Tone; children: ReactNode; mono?: boolean }) {
  return <span className={clsx(`av-tone-${tone}`, mono && 'av-num')}>{children}</span>
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
}

export function SeverityPill({ severity }: { severity: Severity }) {
  return (
    <span className={clsx('av-pill', `av-sev-${severity}`)}>
      <span className="av-dot" aria-hidden />
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

export function severityLabel(severity: Severity): string {
  return SEVERITY_LABEL[severity]
}

/** Evidence/finding reference: a button in the app, plain text in reports. */
export function RefChip({
  value,
  kind,
  ctx,
}: {
  value: string
  kind: 'evidence' | 'finding'
  ctx: RenderContext
}) {
  const handler = kind === 'evidence' ? ctx.onEvidenceClick : ctx.onFindingClick
  if (ctx.mode === 'app' && handler) {
    return (
      <button
        type="button"
        className="av-ref-chip"
        onClick={() => handler(value)}
        title={kind === 'evidence' ? `Open evidence ${value}` : `Open finding ${value}`}
      >
        {value}
      </button>
    )
  }
  return <span className="av-ref-chip av-ref-static">{value}</span>
}

export function RefChips({ refs, kind, ctx }: { refs: string[]; kind: 'evidence' | 'finding'; ctx: RenderContext }) {
  if (!refs.length) return null
  return (
    <span className="av-ref-list">
      {refs.map((ref) => (
        <RefChip key={ref} value={ref} kind={kind} ctx={ctx} />
      ))}
    </span>
  )
}

/** Visually hidden data table for screen readers (chart text alternative). */
export function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="av-sr">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
