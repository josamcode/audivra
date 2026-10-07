/** @jsxRuntime automatic @jsxImportSource react */
import type { Datum, ValueUnit } from '@audivra/contracts'
import { clsx } from 'clsx'
import { formatDatum, formatValue, type Tone } from '../format.ts'
import { CSS_PALETTE, segmentColor } from '../theme.ts'

function toneOf(datum: Datum): Tone {
  return datum.tone ?? 'neutral'
}

function widthPercent(value: number, max: number): number {
  if (!(max > 0)) return 0
  return Math.max(0, Math.min(100, (Math.abs(value) / max) * 100))
}

/**
 * Horizontal bars as HTML/CSS: responsive, selectable text, prints cleanly. Values are labelled
 * directly; tone comes from the (resolved) datum, never from decoration.
 */
export function BarList({
  items,
  unit,
  lowerIsBetter,
}: {
  items: Datum[]
  unit: ValueUnit
  lowerIsBetter?: boolean
}) {
  const max = Math.max(0, ...items.map((item) => Math.abs(item.value)))
  return (
    <div className="av-bars">
      <ul className="av-bar-list">
        {items.map((item, index) => {
          const tone = toneOf(item)
          return (
            <li className="av-bar-row" key={`${item.label}-${index}`}>
              <span className="av-bar-label" dir="auto" title={item.label}>
                {item.label}
              </span>
              <span className="av-bar-track" aria-hidden>
                <span
                  className={clsx('av-bar-fill', `av-fill-${tone}`)}
                  style={{ width: `${widthPercent(item.value, max)}%` }}
                />
              </span>
              <span className={clsx('av-bar-value av-num', `av-tone-${tone}`)}>
                {formatDatum({ value: item.value, unit: item.unit ?? unit })}
              </span>
              {item.note ? (
                <span className="av-bar-note" dir="auto">
                  {item.note}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {lowerIsBetter ? <p className="av-axis-note">Lower is better</p> : null}
    </div>
  )
}

/** Vertical columns for short categorical series (≤ 8 items); longer series fall back to BarList. */
export function ColumnChart({ items, unit, lowerIsBetter }: { items: Datum[]; unit: ValueUnit; lowerIsBetter?: boolean }) {
  if (items.length > 8) return <BarList items={items} unit={unit} lowerIsBetter={lowerIsBetter} />
  const max = Math.max(0, ...items.map((item) => Math.abs(item.value)))
  return (
    <div className="av-columns-wrap">
      <div className="av-columns" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item, index) => {
          const tone = toneOf(item)
          return (
            <div className="av-column" key={`${item.label}-${index}`}>
              <span className={clsx('av-column-value av-num', `av-tone-${tone}`)}>
                {formatDatum({ value: item.value, unit: item.unit ?? unit })}
              </span>
              <span className="av-column-track" aria-hidden>
                <span
                  className={clsx('av-column-fill', `av-fill-${tone}`)}
                  style={{ height: `${Math.max(widthPercent(item.value, max), item.value === 0 ? 0 : 2)}%` }}
                />
              </span>
              <span className="av-column-label" dir="auto" title={item.label}>
                {item.label}
              </span>
            </div>
          )
        })}
      </div>
      {lowerIsBetter ? <p className="av-axis-note">Lower is better</p> : null}
    </div>
  )
}

/** Horizontal stacked bars; rows share one scale (the largest row total). */
export function StackedBars({ segments, rows }: { segments: string[]; rows: { label: string; values: Datum[] }[] }) {
  const totals = rows.map((row) => row.values.reduce((sum, v) => sum + Math.max(0, v.value), 0))
  const max = Math.max(0, ...totals)
  const unit = rows[0]?.values[0]?.unit ?? 'none'
  return (
    <div className="av-stacked">
      <ul className="av-legend" aria-label="Legend">
        {segments.map((segment, index) => (
          <li key={segment}>
            <span className="av-swatch" style={{ background: segmentColor(CSS_PALETTE, segment, index) }} aria-hidden />
            {segment}
          </li>
        ))}
      </ul>
      <ul className="av-bar-list">
        {rows.map((row, rowIndex) => (
          <li className="av-bar-row" key={`${row.label}-${rowIndex}`}>
            <span className="av-bar-label" dir="auto" title={row.label}>
              {row.label}
            </span>
            <span className="av-bar-track av-stack-track">
              {row.values.map((value, index) =>
                value.value > 0 ? (
                  <span
                    key={index}
                    className="av-stack-seg"
                    style={{
                      width: `${widthPercent(value.value, max)}%`,
                      background: segmentColor(CSS_PALETTE, segments[index] ?? '', index),
                    }}
                    title={`${segments[index]}: ${formatDatum(value)}`}
                  />
                ) : null,
              )}
            </span>
            <span className="av-bar-value av-num">{formatValue(totals[rowIndex] ?? 0, unit)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Heatmap as a table: cell intensity encodes value relative to the largest cell, text shows it. */
export function HeatmapTable({
  columns,
  rows,
  unit,
}: {
  columns: string[]
  rows: { label: string; values: (Datum | null)[] }[]
  unit: ValueUnit
}) {
  const max = Math.max(0, ...rows.flatMap((row) => row.values.map((v) => (v ? Math.abs(v.value) : 0))))
  return (
    <div className="av-table-wrap">
      <table className="av-table av-table-compact av-heatmap">
        <thead>
          <tr>
            <th scope="col" />
            {columns.map((column) => (
              <th key={column} scope="col" dir="auto">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row.label}-${rowIndex}`}>
              <th scope="row" dir="auto">
                {row.label}
              </th>
              {row.values.map((value, index) => {
                const intensity = value && max > 0 ? Math.round((Math.abs(value.value) / max) * 100) : 0
                return (
                  <td
                    key={index}
                    className="av-heat-cell av-num"
                    style={
                      value
                        ? { background: `color-mix(in oklab, var(--av-accent) ${Math.round(intensity * 0.55)}%, transparent)` }
                        : undefined
                    }
                  >
                    {value ? formatValue(value.value, value.unit ?? unit) : '–'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
