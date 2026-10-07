/** @jsxRuntime automatic @jsxImportSource react */
import type { ArtifactDataMap, Datum } from '@audivra/contracts'
import { clsx } from 'clsx'
import { formatDatum, shortUrl, thresholdTone } from '../format.ts'
import { CellMark, RefChip } from '../components/primitives.tsx'
import type { RenderContext } from '../types.ts'

function ValueCell({ datum, tone }: { datum: Datum | null | undefined; tone?: string }) {
  if (!datum) return <td className="av-num av-muted-cell">–</td>
  const resolvedTone = datum.tone ?? tone ?? 'neutral'
  return (
    <td className={clsx('av-num', `av-tone-${resolvedTone}`)} title={datum.note ?? undefined}>
      {formatDatum(datum)}
    </td>
  )
}

export function ComparisonTableView({ data }: { data: ArtifactDataMap['comparison_table'] }) {
  return (
    <div className="av-table-wrap">
      <table className="av-table av-table-compact">
        <thead>
          <tr>
            <th scope="col" />
            {data.columns.map((column) => (
              <th key={column} scope="col" className="av-num-head" dir="auto">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={`${row.label}-${index}`}>
              <th scope="row" dir="auto">
                {row.label}
              </th>
              {row.values.map((value, i) => (
                <ValueCell key={i} datum={value} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const PERF_COLUMN_LABEL: Record<string, string> = {
  performance: 'Performance',
  lcp: 'LCP',
  fcp: 'FCP',
  cls: 'CLS',
  tbt: 'TBT',
  accessibility: 'Accessibility',
  seo: 'SEO',
  bestPractices: 'Best practices',
  weight: 'Weight',
  requests: 'Requests',
}

export function PagePerformanceView({ data }: { data: ArtifactDataMap['page_performance'] }) {
  return (
    <div className="av-table-wrap">
      <table className="av-table">
        <thead>
          <tr>
            <th scope="col">Page</th>
            {data.columns.map((column) => (
              <th key={column} scope="col" className="av-num-head">
                {PERF_COLUMN_LABEL[column] ?? column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={`${row.url}-${index}`}>
              <th scope="row" className="av-url-cell" title={row.url}>
                {row.label ? <span dir="auto">{row.label}</span> : null}
                <span className={clsx('av-mono', row.label && 'av-sub')}>{shortUrl(row.url, 48)}</span>
              </th>
              {data.columns.map((column) => {
                const datum = row.values[column] ?? null
                return (
                  <ValueCell
                    key={column}
                    datum={datum}
                    tone={datum ? thresholdTone(column, datum.value, datum.unit) : undefined}
                  />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="av-axis-note">
        {data.formFactor === 'mobile' ? 'Mobile' : 'Desktop'} lab measurements. Thresholds: score ≥ 90 good, ≥ 50 needs work;
        LCP ≤ 2.5 s; CLS ≤ 0.1; TBT ≤ 200 ms.
      </p>
    </div>
  )
}

const TRACKING_KIND_LABEL: Record<string, string> = {
  analytics: 'Analytics',
  'tag-manager': 'Tag manager',
  advertising: 'Advertising',
  'session-recording': 'Session recording',
  'conversion-channel': 'Conversion channel',
  other: 'Other',
}

export function TrackingCoverageView({ data, ctx }: { data: ArtifactDataMap['tracking_coverage']; ctx: RenderContext }) {
  return (
    <div className="av-table-wrap">
      <table className="av-table">
        <thead>
          <tr>
            <th scope="col">Tool / channel</th>
            <th scope="col">Type</th>
            <th scope="col" className="av-center">
              Present
            </th>
            <th scope="col" className="av-center">
              Conversion event
            </th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={`${row.name}-${index}`}>
              <th scope="row" dir="auto">
                {row.name}
              </th>
              <td className="av-muted-text">{TRACKING_KIND_LABEL[row.kind] ?? row.kind}</td>
              <td className="av-center">
                <CellMark status={row.present} />
              </td>
              <td className="av-center">
                <CellMark status={row.eventObserved} />
              </td>
              <td className="av-note-cell" dir="auto">
                {row.note ?? ''}
                {row.evidenceId ? (
                  <>
                    {row.note ? ' ' : null}
                    <RefChip value={row.evidenceId} kind="evidence" ctx={ctx} />
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="av-axis-note">A tool being present does not mean conversions are measured.</p>
    </div>
  )
}

export function MatrixView({ data, ctx }: { data: ArtifactDataMap['matrix']; ctx: RenderContext }) {
  return (
    <div className="av-table-wrap">
      <table className="av-table av-matrix">
        <thead>
          <tr>
            <th scope="col" />
            {data.columns.map((column) => (
              <th key={column} scope="col" className="av-center" dir="auto">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={`${row.label}-${index}`}>
              <th scope="row" dir="auto">
                {row.label}
              </th>
              {row.cells.map((cell, i) => (
                <td key={i} className="av-center" title={cell.note ?? undefined}>
                  <CellMark status={cell.status} note={cell.note} />
                  {cell.evidenceId && ctx.mode === 'app' ? (
                    <span className="av-cell-ref">
                      <RefChip value={cell.evidenceId} kind="evidence" ctx={ctx} />
                    </span>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
